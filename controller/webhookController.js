const { WEBHOOK_EVENTS } = require("../config/contance");
const webhookSubscriptionModel = require("../model/webhookSubscriptionModel");

const webhookController = {};

webhookController.registerWebhook = async (req, res) => {
    const { userId, url, events } = req.body;

    const secretKey = crypto.randomBytes(32).toString("hex");

    const webhook = await webhookSubscriptionModel.create({
        userId,
        url,
        eventType: events,
        secretKey,
        isActive: WEBHOOK_EVENTS.ACTIVE
    });

    res.json({ message: "Webhook Registered", webhook });
}



module.exports = webhookController;


