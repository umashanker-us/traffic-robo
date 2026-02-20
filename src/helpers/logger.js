/**
 * Logger utility for GA4 Traffic Robo
 * Uses Winston for file and console logging
 */

const winston = require('winston');
const path = require('path');
const fs = require('fs');
const Constants = require('./constants');

// Ensure logs directory exists
if (!fs.existsSync(Constants.LOGS_PATH)) {
    fs.mkdirSync(Constants.LOGS_PATH, { recursive: true });
}

// Custom format for log messages
const logFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, threadId, ...meta }) => {
        const thread = threadId ? `[Thread-${threadId}]` : '';
        const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : '';
        return `${timestamp} [${level.toUpperCase()}] ${thread} ${message} ${metaStr}`;
    })
);

// Create logger instance
const logger = winston.createLogger({
    level: 'info', // Changed from 'debug' to 'info' for better performance
    format: logFormat,
    transports: [
        // Console transport with colors
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                logFormat
            )
        }),
        // File transport for all logs
        new winston.transports.File({
            filename: path.join(Constants.LOGS_PATH, `traffic-robo-${new Date().toISOString().split('T')[0]}.log`),
            maxsize: 10485760, // 10MB
            maxFiles: 5
        }),
        // Separate file for errors
        new winston.transports.File({
            filename: path.join(Constants.LOGS_PATH, 'error.log'),
            level: 'error',
            maxsize: 10485760,
            maxFiles: 3
        })
    ]
});

// Helper class to create thread-specific loggers
class ThreadLogger {
    constructor(threadId) {
        this.threadId = threadId;
    }

    info(message, meta = {}) {
        logger.info(message, { threadId: this.threadId, ...meta });
    }

    error(message, meta = {}) {
        logger.error(message, { threadId: this.threadId, ...meta });
    }

    warn(message, meta = {}) {
        logger.warn(message, { threadId: this.threadId, ...meta });
    }

    debug(message, meta = {}) {
        logger.debug(message, { threadId: this.threadId, ...meta });
    }
}

// Factory function to get thread-specific logger
const getLogger = (threadId = null) => {
    if (threadId !== null) {
        return new ThreadLogger(threadId);
    }
    return logger;
};

module.exports = { logger, getLogger, ThreadLogger };
