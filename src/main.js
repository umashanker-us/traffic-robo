/**
 * GA4 Traffic Robo - Electron Main Process
 * Desktop application for traffic simulation
 * 
 * FIXES APPLIED:
 * 1. Added extension support for SimilarWeb
 */

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const VisitLogic = require('./core/visitLogic');
const { logger } = require('./helpers/logger');

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

app.whenReady().then(createWindow);

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
        const urlList = config.campaignLinks
            .split('\n')
            .map(url => url.trim())
            .filter(url => url.length > 0);

        // Parse referer list
        const refererList = config.refererLinks
            ? config.refererLinks.split('\n').map(url => url.trim()).filter(url => url.length > 0)
            : [''];

        if (urlList.length === 0) {
            throw new Error('Please enter at least one campaign URL');
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
            blockScripts: config.blockScripts || false
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
