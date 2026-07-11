/**
 * Preload Script - Secure IPC Bridge for GA4 Traffic Robo
 * 
 * MEDIUM PRIORITY SECURITY FIX:
 * - Replaces nodeIntegration: true / contextIsolation: false
 * - Exposes only whitelisted IPC channels to renderer via contextBridge
 * - Prevents renderer from accessing Node.js APIs directly
 * 
 * Usage in renderer (index.html):
 *   window.electronAPI.startTraffic(config)
 *   window.electronAPI.onVisitCompleted(callback)
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // ===== Traffic Control =====
    startTraffic: (config) => ipcRenderer.invoke('start-traffic', config),
    stopTraffic: () => ipcRenderer.invoke('stop-traffic'),
    isRunning: () => ipcRenderer.invoke('is-running'),
    getVisitCount: () => ipcRenderer.invoke('get-visit-count'),

    // ===== Config Management =====
    saveConfig: (config) => ipcRenderer.invoke('save-config', config),
    loadConfig: () => ipcRenderer.invoke('load-config'),

    // ===== Extension =====
    getBundledExtension: () => ipcRenderer.invoke('get-bundled-extension'),
    downloadExtension: () => ipcRenderer.invoke('download-extension'),
    browseExtension: () => ipcRenderer.invoke('browse-extension'),

    // ===== Session Replay =====
    getSessionReplay: (sessionId) => ipcRenderer.invoke('get-session-replay', sessionId),
    getReplayList: () => ipcRenderer.invoke('get-replay-list'),
    clearReplays: () => ipcRenderer.invoke('clear-replays'),

    // ===== Debug Tracking =====
    setDebugTracking: (enabled) => ipcRenderer.invoke('set-debug-tracking', enabled),
    getDebugTracking: () => ipcRenderer.invoke('get-debug-tracking'),

    // ===== Log Folder =====
    openLogFolder: () => ipcRenderer.invoke('open-log-folder'),
    getLogFolder: () => ipcRenderer.invoke('get-log-folder'),

    // ===== Campaign Export =====
    exportCampaignCSV: () => ipcRenderer.invoke('export-campaign-csv'),
    exportCampaignJSON: () => ipcRenderer.invoke('export-campaign-json'),
    getCampaignResultsCount: () => ipcRenderer.invoke('get-campaign-results-count'),

    // ===== Campaign CSV (per-URL ranges) =====
    loadCampaignCsv: () => ipcRenderer.invoke('load-campaign-csv'),
    downloadCampaignCsvTemplate: () => ipcRenderer.invoke('download-campaign-csv-template'),

    // ===== Event Listeners =====
    onVisitStarted: (callback) => {
        const subscription = (_event) => callback();
        ipcRenderer.on('visit-started', subscription);
        return () => ipcRenderer.removeListener('visit-started', subscription);
    },
    onVisitCompleted: (callback) => {
        const subscription = (_event, count) => callback(count);
        ipcRenderer.on('visit-completed', subscription);
        return () => ipcRenderer.removeListener('visit-completed', subscription);
    },
    onSessionEvent: (callback) => {
        const subscription = (_event, data) => callback(data);
        ipcRenderer.on('session-event', subscription);
        return () => ipcRenderer.removeListener('session-event', subscription);
    },
    onProxyStats: (callback) => {
        const subscription = (_event, data) => callback(data);
        ipcRenderer.on('proxy-stats-update', subscription);
        return () => ipcRenderer.removeListener('proxy-stats-update', subscription);
    },
    onReplayUpdated: (callback) => {
        const subscription = (_event, threadId) => callback(threadId);
        ipcRenderer.on('replay-updated', subscription);
        return () => ipcRenderer.removeListener('replay-updated', subscription);
    },
    onSimulationComplete: (callback) => {
        const subscription = (_event, data) => callback(data);
        ipcRenderer.on('simulation-complete', subscription);
        return () => ipcRenderer.removeListener('simulation-complete', subscription);
    },

    // ===== Cleanup =====
    removeAllListeners: (channel) => {
        const validChannels = ['visit-started', 'visit-completed', 'session-event', 'proxy-stats-update', 'replay-updated', 'simulation-complete'];
        if (validChannels.includes(channel)) {
            ipcRenderer.removeAllListeners(channel);
        }
    }
});
