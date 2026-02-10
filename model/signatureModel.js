const mongoose = require("mongoose");

const signatureSchema = new mongoose.Schema(
    {
        email: { type: String, default: null },
        signature: { type: String, default: null }
    },
    { collection: "signature", timestamps: true }
);

module.exports = mongoose.model("signature", signatureSchema);
