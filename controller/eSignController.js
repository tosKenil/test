const eSignController = {};
const fs = require("fs");
const path = require("path");
const sendMail = require("../services/sendmail.js");
const { SIGN_EVENTS, DIRECTORIES, ESIGN_PATHS, userId, STATICUSERID } = require("../config/contance.js");
const Envelope = require("../model/eSignModel");
const jwt = require("jsonwebtoken");
const { generatePdfDocumentFromTemplate, addHeaderToPdf, buildFullPdfHtml, getCurrentDayInNumber, getCurrentMonth, getCurrentYear, normalizeIP, triggerWebhookEvent, setEnvelopeData } = require("../middleware/helper");
const { default: puppeteer } = require("puppeteer");
const chromium = require("@sparticuz/chromium");
const puppeteer_core = require("puppeteer-core");
const { PDFDocument } = require("pdf-lib");

const AwsFileUpload = require("../services/s3Upload"); // <-- change path as per your project
const signatureModel = require("../model/signatureModel.js");

const { JWT_SECRET, BASE_URL, SPACES_PUBLIC_URL, SIGNING_WEB_URL } = process.env;


// function createSignerToken(envId, email) {
//     const payload = {
//         envId: String(envId),
//         email: email,
//         i: 0
//     };

//     const token = jwt.sign(payload, JWT_SECRET);

//     return token;
// }
// let result = createSignerToken("", "")
// console.log(result)


const ESIGN_ORIGINALS_PATH = ESIGN_PATHS.ESIGN_ORIGINALS_PATH;
const ESIGN_PDF_PATH = ESIGN_PATHS.ESIGN_PDF_PATH;
const ESIGN_SIGNED_PATH = ESIGN_PATHS.ESIGN_SIGNED_PATH;


eSignController.generate_template = async (req, res) => {
    let browser;
    try {
        const { htmlTemplates, userData } = req.body;

        // Parse HTML templates
        let templates = [];
        try {
            templates = Array.isArray(htmlTemplates)
                ? htmlTemplates
                : JSON.parse(htmlTemplates);
        } catch {
            return res.status(400).json({ error: "htmlTemplates must be a valid array" });
        }

        if (!templates.length) {
            return res.status(400).json({ error: "At least one HTML template required" });
        }

        // Parse user data
        let users = [];
        try {
            users = Array.isArray(userData) ? userData : JSON.parse(userData);
        } catch {
            return res.status(400).json({ error: "userData must be a valid array" });
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        users = users
            .map((u) => ({
                name: u.name?.trim(),
                email: u.email?.trim(),
            }))
            .filter((u) => u.email && emailRegex.test(u.email));

        if (!users.length) {
            return res.status(400).json({ error: "Invalid userData format" });
        }

        const files = [];
        const pdfBuffers = [];

        // Setup Puppeteer
        if (process.env.NODE_ENV === "development") {
            browser = await puppeteer.launch({ args: ["--no-sandbox"] });
        } else {
            browser = await puppeteer_core.launch({
                args: [...chromium.args, "--no-sandbox", "--disable-setuid-sandbox"],
                defaultViewport: chromium.defaultViewport,
                executablePath: await chromium.executablePath(),
                headless: chromium.headless,
            });
        }

        // ---- HTML → individual PDFs (per-template) ----
        try {
            for (let i = 0; i < templates.length; i++) {
                const templateItem = templates[i];
                const rawHtml =
                    typeof templateItem === "string"
                        ? templateItem
                        : (templateItem?.html || "");

                if (!rawHtml) {
                    console.warn(`Template index ${i} has no valid HTML, skipping.`);
                    continue;
                }

                const givenName =
                    typeof templateItem === "object"
                        ? templateItem.name
                        : `Document-${i + 1}`;

                const baseName = `${getCurrentDayInNumber()}-${getCurrentMonth()}-${getCurrentYear()}_${Date.now()}-template-${i + 1}`;

                const htmlFileName = `${baseName}.html`;
                const pdfFileName = `${baseName}.pdf`;

                // 1) Upload raw HTML to Spaces
                const htmlUploadResult = await AwsFileUpload.uploadToSpaces({
                    fileData: Buffer.from(rawHtml, "utf-8"),
                    filename: htmlFileName,
                    filepath: ESIGN_ORIGINALS_PATH,
                    mimetype: "text/html",
                });

                // Try to resolve a usable/public URL from upload result
                // const htmlPublicUrl =
                //     htmlUploadResult?.publicUrl ||
                //     htmlUploadResult?.Location ||
                //     `${ESIGN_ORIGINALS_PATH}/${htmlFileName}`;

                // 2) Render HTML to PDF
                const page = await browser.newPage();
                await page.setViewport({ width: 1024, height: 768 });
                await page.setContent(rawHtml, { waitUntil: "networkidle0", timeout: 60000 });

                const pdfBuffer = await page.pdf({
                    format: "A4",
                    printBackground: true,
                    margin: { top: "0px", right: "0px", bottom: "0px", left: "0px" },
                });

                await page.close();

                // Keep this buffer for the merged PDF
                pdfBuffers.push(pdfBuffer);

                // 3) Upload PER-TEMPLATE PDF to Spaces ("df section")
                const pdfUploadResult = await AwsFileUpload.uploadToSpaces({
                    fileData: pdfBuffer,
                    filename: pdfFileName,
                    filepath: ESIGN_PDF_PATH, // your DF / PDF path in Spaces
                    mimetype: "application/pdf",
                });

                // const pdfPublicUrl =
                //     pdfUploadResult?.publicUrl ||
                //     pdfUploadResult?.Location ||
                //     `${ESIGN_PDF_PATH}/${pdfFileName}`;

                // 4) Meta for DB (per HTML + its own PDF)
                files.push({
                    filename: givenName,
                    storedName: htmlFileName,
                    publicUrl: htmlFileName,
                    mimetype: "text/html",
                    html: rawHtml,

                    templatePdf: pdfFileName,
                    signedTemplatePdf: null
                });
            }
        } finally {
            if (browser) {
                await browser.close();
            }
        }

        if (!files.length || !pdfBuffers.length) {
            return res.status(400).json({ error: "No valid HTML templates after processing" });
        }

        // ---- Merge PDFs (still no header yet) ----
        const mergedPdf = await PDFDocument.create();
        for (const buf of pdfBuffers) {
            const pdf = await PDFDocument.load(buf);
            const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
            copiedPages.forEach((p) => mergedPdf.addPage(p));
        }

        const mergedPdfBytes = await mergedPdf.save();
        const mergedBaseName = `${getCurrentDayInNumber()}-${getCurrentMonth()}-${getCurrentYear()}_${Date.now()}-merged`;
        const mergedPdfFileName = `${mergedBaseName}.pdf`;
        const mergedKey = mergedPdfFileName;

        // ---- Setup envelope & signers (we need env._id for header) ----
        const now = new Date();
        const signers = users.map((u) => ({
            email: u.email,
            name: u.name,
            status: SIGN_EVENTS.SENT,
            sentAt: now,
            signedUrl: "",
            tokenUrl: "",
        }));

        let env = await Envelope.create({
            signers,
            files,                     // includes per-template html/pdf URLs
            documentStatus: SIGN_EVENTS.SENT,
            pdf: mergedKey,            // key/path for merged PDF (without header yet)
            signedPdf: "",
            signedUrl: "",
            tokenUrl: "",
        });

        // ---- Add header with Envelope ID to every page of merged PDF ----
        const finalMergedBytes = await addHeaderToPdf(mergedPdfBytes, env._id);

        // ---- Upload final merged PDF (with header) ----
        const mergedUploadResult = await AwsFileUpload.uploadToSpaces({
            fileData: finalMergedBytes,
            filename: mergedPdfFileName,
            filepath: ESIGN_PDF_PATH,
            mimetype: "application/pdf",
        });

        const mergedPublicUrl =
            mergedUploadResult?.publicUrl ||
            mergedUploadResult?.Location ||
            `${ESIGN_PDF_PATH}/${mergedPdfFileName}`;

        // If your Envelope schema supports it, you can also store this:
        env.pdf = mergedKey;        // keep the key
        env.pdfUrl = mergedPublicUrl; // <--- only if field exists in schema

        // ---- Generate token URLs and save env ----
        const signerResults = [];
        for (let i = 0; i < env.signers.length; i++) {
            const s = env.signers[i];
            const token = jwt.sign(
                { envId: String(env._id), email: s.email, i },
                JWT_SECRET
            );
            const signUrl = `${SIGNING_WEB_URL}/documents?type=${token}`;
            env.signers[i].tokenUrl = signUrl;

            signerResults.push({
                email: s.email,
                name: s.name,
                tokenUrl: signUrl,
            });
        }

        env.tokenUrl = signerResults[0]?.tokenUrl || "";
        await env.save();

        const setEnv = await setEnvelopeData(env._id, SIGN_EVENTS.SENT);
        await triggerWebhookEvent(SIGN_EVENTS.SENT, STATICUSERID, setEnv);

        // ------------------ Load email template HTML ------------------
        const templatePath = path.join(__dirname, "../public/template/sendDocument.html");
        const emailTemplateRaw = fs.readFileSync(templatePath, "utf8");

        // ------------------ Send Emails ------------------
        await Promise.all(
            signerResults.map(async ({ email, name, tokenUrl }) => {
                const firstFile = files[0]; // pick first uploaded template as document name
                const docName = firstFile?.filename || "Document";

                const emailHtml = emailTemplateRaw
                    .replace(/{{name}}/g, name)
                    .replace(/{{signUrl}}/g, tokenUrl)
                    .replace(/{{DocumentName}}/g, docName);

                const subject = "Please sign the documents";
                await sendMail(email, subject, emailHtml);
            })
        );

        return res.json({
            status: true,
            message: "emails sent successfully",
            envelopeId: String(env._id),
            // OPTIONAL: return the per-template DF URLs if you want to use on frontend
            // files,
            // mergedPdfUrl: mergedPublicUrl,
        });
    } catch (e) {
        console.log("🔥 Error in generate_template:", e.message);
        return res.status(500).json({ error: e + "Generation failed" });
    }
};

eSignController.readEnvelopeByToken = async (req, res) => {
    try {
        const env = await Envelope.findById(req.envId);
        if (!env) {
            return res.status(404).json({ error: "Envelope not found" });
        }

        // find signer by index or email
        let idx = typeof req.signerIndex === "number" ? req.signerIndex : env.signers.findIndex((s) => s.email === req.signerEmail);

        if (idx < 0 || idx >= env.signers.length) {
            return res.status(400).json({ error: "Signer not found in envelope" });
        }

        // mark DELIVERED if not already
        if (env.signers[idx].status == SIGN_EVENTS.SENT) {
            env.signers[idx].status = SIGN_EVENTS.DELIVERED;
            env.signers[idx].deliveredAt = new Date();
            // optional: if all signers delivered, bump envelope to DELIVERED
            if (
                env.signers.every((s) =>
                    [SIGN_EVENTS.DELIVERED, SIGN_EVENTS.COMPLETED].includes(s.status)
                )
            ) {
                env.documentStatus = SIGN_EVENTS.DELIVERED;
            }

            await env.save();

            const setEnv = await setEnvelopeData(env._id, SIGN_EVENTS.DELIVERED)
            await triggerWebhookEvent(SIGN_EVENTS.DELIVERED, STATICUSERID, setEnv)

        }

        const htmlTemplates = (env.files || [])
            // .filter((f) => f.mimetype == "text/html")
            .map((f) => ({
                filename: f.filename,
                signedTemplatePdf: f.signedTemplatePdf == null ? `${SPACES_PUBLIC_URL}/storage/pdf/${f.templatePdf}` : `${SPACES_PUBLIC_URL}/storage/signed/${f.signedTemplatePdf}`,
                mimetype: f.mimetype,
                html: f.html || null,
            }));


        const signature = await signatureModel.findOne({ email: req.signerEmail })
        let signatureRawData = null;
        if (signature) {
            signatureRawData = signature?.signature;
        }

        return res.json({
            status: true,
            message: "Envelope loaded successfully",
            envelopeId: String(env._id),
            documentStatus: env.documentStatus,
            signer: {
                index: idx,
                email: env.signers[idx].email,
                name: env.signers[idx].name,
                status: env.signers[idx].status,
                sentAt: env.signers[idx].sentAt,
                deliveredAt: env.signers[idx].deliveredAt,
                completedAt: env.signers[idx].completedAt,
            },
            files: env.files.map((f) => ({
                filename: f.filename,
                signedTemplatePdf: f.signedTemplatePdf == null ? `${SPACES_PUBLIC_URL}/storage/pdf/${f.templatePdf}` : `${SPACES_PUBLIC_URL}/storage/signed/${f.signedTemplatePdf}`,
                mimetype: f.mimetype,
            })),
            htmlTemplates,
            signatureRawData
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Failed to load envelope" });
    }
};

eSignController.completeEnvelope = async (req, res) => {
    let browser;
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
                error: "template must be a non-empty array of HTML strings",
            });
        }

        let env = await Envelope.findOne({
            _id: envelopeId,
            "signers.email": signerEmail,
        });

        if (!env) {
            return res.status(404).json({ error: "Envelope not found" });
        }

        const idx = env.signers.findIndex((s) => s.email === signerEmail);
        if (idx < 0) {
            return res.status(400).json({ error: "Signer not found in envelope" });
        }

        if (env.signers[idx].status === SIGN_EVENTS.COMPLETED) {
            return res.status(400).json({
                error: "This signer has already completed the document",
            });
        }

        // Save / update signature for signer
        const findSignature = await signatureModel.findOne({ email: signerEmail });
        if (findSignature) {
            await signatureModel.updateOne(
                { email: signerEmail },
                { signature: signature }
            );
        } else {
            await signatureModel.create({ email: signerEmail, signature: signature });
        }

        // --- Preserve existing file info & only update html/filename ---
        const existingFiles = Array.isArray(env.files) ? env.files : [];

        // Ensure env.files length covers all templates
        while (existingFiles.length < template.length) {
            existingFiles.push({
                filename: "",
                storedName: "",
                publicUrl: "",
                templatePdf: "",
                signedTemplatePdf: "",
                mimetype: "text/html",
                html: "",
            });
        }

        // Update HTML & filename, keep storedName/publicUrl/templatePdf as-is
        for (let i = 0; i < template.length; i++) {
            const prev = existingFiles[i];
            const htmlStr = template[i] || "";

            prev.filename = prev.filename || `page-${i + 1}.html`;
            prev.html = htmlStr;
            // keep:
            // prev.storedName
            // prev.publicUrl
            // prev.templatePdf
            // prev.signedTemplatePdf (will be overwritten below with new key)
            // prev.mimetype
        }

        env.files = existingFiles;

        // Collect valid HTML parts for merged PDF
        const htmlParts = env.files
            .map((f) => f.html || "")
            .filter((h) => h.trim().length > 0);

        if (htmlParts.length === 0) {
            return res.status(400).json({
                error: "No HTML content found in envelope files",
            });
        }

        // Launch Puppeteer
        if (process.env.NODE_ENV === "development") {
            browser = await puppeteer.launch({ args: ["--no-sandbox"] });
        } else {
            browser = await puppeteer_core.launch({
                    args: [...chromium.args, "--no-sandbox", "--disable-setuid-sandbox"],
                    defaultViewport: chromium.defaultViewport,
                    executablePath: await chromium.executablePath(),
                    headless: chromium.headless,
                });
            }

        const datePart = `${getCurrentDayInNumber()}-${getCurrentMonth()}-${getCurrentYear()}`;

            // --------------- PER-TEMPLATE SIGNED PDF (signedTemplatePdf) ---------------
            for (let i = 0; i < env.files.length; i++) {
                const file = env.files[i];
                const singleHtml = (file.html || "").trim();
                if (!singleHtml) continue;

                // Wrap single template into full HTML (reuse your builder)
                const singleFullHtml = buildFullPdfHtml([singleHtml]);

                const page = await browser.newPage();
                await page.setContent(singleFullHtml, {
                    waitUntil: "networkidle0",
                });

                const singlePdfBuffer = await page.pdf({
                    format: "A4",
                    printBackground: true,
                    margin: {
                        top: "15mm",
                        right: "15mm",
                        bottom: "15mm",
                        left: "15mm",
                    },
                });

                await page.close();

                // Optionally add header with Envelope ID to each per-template PDF as well
                const singlePdfWithHeader = await addHeaderToPdf(singlePdfBuffer, env._id);

                const singleName = `${datePart}_${Date.now()}_signed-template-${i + 1}.pdf`;

                await AwsFileUpload.uploadToSpaces({
                    fileData: singlePdfWithHeader,
                    filename: singleName,
                    filepath: ESIGN_SIGNED_PATH,
                    mimetype: "application/pdf",
                });

                // ✅ only set signedTemplatePdf, keep everything else unchanged
                file.signedTemplatePdf = singleName;
            }

            // --------------- MERGED SIGNED PDF (env.signedPdf ONLY) ---------------
            const fullHtml = buildFullPdfHtml(htmlParts);

            const mergedPage = await browser.newPage();
            await mergedPage.setContent(fullHtml, {
                waitUntil: "networkidle0",
            });

            const mergedPdfBuffer = await mergedPage.pdf({
                format: "A4",
                printBackground: true,
                margin: {
                    top: "15mm",
                    right: "15mm",
                    bottom: "15mm",
                    left: "15mm",
                },
            });

            await mergedPage.close();

            const mergedPdfWithHeader = await addHeaderToPdf(mergedPdfBuffer, env._id);

            const mergedOutputName = `${datePart}_${Date.now()}_merged-signed.pdf`;
            const mergedSignedKey = mergedOutputName;

            await AwsFileUpload.uploadToSpaces({
                fileData: mergedPdfWithHeader,
                filename: mergedOutputName,
                filepath: ESIGN_SIGNED_PATH,
                mimetype: "application/pdf",
            });

            // ✅ env.signedPdf = merged signed PDF ONLY
            env.signedPdf = mergedSignedKey;

            // (We do NOT touch storedName/publicUrl/templatePdf on files now)

            // --------------- Update signer & envelope status ---------------
            env.signers[idx].status = SIGN_EVENTS.COMPLETED;
            env.signers[idx].completedAt = new Date();
            env.signers[idx].signedUrl = mergedSignedKey; // or full URL if you like
            env.signers[idx].location = location || {};
            env.signers[idx].ipAddress = normalizeIP(req) || "";

            if (env.signers.every((s) => s.status === SIGN_EVENTS.COMPLETED)) {
                env.documentStatus = SIGN_EVENTS.COMPLETED;
            }

            const envelopeData = await env.save();

            const setEnv = await setEnvelopeData(envelopeData._id, SIGN_EVENTS.COMPLETED);
            await triggerWebhookEvent(SIGN_EVENTS.COMPLETED, STATICUSERID, setEnv);

            // --------------- Completed email ---------------
            const completeTemplatePath = path.join(
                __dirname,
                "../public/template/completed.html"
            );
            let completeEmailTemplate = fs.readFileSync(completeTemplatePath, "utf8");

            const documentName =
                env.files?.[0]?.filename ||
                env.files?.[0]?.storedName ||
                "Completed Document";

            const completedUrl = `${SIGNING_WEB_URL}/documents?type=${req.query.type}`;


            let emailHtml = completeEmailTemplate
                .replace(/{{completedUrl}}/g, completedUrl)
                .replace(/{{documentName}}/g, documentName);

            const subject = "Tianlong Document Completed: Review The Document";

            await sendMail(env.signers[idx].email, subject, emailHtml);

            // global.io.to(envelopeId.toString()).emit('reloadPage', { resData: "reloadPage" });

            return res.json({
                status: true,
                message: "Envelope completed successfully",
                downloadUrl: completedUrl,
                envelopeId: String(env._id),
                signerIndex: idx,
                signerEmail: env.signers[idx].email,
                documentStatus: env.documentStatus,
                files: env.files, // you can see templatePdf + signedTemplatePdf per file
                signedPdf: mergedSignedKey,
            });
        } catch (err) {
            console.error(
                "Error in /api/envelopes/complete",
                err && err.stack ? err.stack : err
            );
            return res
                .status(500)
                .json({ error: err?.message || "Envelope completion failed" });
        } finally {
            if (browser) {
                try {
                    await browser.close();
                } catch (e) {
                    console.error("Error closing Puppeteer browser", e);
                }
            }
        }
    };


    eSignController.cancelEnvelope = async (req, res) => {
        let env = await Envelope.findById(req.envId);
        if (!env) return res.status(404).json({ error: "Envelope not found" });

        env.documentStatus = SIGN_EVENTS.AVOIDED;
        env.signers = env.signers.map((s) => ({
            ...s.toObject(),
            status: SIGN_EVENTS.AVOIDED,
        }));
        await env.save();

        const setEnv = await setEnvelopeData(env._id, SIGN_EVENTS.AVOIDED)
        await triggerWebhookEvent(SIGN_EVENTS.AVOIDED, STATICUSERID, setEnv)

        res.json({
            status: true,
            message: "Cancelled successfully",
            envelopeId: String(env._id),
        });
    };

    eSignController.envelopeDetails = async (req, res) => {

        const { envId } = req.body;

        let env = await Envelope.findById(envId);
        if (!env) return res.status(404).json({ error: "Envelope not found" });

        env.pdf = env.pdf ? `${SPACES_PUBLIC_URL}/storage/pdf/${env.pdf}` : null;
        env.signedPdf = env.signedPdf ? `${SPACES_PUBLIC_URL}/storage/signed/${env.signedPdf}` : null;

        if (Array.isArray(env.signers)) {
            if (env.signers && Array.isArray(env.signers)) {
                env.signers = env.signers.map((signer) => ({
                    ...signer,
                    fileUrl: signer.file ? `${SPACES_PUBLIC_URL}/storage/signed/${signer.file}` : null,
                }));
            }
        }

        if (Array.isArray(env.files)) {
            env.files = env.files.map((file) => ({
                ...file,
                publicUrl: file.publicUrl ? `${SPACES_PUBLIC_URL}/storage/originals/${file.publicUrl}` : null,
                templatePdf: file.templatePdf ? `${SPACES_PUBLIC_URL}/storage/pdf/${file.templatePdf}` : null,
                signedTemplatePdf: file.signedTemplatePdf ? `${SPACES_PUBLIC_URL}/storage/signed/${file.signedTemplatePdf}` : null,
            }));
        }

        env._doc.completedAt = env?.documentStatus == SIGN_EVENTS.COMPLETED ? env.updatedAt : null;

        res.json({
            status: true,
            message: "Envelope details fetched successfully",
            envelopeId: env,
        });
    };

    eSignController.resentEnvelope = async (req, res) => {

        const { envId } = req.body;

        let env = await Envelope.findById(envId);
        if (!env) return res.status(404).json({ error: "Envelope not found" });

        const firstFile = env.files?.[0];
        const docName = firstFile?.filename || "Document";

        let mailSentCount = 0;

        const templatePath = path.join(__dirname, "../public/template/sendDocument.html");
        const emailTemplateRaw = fs.readFileSync(templatePath, "utf8");

        for (const signer of env.signers) {
            // send mail only if signer not completed
            if (signer.status !== SIGN_EVENTS.COMPLETED) {
                const tokenUrl = signer.tokenUrl;

                const emailHtml = emailTemplateRaw
                    .replace(/{{name}}/g, signer.name)
                    .replace(/{{signUrl}}/g, tokenUrl)
                    .replace(/{{DocumentName}}/g, docName);

                const subject = "Please sign the document";
                await Envelope.updateOne(
                    { _id: env._id, "signers.email": signer.email },
                    { $set: { "signers.$.sentAt": new Date(), "signers.$.status": SIGN_EVENTS.SENT } }
                );

                // also check and update documentStatus if needed
                if (env.documentStatus !== SIGN_EVENTS.SENT) {
                    env.documentStatus = SIGN_EVENTS.SENT;
                    await env.save();
                }


                await sendMail(signer.email, subject, emailHtml);
                mailSentCount++;
            }
        }

        return res.json({
            status: true,
            message: "Envelope resent successfully",
            envelopeId: env?._id,
        });
    };

    eSignController.uploadImg = async (req, res) => {

        const files = req.files;
        let s3Directory = ESIGN_PDF_PATH;

        let imgPath = `${Date.now()}.${files.file.name.substr(files.file.name.lastIndexOf('.') + 1)}`;

        await AwsFileUpload.uploadToSpaces({
            fileData: files.file.data,
            filename: imgPath,
            filepath: s3Directory,
            mimetype: files.file.mimetype
        });

        return res.json({
            status: true,
            message: "Cancelled successfully",
            url: process.env.SPACES_PUBLIC_URL + DIRECTORIES.PDF_DIRECTORY + imgPath
        });
    };

    module.exports = eSignController;
