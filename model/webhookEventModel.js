const mongoose = require("mongoose");
const { SIGN_EVENTS, WEBHOOK_EVENTS } = require("../config/contance");

const webhookEventSchema = new mongoose.Schema(
    {
        subscriptionId: { type: mongoose.Schema.Types.ObjectId, default: null },
        eventType: { type: String, defauly: null, enum: [SIGN_EVENTS.SENT, SIGN_EVENTS.DELIVERED, SIGN_EVENTS.COMPLETED, SIGN_EVENTS.AVOIDED] },
        payload: { type: Object, default: {} },
        status: { type: String, default: WEBHOOK_EVENTS.PENDING },
    },
    { collection: "webhook_event", timestamps: true }
);

module.exports = mongoose.model("webhook_event", webhookEventSchema);
