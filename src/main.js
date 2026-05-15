/**
 * GA4 Traffic Robo - Electron Main Process
 * Desktop application for traffic simulation
 * 
 * FIXES APPLIED:
 * 1. Added extension support for SimilarWeb
 */

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const VisitLogic = require('./core/visitLogic');
const { logger, getCampaignLogDir, cleanOldLogs } = require('./helpers/logger');
const Constants = require('./helpers/constants');
const { generateCSV, generateJSON, getExportFilename } = require('./helpers/campaignExport');
const { setDebugAllTracking, getDebugAllTracking } = require('./core/automaticVisitor');
const { parseCampaignCsv, CSV_TEMPLATE } = require('./helpers/campaignCsv');

let mainWindow;
let visitLogic = null;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 900,
        minWidth: 900,
        minHeight: 700,
        title: 'GA4 Traffic Robo v2.4',
        icon: path.join(__dirname, 'ui', 'icon.png'),
        webPreferences: {
            // SECURITY FIX (Medium Priority): contextIsolation + preload
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
            enableRemoteModule: false
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));

    // Open DevTools in development
    if (process.argv.includes('--dev')) {
        mainWindow.webContents.openDevTools();
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
        if (visitLogic) {
            visitLogic.stop();
        }
    });
}

app.whenReady().then(() => {
    cleanOldLogs();
    createWindow();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (mainWindow === null) {
        createWindow();
    }
});

// ==================== IPC Handlers ====================

/**
 * Start traffic simulation
 */
ipcMain.handle('start-traffic', async (event, config) => {
    try {
        logger.info('Starting traffic simulation with config:', config);

        // Parse URL list
        const urlList = (config.campaignLinks || '')
            .split('\n')
            .map(url => url.trim())
            .filter(url => url.length > 0);

        // Parse referer list
        const refererList = config.refererLinks
            ? config.refererLinks.split('\n').map(url => url.trim()).filter(url => url.length > 0)
            : [''];

        const hasCsv = Array.isArray(config.csvCampaignRows) && config.csvCampaignRows.length > 0;
        if (urlList.length === 0 && !hasCsv) {
            throw new Error('Please enter at least one campaign URL (or load a Campaign CSV)');
        }

        visitLogic = new VisitLogic();
        
        // Set up listener for UI updates
        visitLogic.setListener({
            uniqueVisitStarted: () => {
                mainWindow.webContents.send('visit-started');
            },
            uniqueVisit: (count) => {
                mainWindow.webContents.send('visit-completed', count);
            },
            proxyStatsUpdate: (data) => {
                mainWindow.webContents.send('proxy-stats-update', data);
            },
            ga4Event: (data) => {
                mainWindow.webContents.send('session-event', data);
            },
            replayUpdate: (threadId) => {
                mainWindow.webContents.send('replay-updated', threadId);
            },
            simulationComplete: (data) => {
                mainWindow.webContents.send('simulation-complete', data);
            }
        });

        // Start the simulation
        await visitLogic.start({
            urlList,
            refererList,
            isReferer: config.isReferer,
            repeat: parseInt(config.repeat) || 100,
            avgSessionDuration: parseInt(config.avgSessionDuration) || 60,
            bounceRate: parseInt(config.bounceRate) || 30,
            threads: parseInt(config.threads) || 5,
            threadDelay: parseInt(config.threadDelay) || 1,
            memClear: parseInt(config.memClear) || 0,
            pagePerSession: parseFloat(config.pagePerSession) || 3,
            userAgentType: config.userAgentType || 'Default',
            location: config.location || 'India',
            percOldUsers: parseInt(config.percOldUsers) || 20,
            previousURL: config.previousURL || null,
            useBaseUrlForOldUser: config.useBaseUrlForOldUser || false,
            commandMode: config.commandMode || 'Automatic',
            inputCommands: config.inputCommands || '',
            restrictToPrimaryDomain: config.restrictToPrimaryDomain !== false,
            playMode: config.playMode || 'Slow',
            adsBlock: config.adsBlock || false,
            // Proxy settings - Only GA requests use proxy
            proxyEnabled: config.proxyEnabled || false,
            proxyUrl: config.proxyUrl || '',
            proxyGAOnly: true,  // Always true - only GA requests through proxy
            // Extension settings - NEW
            extensionEnabled: config.extensionEnabled || false,
            extensionPath: config.extensionPath || '',
            // IP Rotation - NEW v2.4
            ipRotation: config.ipRotation || false,
            // Fast Mode
            fastMode: config.fastMode || false,
            blockImages: config.blockImages || false,
            blockMedia: config.blockMedia || false,
            blockFonts: config.blockFonts || false,
            blockStyles: config.blockStyles || false,
            blockScripts: config.blockScripts || false,
            // Traffic Source settings
            trafficSourceType: config.trafficSourceType || '',
            searchEngine: config.searchEngine || 'Google',
            searchKeywords: config.searchKeywords || '',
            referralUrls: config.referralUrls || '',
            socialPlatforms: config.socialPlatforms || [],
            utmSource: config.utmSource || '',
            utmMedium: config.utmMedium || '',
            utmCampaign: config.utmCampaign || '',
            utmTerm: config.utmTerm || '',
            utmContent: config.utmContent || '',
            mixedDirect: parseInt(config.mixedDirect) || 25,
            mixedOrganic: parseInt(config.mixedOrganic) || 35,
            mixedReferral: parseInt(config.mixedReferral) || 20,
            mixedSocial: parseInt(config.mixedSocial) || 20,
            campaignName: config.campaignName || '',
            // CSV campaign — per-URL ranges, optional. When set, overrides
            // urlList/visits/bounce/duration/pages.
            csvCampaignRows: config.csvCampaignRows || null,
        });

        return { success: true };

    } catch (error) {
        logger.error('Traffic simulation error:', error);
        return { success: false, error: error.message };
    }
});

/**
 * Stop traffic simulation
 */
ipcMain.handle('stop-traffic', async () => {
    try {
        if (visitLogic) {
            await visitLogic.stop();  // Now properly awaits
            logger.info('Traffic simulation stopped');
        }
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

/**
 * Get current visit count
 */
ipcMain.handle('get-visit-count', () => {
    if (visitLogic) {
        return visitLogic.getCurrentVisits();
    }
    return 0;
});

/**
 * Save configuration to file
 */
ipcMain.handle('save-config', async (event, config) => {
    try {
        const { filePath } = await dialog.showSaveDialog(mainWindow, {
            title: 'Save Configuration',
            defaultPath: `traffic-config-${Date.now()}.json`,
            filters: [
                { name: 'JSON Files', extensions: ['json'] }
            ]
        });

        if (filePath) {
            fs.writeFileSync(filePath, JSON.stringify(config, null, 2));
            logger.info(`Configuration saved to: ${filePath}`);
            return { success: true, path: filePath };
        }
        return { success: false };

    } catch (error) {
        return { success: false, error: error.message };
    }
});

/**
 * Load configuration from file
 */
ipcMain.handle('load-config', async () => {
    try {
        const { filePaths } = await dialog.showOpenDialog(mainWindow, {
            title: 'Load Configuration',
            filters: [
                { name: 'JSON Files', extensions: ['json'] }
            ],
            properties: ['openFile']
        });

        if (filePaths && filePaths.length > 0) {
            const content = fs.readFileSync(filePaths[0], 'utf8');
            const config = JSON.parse(content);
            logger.info(`Configuration loaded from: ${filePaths[0]}`);
            return { success: true, config };
        }
        return { success: false };

    } catch (error) {
        return { success: false, error: error.message };
    }
});

/**
 * Browse for extension folder
 * NEW: Added for SimilarWeb extension support
 */
ipcMain.handle('browse-extension', async () => {
    try {
        const { filePaths } = await dialog.showOpenDialog(mainWindow, {
            title: 'Select Extension Folder',
            properties: ['openDirectory'],
            message: 'Select the unpacked Chrome extension folder (should contain manifest.json)'
        });

        if (filePaths && filePaths.length > 0) {
            const extensionPath = filePaths[0];
            
            // Verify it's a valid extension (has manifest.json)
            const manifestPath = path.join(extensionPath, 'manifest.json');
            if (fs.existsSync(manifestPath)) {
                const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                logger.info(`Extension selected: ${manifest.name || 'Unknown'} v${manifest.version || '?'}`);
                return { 
                    success: true, 
                    path: extensionPath,
                    name: manifest.name || 'Unknown Extension',
                    version: manifest.version || '?'
                };
            } else {
                return { 
                    success: false, 
                    error: 'Invalid extension folder. manifest.json not found.' 
                };
            }
        }
        return { success: false };

    } catch (error) {
        return { success: false, error: error.message };
    }
});

/**
 * Check if simulation is running
 */
ipcMain.handle('is-running', () => {
    return visitLogic ? visitLogic.isRunning : false;
});

// ==================== Log Folder IPC Handlers ====================

/**
 * Open campaign log folder in OS file explorer
 */
ipcMain.handle('open-log-folder', async () => {
    const logDir = getCampaignLogDir() || (visitLogic && visitLogic.campaignLogDir) || Constants.LOGS_PATH;
    await shell.openPath(logDir);
    return { success: true };
});

/**
 * Get current campaign log folder path
 */
ipcMain.handle('get-log-folder', () => {
    return getCampaignLogDir() || (visitLogic && visitLogic.campaignLogDir) || null;
});

// ==================== Session Replay IPC Handlers ====================

/**
 * Get list of recent replays (compact)
 */
ipcMain.handle('get-replay-list', () => {
    if (visitLogic && visitLogic.replayStore) {
        return visitLogic.replayStore.getReplayList();
    }
    return [];
});

/**
 * Get full replay detail by thread/visit ID
 */
ipcMain.handle('get-session-replay', (event, threadId) => {
    if (visitLogic && visitLogic.replayStore) {
        return visitLogic.replayStore.getReplay(threadId);
    }
    return null;
});

/**
 * Clear all stored replays
 */
ipcMain.handle('clear-replays', () => {
    if (visitLogic && visitLogic.replayStore) {
        visitLogic.replayStore.clear();
    }
    return { success: true };
});

// ==================== Campaign Export IPC Handlers ====================

/**
 * Export campaign results as CSV
 */
ipcMain.handle('export-campaign-csv', async () => {
    try {
        if (!visitLogic || visitLogic.getCampaignResults().length === 0) {
            return { success: false, error: 'No campaign results to export' };
        }

        const defaultFilename = getExportFilename('csv');
        const { filePath } = await dialog.showSaveDialog(mainWindow, {
            title: 'Export Campaign Results (CSV)',
            defaultPath: defaultFilename,
            filters: [
                { name: 'CSV Files', extensions: ['csv'] }
            ]
        });

        if (filePath) {
            const csv = generateCSV(visitLogic.getCampaignResults());
            fs.writeFileSync(filePath, csv, 'utf8');
            logger.info(`Campaign CSV exported to: ${filePath}`);
            return { success: true, path: filePath, rows: visitLogic.getCampaignResults().length };
        }
        return { success: false };
    } catch (error) {
        logger.error(`CSV export error: ${error.message}`);
        return { success: false, error: error.message };
    }
});

/**
 * Export campaign results as JSON
 */
ipcMain.handle('export-campaign-json', async () => {
    try {
        if (!visitLogic || visitLogic.getCampaignResults().length === 0) {
            return { success: false, error: 'No campaign results to export' };
        }

        const defaultFilename = getExportFilename('json');
        const { filePath } = await dialog.showSaveDialog(mainWindow, {
            title: 'Export Campaign Report (JSON)',
            defaultPath: defaultFilename,
            filters: [
                { name: 'JSON Files', extensions: ['json'] }
            ]
        });

        if (filePath) {
            const report = generateJSON(visitLogic.getCampaignResults(), visitLogic.getCampaignConfig());
            fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf8');
            logger.info(`Campaign JSON exported to: ${filePath}`);
            return { success: true, path: filePath, rows: visitLogic.getCampaignResults().length };
        }
        return { success: false };
    } catch (error) {
        logger.error(`JSON export error: ${error.message}`);
        return { success: false, error: error.message };
    }
});

/**
 * Get campaign results count (for UI button state)
 */
ipcMain.handle('get-campaign-results-count', () => {
    if (visitLogic) {
        return visitLogic.getCampaignResults().length;
    }
    return 0;
});

// ==================== Debug Tracking Toggle ====================

ipcMain.handle('set-debug-tracking', (event, enabled) => {
    setDebugAllTracking(enabled);
    logger.info(`Debug all tracking pixels: ${enabled ? 'ON' : 'OFF'}`);
    return { success: true, enabled: getDebugAllTracking() };
});

ipcMain.handle('get-debug-tracking', () => {
    return getDebugAllTracking();
});

// ==================== Campaign CSV (per-URL ranges) ====================

/**
 * Open a campaign CSV, parse it, and return the parsed rows (range specs preserved).
 * Renderer keeps these in memory and passes them back via start-traffic.
 */
ipcMain.handle('load-campaign-csv', async () => {
    try {
        const { filePaths } = await dialog.showOpenDialog(mainWindow, {
            title: 'Load Campaign CSV',
            filters: [{ name: 'CSV Files', extensions: ['csv'] }],
            properties: ['openFile'],
        });
        if (!filePaths || filePaths.length === 0) {
            return { success: false, cancelled: true };
        }
        const filePath = filePaths[0];
        const text = fs.readFileSync(filePath, 'utf8');
        const { rows, errors } = parseCampaignCsv(text);
        if (errors.length > 0 && rows.length === 0) {
            return { success: false, error: errors.join('\n'), errors };
        }
        logger.info(`Campaign CSV loaded: ${rows.length} URLs from ${filePath} (warnings: ${errors.length})`);
        return { success: true, path: filePath, rows, errors };
    } catch (error) {
        logger.error(`Load campaign CSV failed: ${error.message}`);
        return { success: false, error: error.message };
    }
});

/**
 * Save a starter CSV template to a user-chosen path.
 */
ipcMain.handle('download-campaign-csv-template', async () => {
    try {
        const { filePath } = await dialog.showSaveDialog(mainWindow, {
            title: 'Save Campaign CSV Template',
            defaultPath: 'campaign-template.csv',
            filters: [{ name: 'CSV Files', extensions: ['csv'] }],
        });
        if (!filePath) return { success: false };
        fs.writeFileSync(filePath, CSV_TEMPLATE, 'utf8');
        logger.info(`Campaign CSV template saved to: ${filePath}`);
        return { success: true, path: filePath };
    } catch (error) {
        return { success: false, error: error.message };
    }
});
