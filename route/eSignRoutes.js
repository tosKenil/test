const express = require("express");
const route = express.Router();
const eSignController = require("../controller/eSignController.js");
const cronController = require("../controller/cronController");
const webhookController = require("../controller/webhookController");
const verification = require("../middleware/helper.js");
const path = require("path");
const PDFeSignController = require("../controller/PDFeSignController.js");


route.post("/generate-template", eSignController.generate_template);
route.get("/envelopes/getFiles", verification.verifyJWT, eSignController.readEnvelopeByToken);
route.post("/envelopes/complete", verification.verifyJWT, eSignController.completeEnvelope);
route.post("/envelopes/cancel", verification.verifyJWT, eSignController.cancelEnvelope);
route.post("/envelopeDetails", eSignController.envelopeDetails); 
route.post("/resentEnvelope", eSignController.resentEnvelope);

route.post("/uploadImg", eSignController.uploadImg);

route.post("/webhookRegister", webhookController.registerWebhook);


// for PDF
route.post("/storePdf", PDFeSignController.storePdf);
route.get("/readPdfbyToken", verification.verifyJWT, PDFeSignController.readPdfbyToken);
route.post("/completePdf", verification.verifyJWT, PDFeSignController.completePdf);

route.get('/backupDocs', cronController.backupDocs);

module.exports = route;