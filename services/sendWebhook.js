const axios = require("axios");
const crypto = require("crypto");
const { WEBHOOK_EVENTS } = require("../config/contance");
const webhookEventModel = require("../model/webhookEventModel");
const webhookSubscriptionModel = require("../model/webhookSubscriptionModel");

const sendWebhook = async (event) => {
    try {
        const subscription = await webhookSubscriptionModel.findOne({ _id: event.subscriptionId });
        if (!subscription) {
            console.error("❌ Subscription not found for event:", event._id);
            return;
        }

        try {
            await axios.post(subscription.url, event, {
                headers: { "Content-Type": "application/json" },
                timeout: 60000,
            }
            );
        } catch (error) {
            console.log(error)
            return error
        }


        await webhookEventModel.findByIdAndUpdate(
            event._id,
            { status: WEBHOOK_EVENTS.COMPLETED },
            { new: true }
        );

    } catch (err) {
        console.error("❌ Webhook failed:", err.message);

        await webhookEventModel.findByIdAndUpdate(
            event._id,
            { status: WEBHOOK_EVENTS.FAILED },
            { new: true }
        );
        return err
    }
};

module.exports = sendWebhook;
