const PDFeSignController = {};
const fs = require("fs");
const path = require("path");
const sendMail = require("../services/sendmail.js");
const { SIGN_EVENTS, DIRECTORIES, ESIGN_PATHS, userId, STATICUSERID, IS_ACTIVE_ENUM } = require("../config/contance.js");
const Envelope = require("../model/eSignModel");
const jwt = require("jsonwebtoken");
const { addHeaderToPdf, getCurrentDayInNumber, base64ToPdfBuffer, toNum, normalizeIP, mergePdfBuffers, getCurrentMonth, getCurrentYear, triggerWebhookEvent, setEnvelopeData, getFirstRoutingOrder, sendRoutingGroupEmails, sendSigningMailToSigner, pdfBufferToBase64 } = require("../middleware/helper");
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');  // ← ADD THIS

const AwsFileUpload = require("../services/s3Upload"); // <-- change path as per your project
const signatureModel = require("../model/signatureModel.js");

const { JWT_SECRET, BASE_URL, SPACES_PUBLIC_URL, SIGNING_WEB_URL } = process.env;


const ESIGN_ORIGINALS_PATH = ESIGN_PATHS.ESIGN_ORIGINALS_PATH;
const ESIGN_PDF_PATH = ESIGN_PATHS.ESIGN_PDF_PATH;
const ESIGN_SIGNED_PATH = ESIGN_PATHS.ESIGN_SIGNED_PATH;

PDFeSignController.storePdf = async (req, res) => {
  try {
    const { base64, userData, isRoutingOrder } = req.body;

    // 1. Parse & validate templates
    let templates = Array.isArray(base64) ? base64 : JSON.parse(base64);
    if (!Array.isArray(templates) || !templates.length) {
      return res.status(400).json({ error: "base64 must be a non-empty array" });
    }

    templates = templates
      .map((t, i) => ({
        name: t?.name || `Document-${i + 1}`,
        documentBase64: String(t?.documentBase64 || "").replace(/^data:application\/pdf;base64,/i, "").trim(),
        fileId: String(t?.fileId || "").trim(),
      }))
      .filter(t => t.documentBase64);

    if (!templates.length) {
      return res.status(400).json({ error: "No valid PDFs found (documentBase64 required)" });
    }

    // 2. Parse & validate users
    let users = Array.isArray(userData) ? userData : JSON.parse(userData);
    if (!Array.isArray(users) || !users.length) {
      return res.status(400).json({ error: "userData must be a non-empty array" });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    users = users
      .map(u => ({
        name: String(u?.name || "").trim(),
        email: String(u?.email || "").trim(),
        tabs: Array.isArray(u?.tabs) ? u.tabs : [],
        isAction: u?.isAction || IS_ACTIVE_ENUM.NEED_TO_SIGN,
        routingOrder: Number(u?.routingOrder) || 0,
      }))
      .filter(u => u.email && emailRegex.test(u.email));

    if (!users.length) {
      return res.status(400).json({ error: "No valid users with correct email format" });
    }

    // 3. Process PDFs → buffers + upload originals
    const datePart = `${getCurrentDayInNumber()}-${getCurrentMonth()}-${getCurrentYear()}`;
    const nowMs = Date.now();

    const files = [];
    const pdfBuffers = [];
    const individualPdfDocs = [];

    for (let i = 0; i < templates.length; i++) {
      const { documentBase64, name, fileId } = templates[i];
      let pdfBuffer;
      try {
        pdfBuffer = Buffer.from(documentBase64, "base64");
        if (pdfBuffer.slice(0, 4).toString("utf8") !== "%PDF") continue;
      } catch {
        continue;
      }

      pdfBuffers.push(pdfBuffer);
      individualPdfDocs.push(await PDFDocument.load(pdfBuffer));

      const filename = `${datePart}_${nowMs}-pdf-${i + 1}.pdf`;

      await AwsFileUpload.uploadToSpaces({
        fileData: pdfBuffer,
        filename,
        filepath: ESIGN_PDF_PATH,
        mimetype: "application/pdf",
      });

      files.push({
        filename: name,
        storedName: filename,
        publicUrl: filename,
        mimetype: "application/pdf",
        html: documentBase64,           // will be replaced later
        templatePdf: filename,
        signedTemplatePdf: null,
        fileId: fileId || "",
      });
    }

    if (!files.length) {
      return res.status(400).json({ error: "No valid PDF files after validation" });
    }

    // 4. Merge PDFs (without header yet)
    const mergedPdf = await PDFDocument.create();
    for (const buf of pdfBuffers) {
      const pdf = await PDFDocument.load(buf);
      const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
      pages.forEach(p => mergedPdf.addPage(p));
    }
    const mergedPdfBytes = await mergedPdf.save();

    const mergedPdfFileName = `${datePart}_${Date.now()}-merged.pdf`;

    // 5. Create envelope → get _id for header
    const signers = users.map(u => ({
      email: u.email,
      name: u.name,
      status: SIGN_EVENTS.PENDING,
      sentAt: null,
      tokenUrl: "",
      metaData: u.tabs,
      isAction: u.isAction,
      routingOrder: u.routingOrder,
    }));

    let envelope = await Envelope.create({
      signers,
      files,
      documentStatus: SIGN_EVENTS.SENT,
      pdf: mergedPdfFileName,
      signedPdf: "",
      signedUrl: "",
      contentType: "application/pdf",
      isRoutingOrder: !!isRoutingOrder,
    });

    // 6. Add header to merged PDF + upload
    const finalMergedBytes = await addHeaderToPdf(mergedPdfBytes, envelope._id);

    await AwsFileUpload.uploadToSpaces({
      fileData: finalMergedBytes,
      filename: mergedPdfFileName,
      filepath: ESIGN_PDF_PATH,
      mimetype: "application/pdf",
    });

    envelope.pdf = mergedPdfFileName;
    if ("pdfUrl" in envelope) {
      envelope.pdfUrl = `${ESIGN_PDF_PATH}/${mergedPdfFileName}`; // adjust if upload result gives better URL
    }

    // 7. Add header to EACH individual PDF → update files[i].html
    for (let i = 0; i < individualPdfDocs.length; i++) {
      const bytes = await individualPdfDocs[i].save();
      const bytesWithHeader = await addHeaderToPdf(bytes, envelope._id);
      envelope.files[i].html = Buffer.from(bytesWithHeader).toString("base64");
    }

    // 8. Generate token URLs
    for (let i = 0; i < envelope.signers.length; i++) {
      const s = envelope.signers[i];
      const token = jwt.sign(
        { envId: String(envelope._id), email: s.email, i },
        JWT_SECRET
      );
      s.tokenUrl = `${SIGNING_WEB_URL}/pdf-documents?type=${token}`;
    }
    envelope.signedUrl = envelope.signers[0]?.tokenUrl || "";

    // 9. Determine who to email first (routing logic)
    const eligibleSigners = envelope.signers
      .map((s, idx) => ({ s, idx }))
      .filter(({ s }) => s.isAction === IS_ACTIVE_ENUM.NEED_TO_SIGN);

    let toEmailIndexes = [];

    if (envelope.isRoutingOrder) {
      const minOrder = eligibleSigners.length ? Math.min(...eligibleSigners.map(o => o.s.routingOrder)) : null;
      toEmailIndexes = eligibleSigners
        .filter(o => o.s.routingOrder === minOrder)
        .map(o => o.idx);
    } else {
      toEmailIndexes = eligibleSigners.map(o => o.idx);
    }

    const now = new Date();
    toEmailIndexes.forEach(i => {
      envelope.signers[i].status = SIGN_EVENTS.SENT;
      envelope.signers[i].sentAt = now;
    });

    // 10. Save updated envelope
    await envelope.save();

    // 11. Trigger webhook
    await triggerWebhookEvent(SIGN_EVENTS.SENT, STATICUSERID, {
      envelopeId: envelope._id,
      event: SIGN_EVENTS.SENT,
    });

    // 12. Send emails
    const templatePath = path.join(__dirname, "../public/template/sendDocument.html");
    const emailTemplate = fs.readFileSync(templatePath, "utf8");
    const docName = files[0]?.filename || "Document";

    await Promise.all(
      toEmailIndexes.map(async i => {
        const signer = envelope.signers[i];
        const html = emailTemplate
          .replace(/{{name}}/g, signer.name || "")
          .replace(/{{signUrl}}/g, signer.tokenUrl || "")
          .replace(/{{DocumentName}}/g, docName);

        await sendMail(signer.email, "Please sign the documents", html);
      })
    );

    // 13. Response
    return res.json({
      status: true,
      message: "Emails sent successfully",
      envelopeId: String(envelope._id),
      emailedSigners: toEmailIndexes.map(i => envelope.signers[i]?.email),
      routingEnabled: envelope.isRoutingOrder,
      skippedReceiveCopy: envelope.signers
        .filter(s => s.isAction !== IS_ACTIVE_ENUM.NEED_TO_SIGN)
        .map(s => s.email),
    });

  } catch (err) {
    console.error("Error in PDFeSignController.storePdf:", err);
    return res.status(500).json({ error: "Document processing failed" });
  }
};

// PDFeSignController.readPdfbyToken = async (req, res) => {
//   try {
//     let env = await Envelope.findById(req.envId);
//     if (!env) {
//       return res.status(404).json({ error: "Envelope not found" });
//     }

//     // find signer by index or email
//     let idx = typeof req.signerIndex === "number" ? req.signerIndex : env.signers.findIndex((s) => s.email === req.signerEmail);

//     if (idx < 0 || idx >= env.signers.length) {
//       return res.status(400).json({ error: "Signer not found in envelope" });
//     }

//     // mark DELIVERED if not already
//     if (env.signers[idx].status == SIGN_EVENTS.SENT) {
//       env.signers[idx].status = SIGN_EVENTS.DELIVERED;
//       env.signers[idx].deliveredAt = new Date();
//       // optional: if all signers delivered, bump envelope to DELIVERED
//       if (
//         env.signers.every((s) =>
//           [SIGN_EVENTS.DELIVERED, SIGN_EVENTS.COMPLETED].includes(s.status)
//         )
//       ) {
//         env.documentStatus = SIGN_EVENTS.DELIVERED;
//       }

//       await env.save();

//       const setEnv = { envelopeId: env._id, event: SIGN_EVENTS.DELIVERED };
//       await triggerWebhookEvent(SIGN_EVENTS.DELIVERED, STATICUSERID, setEnv);
//     }

//     const htmlTemplates = (env.files || [])
//       // .filter((f) => f.mimetype == "text/html")
//       .map((f) => ({
//         filename: f.filename,
//         url: `${SPACES_PUBLIC_URL}/storage/pdf/${f.publicUrl}`, // Spaces URL
//         mimetype: f.mimetype,
//         html: f.html || null,
//         fileId: f.fileId || null,
//       }));


//     const signature = await signatureModel.findOne({ email: req.signerEmail })
//     let signatureRawData = null;
//     if (signature) {
//       signatureRawData = signature?.signature;
//     }

//     return res.json({
//       status: true,
//       message: "PDF loaded successfully",
//       envelopeId: String(env._id),
//       documentStatus: env.documentStatus,
//       signer: {
//         index: idx,
//         email: env.signers[idx].email,
//         name: env.signers[idx].name,
//         status: env.signers[idx].status,
//         isAction: env.signers[idx].isAction,
//         sentAt: env.signers[idx].sentAt,
//         deliveredAt: env.signers[idx].deliveredAt,
//         completedAt: env.signers[idx].completedAt,
//         metaData: env.signers[idx].metaData || [],
//       },
//       files: env.files.map((f) => ({
//         filename: f.filename,
//         url: `${SPACES_PUBLIC_URL}/storage/pdf/${f.publicUrl}`,
//         mimetype: f.mimetype,
//       })),
//       htmlTemplates,
//       signatureRawData
//     });
//   } catch (err) {
//     console.error(err);
//     return res.status(500).json({ error: "Failed to load envelope" });
//   }
// };
PDFeSignController.readPdfbyToken = async (req, res) => {
  try {
    let env = await Envelope.findById(req.envId);
    if (!env) {
      return res.status(404).json({ error: "Envelope not found" });
    }

    let idx = typeof req.signerIndex === "number"
      ? req.signerIndex
      : env.signers.findIndex((s) => s.email === req.signerEmail);

    if (idx < 0 || idx >= env.signers.length) {
      return res.status(400).json({ error: "Signer not found in envelope" });
    }

    const currentSigner = env.signers[idx];
    let isModified = false;


    if (currentSigner.isAction !== IS_ACTIVE_ENUM.NEED_TO_SIGN) {
      if (currentSigner.status !== SIGN_EVENTS.COMPLETED) {
        env.signers[idx].status = SIGN_EVENTS.COMPLETED;
        env.signers[idx].completedAt = new Date();
        isModified = true;
      }
    }
    else if (currentSigner.status === SIGN_EVENTS.SENT) {
      env.signers[idx].status = SIGN_EVENTS.DELIVERED;
      env.signers[idx].deliveredAt = new Date();
      isModified = true;
    }

    const allRequiredCompleted = env.signers.every((s) => {
      if (s.isAction === IS_ACTIVE_ENUM.NEED_TO_SIGN || s.isAction === IS_ACTIVE_ENUM.NEED_TO_VIEW) {
        return s.status === SIGN_EVENTS.COMPLETED;
      }
      return true; // receive_copy blocks nothing
    });

    if (allRequiredCompleted) {
      env.documentStatus = SIGN_EVENTS.COMPLETED;
    } else {
      const allDelivered = env.signers.every((s) =>
        [SIGN_EVENTS.DELIVERED, SIGN_EVENTS.COMPLETED].includes(s.status)
      );
      if (allDelivered && env.documentStatus !== SIGN_EVENTS.COMPLETED) {
        env.documentStatus = SIGN_EVENTS.DELIVERED;
      }
    }


    if (isModified) {
      await env.save();

      const eventType = env.signers[idx].status === SIGN_EVENTS.COMPLETED ? SIGN_EVENTS.COMPLETED : SIGN_EVENTS.DELIVERED;
      const setEnv = { envelopeId: env._id, event: eventType };
      await triggerWebhookEvent(eventType, STATICUSERID, setEnv);
    }

    const htmlTemplates = (env.files || []).map((f) => ({
      filename: f.filename,
      url: `${SPACES_PUBLIC_URL}/storage/pdf/${f.publicUrl}`,
      mimetype: f.mimetype,
      html: f.html || null,
      fileId: f.fileId || null,
    }));

    const signature = await signatureModel.findOne({ email: req.signerEmail });
    let signatureRawData = signature ? signature.signature : null;

    return res.json({
      status: true,
      message: "PDF loaded successfully",
      envelopeId: String(env._id),
      documentStatus: env.documentStatus,
      signer: {
        index: idx,
        email: env.signers[idx].email,
        name: env.signers[idx].name,
        status: env.signers[idx].status,
        isAction: env.signers[idx].isAction,
        sentAt: env.signers[idx].sentAt,
        deliveredAt: env.signers[idx].deliveredAt,
        completedAt: env.signers[idx].completedAt,
        metaData: env.signers[idx].metaData || [],
      },
      files: env.files.map((f) => ({
        filename: f.filename,
        url: `${SPACES_PUBLIC_URL}/storage/pdf/${f.publicUrl}`,
        mimetype: f.mimetype,
      })),
      htmlTemplates,
      signatureRawData
    });
  } catch (err) {
    console.error("Error in readPdfbyToken:", err);
    return res.status(500).json({ error: "Failed to load envelope" });
  }
};

PDFeSignController.completePdf = async (req, res) => {
  try {
    const { template, location, signature } = req.body;

    const envelopeId = req.envId;
    const signerEmail = req.signerEmail;

    if (!envelopeId || !signerEmail) {
      return res.status(400).json({
        error: "Missing envelopeId or signerEmail in request",
      });
    }

    if (!Array.isArray(template) || template.length === 0) {
      return res.status(400).json({
        error: "template must be a non-empty array of PDF base64 strings",
      });
    }

    const env = await Envelope.findOne({
      _id: envelopeId,
      "signers.email": signerEmail,
    });

    if (!env) return res.status(404).json({ error: "Envelope not found" });

    const idx = env.signers.findIndex((s) => s.email === signerEmail);
    if (idx < 0) {
      return res.status(400).json({ error: "Signer not found in envelope" });
    }

    if (env.signers[idx].status === SIGN_EVENTS.COMPLETED) {
      return res.status(400).json({
        error: "This signer has already completed the document",
      });
    }

    // -------------------------------------------------------
    // Save / update signature for signer
    // -------------------------------------------------------
    const findSignature = await signatureModel.findOne({ email: signerEmail });
    if (findSignature) {
      await signatureModel.updateOne({ email: signerEmail }, { signature });
    } else {
      await signatureModel.create({ email: signerEmail, signature });
    }

    // -------------------------------------------------------
    // Preserve existing files array
    // -------------------------------------------------------
    const existingFiles = Array.isArray(env.files) ? env.files : [];

    while (existingFiles.length < template.length) {
      existingFiles.push({
        filename: "",
        storedName: "",
        publicUrl: "",
        templatePdf: "",
        signedTemplatePdf: "",
        mimetype: "application/pdf",
        html: "",
        fileId: "",
      });
    }

    const datePart = `${getCurrentDayInNumber()}-${getCurrentMonth()}-${getCurrentYear()}`;

    const signedPdfBuffersToMerge = [];
    const invalidIndexes = [];

    // -------------------------------------------------------
    // PER-TEMPLATE SIGNED PDF → upload + base64 with header
    // -------------------------------------------------------
    for (let i = 0; i < template.length; i++) {
      const file = existingFiles[i];
      const pdfB64 = template[i];

      const pdfBuffer = base64ToPdfBuffer(pdfB64);

      if (!pdfBuffer || !pdfBuffer.length) {
        invalidIndexes.push(i);
        continue;
      }

      let pdfWithHeader = pdfBuffer;
      try {
        pdfWithHeader = await addHeaderToPdf(pdfBuffer, env._id);
      } catch (e) {
        pdfWithHeader = pdfBuffer;
      }

      // ── FIXED: full data URI base64 (most frontends expect this format) ──
      const signedBase64 = `${Buffer.from(pdfWithHeader).toString("base64")}`;
      file.html = signedBase64;

      const singleName = `${datePart}_${Date.now()}_signed-template-${i + 1}.pdf`;

      await AwsFileUpload.uploadToSpaces({
        fileData: pdfWithHeader,
        filename: singleName,
        filepath: ESIGN_SIGNED_PATH,
        mimetype: "application/pdf",
      });

      file.mimetype = "application/pdf";
      file.filename = file.filename || `Document-${i + 1}.pdf`;
      file.signedTemplatePdf = singleName;

      signedPdfBuffersToMerge.push(pdfWithHeader);
    }

    if (signedPdfBuffersToMerge.length === 0) {
      return res.status(400).json({
        error:
          "No valid PDF content found in template array. Make sure each template[i] is a PDF base64 string (decoded buffer must start with %PDF-).",
        invalidIndexes,
      });
    }

    // -------------------------------------------------------
    // MERGED SIGNED PDF (env.signedPdf ONLY)
    // -------------------------------------------------------
    const mergedPdfBuffer = await mergePdfBuffers(signedPdfBuffersToMerge);

    let mergedPdfWithHeader = mergedPdfBuffer;
    try {
      mergedPdfWithHeader = await addHeaderToPdf(mergedPdfBuffer, env._id);
    } catch (e) {
      mergedPdfWithHeader = mergedPdfBuffer;
    }

    const mergedOutputName = `${datePart}_${Date.now()}_merged-signed.pdf`;

    await AwsFileUpload.uploadToSpaces({
      fileData: mergedPdfWithHeader,
      filename: mergedOutputName,
      filepath: ESIGN_SIGNED_PATH,
      mimetype: "application/pdf",
    });

    env.files = existingFiles;
    env.signedPdf = mergedOutputName;

    // -------------------------------------------------------
    // Update signer details
    // -------------------------------------------------------
    env.signers[idx].status = SIGN_EVENTS.COMPLETED;
    env.signers[idx].completedAt = new Date();
    env.signers[idx].signedUrl = mergedOutputName;
    env.signers[idx].location = location || {};
    env.signers[idx].ipAddress = normalizeIP(req) || "";

    // -------------------------------------------------------
    // Helper: check completion only for need_to_sign users
    // -------------------------------------------------------
    // const allNeedToSignCompleted = () => {
    //   return env.signers
    //     .filter((s) => (s.isAction || IS_ACTIVE_ENUM.NEED_TO_SIGN) === IS_ACTIVE_ENUM.NEED_TO_SIGN)
    //     .every((s) => s.status === SIGN_EVENTS.COMPLETED);
    // };

    const getNextRoutingOrder = () => {
      const pending = env.signers.filter(
        (s) =>
          (s.isAction || IS_ACTIVE_ENUM.NEED_TO_SIGN) === IS_ACTIVE_ENUM.NEED_TO_SIGN &&
          s.status === SIGN_EVENTS.PENDING
      );
      if (!pending.length) return null;
      return Math.min(...pending.map((s) => +s.routingOrder || 0));
    };

    const getRoutingIndexes = (order) => {
      const ids = [];
      env.signers.forEach((s, i) => {
        if (
          (s.isAction || IS_ACTIVE_ENUM.NEED_TO_SIGN) === IS_ACTIVE_ENUM.NEED_TO_SIGN &&
          s.status === SIGN_EVENTS.PENDING &&
          (+s.routingOrder || 0) === (+order || 0)
        ) {
          ids.push(i);
        }
      });
      return ids;
    };

    const allSignersDone = env.signers
      .filter(s => s.isAction === IS_ACTIVE_ENUM.NEED_TO_SIGN)
      .every(s => s.status === SIGN_EVENTS.COMPLETED);

    // if (allSignersDone) {
    //   const pendingViewersAndCopies = env.signers.filter(s =>
    //     s.isAction === IS_ACTIVE_ENUM.NEED_TO_VIEW || s.isAction === IS_ACTIVE_ENUM.RECEIVE_COPY
    //   );

    //   const completeTemplatePath = path.join(__dirname, "../public/template/completed.html");
    //   let completeEmailTemplate = fs.readFileSync(completeTemplatePath, "utf8");

    //   if (pendingViewersAndCopies.length > 0) {
    //     const now = new Date();
    //     const tpl = fs.readFileSync(
    //       path.join(__dirname, "../public/template/completed.html"),
    //       "utf8"
    //     );
    //     for (let s of env.signers) {
    //       if (s.isAction === IS_ACTIVE_ENUM.NEED_TO_VIEW || s.isAction === IS_ACTIVE_ENUM.RECEIVE_COPY) {
    //         if (s.status === SIGN_EVENTS.PENDING) {
    //           s.status = SIGN_EVENTS.SENT;
    //           s.sentAt = now;
    //           const html = completeEmailTemplate
    //             .replace(/{{completedUrl}}/g, completedUrl)
    //             .replace(/{{documentName}}/g, documentName)
    //           await sendMail(s.email, "Document Ready for View", html);
    //           );
    //         }
    //       }
    //     }
    //     env.documentStatus = SIGN_EVENTS.SENT;
    //   } else {
    //     env.documentStatus = SIGN_EVENTS.COMPLETED;
    //   }
    // }
    if (allSignersDone) {
      const pendingViewersAndCopies = env.signers.filter(s =>
        s.isAction === IS_ACTIVE_ENUM.NEED_TO_VIEW || s.isAction === IS_ACTIVE_ENUM.RECEIVE_COPY
      );

      // 1. Read the template once to save resources
      const completeTemplatePath = path.join(__dirname, "../public/template/completed.html");
      let completeEmailTemplate = "";

      try {
        completeEmailTemplate = fs.readFileSync(completeTemplatePath, "utf8");
      } catch (err) {
        console.error("Failed to read email template:", err);
        // Handle error (e.g., return or use a fallback string)
      }

      if (pendingViewersAndCopies.length > 0) {
        const now = new Date();

        for (let s of env.signers) {
          // Check if this specific signer needs to view or receive a copy
          if (s.isAction === IS_ACTIVE_ENUM.NEED_TO_VIEW || s.isAction === IS_ACTIVE_ENUM.RECEIVE_COPY) {

            // Only send if they haven't been processed yet
            if (s.status === SIGN_EVENTS.PENDING) {
              s.status = SIGN_EVENTS.SENT;
              s.sentAt = now;

              const documentName = env.files?.[0]?.filename || "Completed Document";

              let typeToken = "";
              if (s.tokenUrl && s.tokenUrl.includes("type=")) {
                typeToken = s.tokenUrl.split("type=")[1];
              }

              const completedUrl = `${SIGNING_WEB_URL}/pdf-documents?type=${typeToken}`;
              const html = completeEmailTemplate
                .replace(/{{completedUrl}}/g, completedUrl)
                .replace(/{{documentName}}/g, documentName);

              try {
                // 2. Await the mail sending
                await sendMail(s.email, "Document Ready for View", html);
                console.log(`Email sent successfully to: ${s.email}`);
              } catch (mailError) {
                // This is likely where your ETIMEDOUT is happening
                console.error(`Error sending mail to ${s.email}:`, mailError.message);
                // Optional: Reset status if you want to retry later
                // s.status = SIGN_EVENTS.PENDING; 
              }
            }
          }
        }
        env.documentStatus = SIGN_EVENTS.SENT;
      } else {
        env.documentStatus = SIGN_EVENTS.COMPLETED;
      }

    }

    // save now (so statuses persist)
    const envelopeData = await env.save();

    // webhook: completed only when documentStatus completed
    if (env.documentStatus === SIGN_EVENTS.COMPLETED) {
      const setEnv = await setEnvelopeData(envelopeData._id, SIGN_EVENTS.COMPLETED);
      await triggerWebhookEvent(SIGN_EVENTS.COMPLETED, STATICUSERID, setEnv);
    }

    // -------------------------------------------------------
    // Completed mail template
    // -------------------------------------------------------
    const completeTemplatePath = path.join(__dirname, "../public/template/completed.html");
    let completeEmailTemplate = fs.readFileSync(completeTemplatePath, "utf8");

    const documentName =
      env.files?.[0]?.filename || env.files?.[0]?.storedName || "Completed Document";

    const completedUrl = `${SIGNING_WEB_URL}/pdf-documents?type=${req.query.type}`;

    const completedEmailHtml = completeEmailTemplate
      .replace(/{{completedUrl}}/g, completedUrl)
      .replace(/{{documentName}}/g, documentName);

    // send completed mail to current signer
    const completedSubject = "Tianlong Document Completed: Review The Document";
    await sendMail(env.signers[idx].email, completedSubject, completedEmailHtml);

    const receiveCopyEmailsSent = [];
    if (env.documentStatus === SIGN_EVENTS.COMPLETED) {
      const receiveCopies = env.signers
        .map((s, i) => ({ s, i }))
        // .filter(({ s }) => (s.isAction || "") === "receive_copy");
        .filter(({ s }) => (s.isAction === IS_ACTIVE_ENUM.NEED_TO_VIEW || s.isAction === IS_ACTIVE_ENUM.RECEIVE_COPY) && s.status !== SIGN_EVENTS.COMPLETED);


      if (receiveCopies.length) {
        const now = new Date();
        receiveCopies.forEach(({ i }) => {
          env.signers[i].status = SIGN_EVENTS.SENT;
          env.signers[i].completedAt = now;
        });

        await env.save();

        await Promise.all(
          receiveCopies.map(async ({ s }) => {
            const html = completeEmailTemplate
              .replace(/{{completedUrl}}/g, completedUrl)
              .replace(/{{documentName}}/g, documentName);

            await sendMail(s.email, "Completed document copy", html);
            receiveCopyEmailsSent.push(s.email);
          })
        );
      }
    }

    // -------------------------------------------------------
    // 2) If routing enabled and not completed => send next routing batch
    // -------------------------------------------------------
    const nextRoutingEmailsSent = [];

    if (env.isRoutingOrder && env.documentStatus !== SIGN_EVENTS.COMPLETED) {
      const nextOrder = getNextRoutingOrder();

      if (nextOrder !== null) {
        const nextIndexes = getRoutingIndexes(nextOrder);

        if (nextIndexes.length) {
          const sendTemplatePath = path.join(
            __dirname,
            "../public/template/sendDocument.html"
          );
          const sendEmailTemplateRaw = fs.readFileSync(sendTemplatePath, "utf8");

          const now = new Date();

          nextIndexes.forEach((i) => {
            env.signers[i].status = SIGN_EVENTS.SENT;
            env.signers[i].sentAt = now;
          });

          await env.save();

          await Promise.all(
            nextIndexes.map(async (i) => {
              const s = env.signers[i];

              const signUrl = s.tokenUrl;
              const emailHtml = sendEmailTemplateRaw
                .replace(/{{name}}/g, s.name || "")
                .replace(/{{signUrl}}/g, signUrl || "")
                .replace(/{{DocumentName}}/g, documentName);

              await sendMail(s.email, "Please sign the documents", emailHtml);
              nextRoutingEmailsSent.push(s.email);
            })
          );
        }
      }
    }

    return res.json({
      status: true,
      message: "Envelope completed successfully (PDF flow)",
      downloadUrl: completedUrl,
      envelopeId: String(env._id),
      signerIndex: idx,
      signerEmail: env.signers[idx].email,
      documentStatus: env.documentStatus,
      files: env.files,               // now contains full data:application/pdf;base64,... in .html
      signedPdf: mergedOutputName,
      invalidIndexes,

      isRoutingOrder: !!env.isRoutingOrder,
      nextRoutingEmailsSent,
      receiveCopyEmailsSent,
    });
  } catch (err) {
    console.error("Error in completePdf:", err);
    return res.status(500).json({
      error: err?.message || "Envelope completion failed (PDF flow)",
    });
  }
};















module.exports = PDFeSignController;