const mongoose = require("mongoose");
const cron = require('node-cron');
const { backupDatabaseToLocal } = require("../controller/cronController");

mongoose.connect(process.env.DB_URL)
    .then(() => {
        console.log("✅ MongoDB connected")

        // cron.schedule('0 10 * * *', () => {
        //     console.log('⏰ Cron triggered at:', new Date().toISOString());
        //     backupDatabaseToLocal();
        // });
    })
    .catch((err) => {
        console.error(err);
        process.exit(1);
    });

