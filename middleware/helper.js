const helpers = {}
const jwt = require("jsonwebtoken");
const { JWT_SECRET, API_KEY } = process.env;
const fs = require("fs");
const puppeteer = require("puppeteer");
const chromium = require("@sparticuz/chromium");
const puppeteer_core = require("puppeteer-core");
const moment = require("moment");
const webhookSubscriptionModel = require("../model/webhookSubscriptionModel");
const { WEBHOOK_EVENTS, SIGN_EVENTS, IS_ACTIVE_ENUM } = require("../config/contance");
const webhookEventModel = require("../model/webhookEventModel");
const { ObjectId } = require('mongodb');
const sendWebhook = require("../services/sendWebhook");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const path = require("path");
const sendMail = require("../services/sendmail");

helpers.verifyJWT = async (req, res, next) => {
    const token = req.query.type;
    if (!token) return res.status(401).json({ error: "Missing token" });
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return res.status(401).json({ error: "Invalid token" });
        // decoded: { envId, email, i, iat, exp }
        req.envId = decoded.envId || decoded._id; // _id fallback if you ever used older tokens
        req.signerEmail = decoded.email;
        req.signerIndex =
            typeof decoded.i === "number" ? decoded.i : undefined;
        next();
    });
}

// ---------- API KEY MIDDLEWARE ----------
helpers.verifyApiKey = async (req, res, next) => {
    // Allow key via header (you used 'api-key')
    const headerKey = req.headers["api-key"];

    if (!headerKey) {
        console.error("API_KEY not configured on server");
        return res.status(500).json({ error: "Server API key not configured" });
    }

    if (!headerKey || headerKey !== API_KEY) {
        return res.status(401).json({ error: "Invalid or missing API key" });
    }

    next();
}

helpers.addHeaderToPdf = async (pdfBytes, envelopeId) => {
    const pdfDoc = await PDFDocument.load(pdfBytes);

    const pages = pdfDoc.getPages();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontSize = 9;

    const headerText = `Envelope ID: ${String(envelopeId)}`;
    const headerHeight = 22;
    const paddingX = 12;

    // ✅ calculate text width dynamically
    const textWidth = font.widthOfTextAtSize(headerText, fontSize);
    const headerWidth = textWidth + paddingX * 2;

    pages.forEach((page) => {
        const { height } = page.getSize();

        // Header background (dynamic width)
        page.drawRectangle({
            x: 0,
            y: height - headerHeight,
            width: headerWidth,
            height: headerHeight,
            color: rgb(1, 1, 1),
        });

        // Header text
        page.drawText(headerText, {
            x: paddingX,
            y: height - (headerHeight / 2) - (fontSize / 2) + 1,
            size: fontSize,
            font,
            color: rgb(0, 0, 0),
        });
    });

    return await pdfDoc.save();
};

helpers.generatePdfDocumentFromTemplate = async ({
    templatePath,
    outputName,
    data,
    landscape = false,
}) => {
    let html = fs.readFileSync(templatePath, 'utf-8');

    if (data && typeof data === 'object') {
        for (const [key, value] of Object.entries(data)) {
            const pattern = new RegExp(`{{\\s*${key}\\s*}}`, 'g');
            html = html.replace(pattern, value);
        }
    }

    let pdfBuffer = null;

    // If you want to generate a real PDF when landscape === true
    if (landscape === true) {
        let browser;
        if (process.env.NODE_ENV === "development") {

            browser = await puppeteer.launch({ args: ['--no-sandbox'] });
        } else {
            browser = await puppeteer_core.launch({
                args: [...chromium.args, "--no-sandbox", "--disable-setuid-sandbox"],
                defaultViewport: chromium.defaultViewport,
                executablePath: await chromium.executablePath(),
                headless: chromium.headless,
            });
        }

        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });

        pdfBuffer = Buffer.from(
            await page.pdf({
                format: 'A4',
                landscape,
                printBackground: true,
            })
        );
        await browser.close();
    }

    // 👇 Always return a valid Buffer:
    // - if PDF was generated → use that
    // - otherwise → fall back to HTML buffer
    const fileBuffer = pdfBuffer || Buffer.from(html, 'utf-8');

    return {
        name: outputName,
        file: fileBuffer,
    };
};

helpers.base64ToPdfBuffer = (b64) => {
    if (!b64) return null;

    const cleaned = String(b64)
        .trim()
        .replace(/^data:application\/pdf;base64,/, "")
        .replace(/\s/g, "");

    let buf;
    try {
        buf = Buffer.from(cleaned, "base64");
    } catch (e) {
        return null;
    }

    if (!buf || buf.length < 5) return null;

    // Validate PDF header: %PDF-
    const header = buf.subarray(0, 5).toString("utf8");
    if (header !== "%PDF-") {
        return null; // not a valid pdf binary
    }

    return buf;
};// helpers/pdfUtils.js  or  helpers/index.js

helpers.pdfBufferToBase64 = (buffer, withDataUri = false) => {
    if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
        return null;
    }

    // Optional strict validation
    const header = buffer.subarray(0, 5).toString("utf8");
    if (header !== "%PDF-") {
        console.warn("pdfBufferToBase64: Buffer does not look like a valid PDF");
        // return null;   ← uncomment if you want to be strict
    }

    const base64 = buffer.toString("base64");

    return withDataUri
        ? `data:application/pdf;base64,${base64}`
        : base64;
};

helpers.mergePdfBuffers = async (buffers) => {
    const mergedPdf = await PDFDocument.create();

    for (const buf of buffers) {
        const src = await PDFDocument.load(buf);
        const pages = await mergedPdf.copyPages(src, src.getPageIndices());
        pages.forEach((p) => mergedPdf.addPage(p));
    }

    const mergedBytes = await mergedPdf.save();
    return Buffer.from(mergedBytes);
};


function extractHeadFragments(htmlStr = "") {
    const styles = [];
    const links = [];

    const styleMatches = htmlStr.match(/<style[^>]*>[\s\S]*?<\/style>/gi);
    if (styleMatches) styles.push(...styleMatches);

    const linkMatches = htmlStr.match(
        /<link[^>]+rel=["']stylesheet["'][^>]*>/gi
    );
    if (linkMatches) links.push(...linkMatches);

    return { styles, links };
}


function extractBody(htmlStr = "") {
    const bodyMatch = htmlStr.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch) return bodyMatch[1];
    return htmlStr;
}

helpers.buildFullPdfHtml = (pagesHtml = []) => {
    const collectedStyles = [];
    const collectedLinks = [];

    // Collect styles/links from all templates
    pagesHtml.forEach((htmlStr) => {
        if (!htmlStr || !htmlStr.trim()) return;
        const { styles, links } = extractHeadFragments(htmlStr);
        if (styles.length) collectedStyles.push(...styles);
        if (links.length) collectedLinks.push(...links);
    });

    const headCss = `
        <style>
            @page {
                size: A4;
                margin: 15mm;
            }
            html, body {
                margin: 0;
                padding: 0;
                -webkit-print-color-adjust: exact;
                print-color-adjust: exact;
                font-family: Arial, sans-serif;
            }
            .pdf-page {
                margin: 0;
                padding: 0;
            }
            .page-break {
                page-break-after: always;
            }
        </style>
    `;

    const headContent = `
        <meta charset="utf-8" />
        ${collectedLinks.join("\n")}
        ${collectedStyles.join("\n")}
        ${headCss}
    `;

    let bodyContent = "";

    if (pagesHtml.length === 1) {
        // ✅ SINGLE TEMPLATE → continuous content, no manual page-breaks
        const singleBody = extractBody(pagesHtml[0]);
        bodyContent = `
            <div class="pdf-page">
                ${singleBody}
            </div>
        `;
    } else {
        // ✅ MULTIPLE TEMPLATES → each one starts on a new page
        const bodyPages = pagesHtml
            .map((htmlStr) => (htmlStr || "").trim())
            .filter(Boolean)
            .map((htmlStr) => extractBody(htmlStr));

        bodyContent = bodyPages
            .map((pageHtml, index) => {
                const needsBreak = index < bodyPages.length - 1;
                return `
                    <div class="pdf-page">
                        ${pageHtml}
                    </div>
                    ${needsBreak ? '<div class="page-break"></div>' : ""}
                `;
            })
            .join("\n");
    }

    return `
        <!DOCTYPE html>
        <html>
        <head>
            ${headContent}
        </head>
        <body>
            ${bodyContent}
        </body>
        </html>
    `;
}


// =================================for date (START)=============================
helpers.getCurrentDayInNumber = () => {
    const currentDayOfMonth = moment().format('D');
    return currentDayOfMonth; // All keys are valid
};
helpers.getCurrentMonth = () => {
    const currentMonth = moment().format('M');
    return currentMonth; // All keys are valid
};
helpers.getCurrentYear = () => {
    const currentYear = moment().format('YYYY');
    return currentYear; // All keys are valid
};
// =================================for date  (END)=============================


// =================================for routing Order  (START)=============================

// helpers.getMinRoutingOrderPending = (env) => {
//     const candidates = env.signers.filter(
//         (s) => s.isAction === "need_to_sign" && s.status === SIGN_EVENTS.PENDING
//     );
//     if (!candidates.length) return null;
//     return Math.min(...candidates.map((s) => +s.routingOrder || 0));
// };

// helpers.getIndexesByRoutingOrderPending = (env, routingOrder) => {
//     const idxs = [];
//     env.signers.forEach((s, idx) => {
//         if (
//             s.isAction === "need_to_sign" &&
//             s.status === SIGN_EVENTS.PENDING &&
//             (+s.routingOrder || 0) === (+routingOrder || 0)
//         ) {
//             idxs.push(idx);
//         }
//     });
//     return idxs;
// };

helpers.allNeedToSignCompleted = (env) => {
    return env.signers
        .filter((s) => s.isAction === IS_ACTIVE_ENUM.NEED_TO_SIGN)
        .every((s) => s.status === SIGN_EVENTS.COMPLETED);
};

// Send signing emails to a set of signer indexes, mark SENT
// helpers.emailSignerIndexesAndMarkSent = async ({ env, signerIndexes, files }) => {
//     if (!signerIndexes?.length) return [];

//     const templatePath = path.join(__dirname, "../public/template/sendDocument.html");
//     const emailTemplateRaw = fs.readFileSync(templatePath, "utf8");

//     const firstFile = files?.[0];
//     const docName = firstFile?.filename || "Document";

//     const now = new Date();

//     // mark as SENT before email (avoid double send if process crashes mid-way)
//     signerIndexes.forEach((idx) => {
//         env.signers[idx].status = SIGN_EVENTS.SENT;
//         env.signers[idx].sentAt = now;
//     });
//     await env.save();

//     await Promise.all(
//         signerIndexes.map(async (idx) => {
//             const s = env.signers[idx];
//             const emailHtml = emailTemplateRaw
//                 .replace(/{{name}}/g, s.name || "")
//                 .replace(/{{signUrl}}/g, s.tokenUrl || "")
//                 .replace(/{{DocumentName}}/g, docName);

//             await sendMail(s.email, "Please sign the documents", emailHtml);
//         })
//     );

//     return signerIndexes.map((idx) => env.signers[idx]?.email);
// };

// Send completed/copy email to receive_copy people, mark COMPLETED
// helpers.emailReceiveCopyAndMarkCompleted = async ({ env, signedPdfUrl }) => {
//     const receivers = env.signers
//         .map((s, idx) => ({ s, idx }))
//         .filter(({ s }) => s.isAction === "receive_copy");

//     if (!receivers.length) return [];

//     // if you have a template for completed mail, use it.
//     // otherwise simple html.
//     let htmlTemplate = "";
//     try {
//         const p = path.join(__dirname, "../public/template/receiveCopy.html");
//         htmlTemplate = fs.readFileSync(p, "utf8");
//     } catch {
//         htmlTemplate = `
//       <div>
//         <p>Hi {{name}},</p>
//         <p>The envelope has been completed. You can download the signed document here:</p>
//         <p><a href="{{downloadUrl}}">Download Signed PDF</a></p>
//       </div>
//     `;
//     }

//     const now = new Date();

//     receivers.forEach(({ idx }) => {
//         env.signers[idx].status = SIGN_EVENTS.COMPLETED;
//         env.signers[idx].completedAt = now;
//     });

//     await env.save();

//     await Promise.all(
//         receivers.map(async ({ s }) => {
//             const html = htmlTemplate
//                 .replace(/{{name}}/g, s.name || "")
//                 .replace(/{{downloadUrl}}/g, signedPdfUrl || "");

//             await sendMail(s.email, "Completed document copy", html);
//         })
//     );

//     return receivers.map(({ s }) => s.email);
// };


// =================================for routing Order  (END)=============================


helpers.normalizeIP = (req) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] ||
        req.connection?.remoteAddress ||
        req.socket?.remoteAddress;
    return ip?.replace('::ffff:', '') || ip;

}

helpers.setEnvelopeData = (envelopeId, event) => {
    return {
        envelopeId, event
    }
}

helpers.triggerWebhookEvent = async (eventType, userId, envelopeData) => {
    try {
        const subscriptions = await webhookSubscriptionModel.findOne({ eventType: { $in: [eventType] }, isActive: WEBHOOK_EVENTS.ACTIVE, userId: new ObjectId(userId) });

        if (subscriptions) {
            const webhookData = await webhookEventModel.create({
                subscriptionId: subscriptions._id,
                eventType: eventType,
                payload: envelopeData,
                status: WEBHOOK_EVENTS.PENDING,
            });

            return await sendWebhook(webhookData)
        }
    } catch (error) {
        return error
    }

}






module.exports = helpers