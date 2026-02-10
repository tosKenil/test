const logger = require('../utils/logger');

const requestLogger = (req, res, next) => {
    const startTime = Date.now();

    logger.info(`Incoming request: ${req.method} ${req.url} - Body: ${JSON.stringify(req.body)}`);
    
    const originalSend = res.send;
    res.send = function (body) {
        const duration = Date.now() - startTime;
        logger.info(`Outgoing response: ${req.method} ${req.url} - Status: ${res.statusCode} - Duration: ${duration}ms - Response: ${JSON.stringify(body)}`);
        originalSend.call(this, body);
    };

    next();
};

module.exports = requestLogger;
