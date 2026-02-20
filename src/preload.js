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
    browseExtension: () => ipcRenderer.invoke('browse-extension'),

    // ===== Session Replay (NEW - Medium Priority) =====
    getSessionReplay: (sessionId) => ipcRenderer.invoke('get-session-replay', sessionId),
    getReplayList: () => ipcRenderer.invoke('get-replay-list'),

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

    // ===== Cleanup =====
    removeAllListeners: (channel) => {
        const validChannels = ['visit-started', 'visit-completed', 'session-event'];
        if (validChannels.includes(channel)) {
            ipcRenderer.removeAllListeners(channel);
        }
    }
});
