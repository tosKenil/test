const mongoose = require("mongoose");
const { SIGN_EVENTS, WEBHOOK_EVENTS } = require("../config/contance");

const webhookSubcriptionSchema = new mongoose.Schema(
    {
        url: { type: String, defauly: null },
        eventType: { type: [String], defauly: null, enum: [SIGN_EVENTS.SENT, SIGN_EVENTS.DELIVERED, SIGN_EVENTS.COMPLETED, SIGN_EVENTS.AVOIDED] },
        isActive: { type: String, default: WEBHOOK_EVENTS.ACTIVE },
        secretKey: { type: String, defauly: null },
        userId: { type: mongoose.Schema.Types.ObjectId, default: null },
    },
    { collection: "webhook_subscription", timestamps: true }
);

module.exports = mongoose.model("webhook_subscription", webhookSubcriptionSchema);
