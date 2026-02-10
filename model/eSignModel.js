const mongoose = require("mongoose");
const { SIGN_EVENTS, IS_ACTIVE_ENUM } = require("../config/contance.js");


const originalFileSchema = new mongoose.Schema(
    {
        filename: String,
        storedName: String,
        publicUrl: String,
        templatePdf: String,
        signedTemplatePdf: String,
        mimetype: String,
        html: String,
        fileId: String,
    }
);

const signerSchema = new mongoose.Schema(
    {
        email: { type: String, required: true },
        name: { type: String, default: "" },
        ipAddress: { type: String, default: "" },
        status: {
            type: String,
            enum: [SIGN_EVENTS.PENDING, SIGN_EVENTS.SENT, SIGN_EVENTS.DELIVERED, SIGN_EVENTS.COMPLETED, SIGN_EVENTS.AVOIDED,],
            default: SIGN_EVENTS.PENDING,
        },
        location: { type: Object, default: {} },
        metaData: [{ type: Object, default: {} }],
        isAction: { type: String, default: IS_ACTIVE_ENUM.NEED_TO_SIGN, enum: [IS_ACTIVE_ENUM.NEED_TO_SIGN, IS_ACTIVE_ENUM.RECEIVE_COPY, IS_ACTIVE_ENUM.NEED_TO_VIEW] },
        routingOrder: { type: Number, default: 0 },
        sentAt: Date,
        deliveredAt: Date,
        completedAt: Date,
        signedUrl: String,
        tokenUrl: String,
    }
);

const envelopeSchema = new mongoose.Schema(
    {
        signers: [signerSchema],
        documentStatus: {
            type: String,
            enum: [
                SIGN_EVENTS.PENDING,
                SIGN_EVENTS.SENT,
                SIGN_EVENTS.DELIVERED,
                SIGN_EVENTS.AVOIDED,
                SIGN_EVENTS.COMPLETED,
            ],
            default: SIGN_EVENTS.PENDING,
        },
        isRoutingOrder: { type: Boolean, default: false },
        files: [originalFileSchema],
        pdf: { type: String, default: "" },
        signedPdf: { type: String, default: "" }, // final merged/fully-signed pdf (optional)
        signedUrl: { type: String, default: "" }, // convenience: first signer link
        contentType: { type: String, default: null }
    },
    { collection: "envelope", timestamps: true }
);

const Envelope = mongoose.model("envelope", envelopeSchema);

module.exports = Envelope 