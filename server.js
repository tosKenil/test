require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const mime = require("mime-types");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const ejs = require("ejs");
const fileUpload = require('express-fileupload')


const app = express();
app.use(express.json({ limit: "20mb" }));
app.use('/storage', express.static('storage'));
// app.use(
//     cors({
//         origin: ['*'],
//         methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
//         credentials: true,
//     })
// );
app.use(cors())
app.use(fileUpload())
// -------------------- ENV CONFIG --------------------
const PORT = process.env.PORT || 4000;
const BASE_URL = process.env.BASE_URL || `api.ttsign.co`;


// ========================================for socket io
// const server = require("http").createServer(app);
// const io = require("socket.io")(server)
// global.io = io;

// io.on('connection', (socket) => {
//     console.log("socket connected");
//     socket.on('socketJoin', (envId) => {
//         if (!socket.rooms.has(envId.toString())) {
//             console.log('roomJoin-->>>', envId);
//             socket.join(envId.toString());
//         }
//     });

//     socket.on('socketLeave', (envId) => {
//         if (socket.rooms.has(envId.toString())) {
//             console.log('roomLeave-->>>', envId);
//             socket.leave(envId.toString());
//         }
//     });

//     socket.on('disconnect', () => {
//         console.log("socket disconnected");
//     })

// });
// ========================================for socket io

app.get("/", (req, res) => {
    res.json({ message: `Welcome to ttSign api.......................` });
});

const { verifyApiKey } = require("./middleware/helper");

if (process.env.ACCESS_API_KEY == true || process.env.ACCESS_API_KEY === "true") {
    app.use("/api", verifyApiKey);
}

// const loggerMiddleware = require('./middleware/loggerMiddleware');
// app.use(loggerMiddleware);

app.use('/api', require('./route/eSignRoutes'));
require('./config/db');

app.use((err, req, res, next) => {
    if (!err) return next();
    console.error(
        "Unhandled error middleware caught:",
        err && err.stack ? err.stack : err
    );
    const message = err.message || (err.code ? String(err.code) : "Server error");
    res.status(500).json({ error: message });
});

app.use((req, res) => {
    res.status(404).json({ success: false, message: 'Route not found' });
});

// -------------------- START --------------------
app.listen(PORT, () =>
    console.log(`🚀 Server running at ${BASE_URL} (API key protected)`)
);
