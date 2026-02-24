/**
 * Logger utility for GA4 Traffic Robo
 * Uses Winston for file and console logging
 */

const winston = require('winston');
const path = require('path');
const fs = require('fs');
const Constants = require('./constants');

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

// Create logger instance — console only; file transports added per-campaign by initCampaignLogger
const logger = winston.createLogger({
    level: 'info',
    format: logFormat,
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                logFormat
            )
        })
    ]
});

// ==================== Campaign-Specific Logging ====================

let currentCampaignLogDir = null;
let campaignTransports = [];

/**
 * Initialize campaign-specific log directory and transports
 * @param {string} campaignName - Name of the campaign
 * @returns {string} The created campaign log directory path
 */
function initCampaignLogger(campaignName = '') {
    // Sanitize name: lowercase, replace non-alphanumeric with underscore, collapse, truncate
    let sanitized = campaignName
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
        .substring(0, 50);
    if (!sanitized) sanitized = 'default';

    const now = new Date();
    const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const day = String(now.getDate()).padStart(2, '0');
    const time = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;

    const logDir = path.join(Constants.LOGS_PATH, yearMonth, day, `${sanitized}_${time}`);
    fs.mkdirSync(logDir, { recursive: true });

    // Create campaign-specific transports
    const campaignFileTransport = new winston.transports.File({
        filename: path.join(logDir, 'campaign.log'),
        level: 'info'
    });

    const errorsFileTransport = new winston.transports.File({
        filename: path.join(logDir, 'errors.log'),
        level: 'warn'
    });

    // Add to logger
    logger.add(campaignFileTransport);
    logger.add(errorsFileTransport);

    // Track for cleanup
    campaignTransports = [campaignFileTransport, errorsFileTransport];
    currentCampaignLogDir = logDir;

    logger.info(`Campaign log directory: ${logDir}`);
    return logDir;
}

/**
 * Get the current campaign log directory path
 * @returns {string|null}
 */
function getCampaignLogDir() {
    return currentCampaignLogDir;
}

/**
 * Remove campaign-specific transports and reset state
 */
function closeCampaignLogger() {
    for (const transport of campaignTransports) {
        try {
            logger.remove(transport);
        } catch (e) {
            // Transport may already be removed
        }
    }
    campaignTransports = [];
    currentCampaignLogDir = null;
}

/**
 * Delete log directories older than maxAgeDays
 * Scans LOGS_PATH for YYYY-MM folders and removes old ones
 * @param {number} maxAgeDays
 */
function cleanOldLogs(maxAgeDays = 30) {
    try {
        const logsPath = Constants.LOGS_PATH;
        if (!fs.existsSync(logsPath)) return;

        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - maxAgeDays);

        const entries = fs.readdirSync(logsPath, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            // Match YYYY-MM pattern
            const match = entry.name.match(/^(\d{4})-(\d{2})$/);
            if (!match) continue;

            const year = parseInt(match[1], 10);
            const month = parseInt(match[2], 10);

            // Delete if the entire month is older than cutoff
            // A month dir is "old" if the last day of that month is before cutoff
            const lastDayOfMonth = new Date(year, month, 0); // day 0 of next month = last day of this month
            if (lastDayOfMonth < cutoff) {
                const dirPath = path.join(logsPath, entry.name);
                fs.rmSync(dirPath, { recursive: true, force: true });
                logger.info(`Cleaned old log directory: ${entry.name}`);
            }
        }
    } catch (e) {
        // Non-fatal — don't crash on cleanup failure
        logger.warn(`Failed to clean old logs: ${e.message}`);
    }
}

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

module.exports = { logger, getLogger, ThreadLogger, initCampaignLogger, getCampaignLogDir, closeCampaignLogger, cleanOldLogs };
