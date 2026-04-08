/**
 * TextMe — Centralized logger with export capability
 * License: AGPL-3.0
 *
 * IMPROVE: exportLogs() now includes rich diagnostics:
 *   char name, chat message count, current status, manual override,
 *   autonomous timer state, extension settings snapshot, ST version.
 */

import { EXTENSION_NAME, VERSION, getSettings, getPhoneData, getCharName } from './state.js';
import { getCurrentStatus, getStatusInfo } from './schedule.js';

const MAX_LOG_ENTRIES = 500;
const logEntries = [];

function timestamp() {
    return new Date().toISOString();
}

function addEntry(level, ...args) {
    const msg = args.map(a => {
        if (a instanceof Error) return `${a.message}\n${a.stack}`;
        if (typeof a === 'object') {
            try { return JSON.stringify(a, null, 2); } catch { return String(a); }
        }
        return String(a);
    }).join(' ');

    logEntries.push({ time: timestamp(), level, msg });
    if (logEntries.length > MAX_LOG_ENTRIES) {
        logEntries.splice(0, logEntries.length - MAX_LOG_ENTRIES);
    }
}

export const log = {
    info(...args) {
        console.log(`[${EXTENSION_NAME}]`, ...args);
        addEntry('INFO', ...args);
    },
    warn(...args) {
        console.warn(`[${EXTENSION_NAME}]`, ...args);
        addEntry('WARN', ...args);
    },
    error(...args) {
        console.error(`[${EXTENSION_NAME}]`, ...args);
        addEntry('ERROR', ...args);
    },
    debug(...args) {
        console.debug(`[${EXTENSION_NAME}]`, ...args);
        addEntry('DEBUG', ...args);
    },
};

/**
 * Export all logs as a downloadable text file.
 * Includes rich diagnostics header.
 */
export function exportLogs() {
    const ctx = SillyTavern.getContext();
    const settings  = getSettings();
    const phoneData = getPhoneData();

    // --- Diagnostics ---
    let statusStr = 'unknown';
    try {
        const { status, activity, isManual } = getCurrentStatus();
        const { label } = getStatusInfo(status);
        statusStr = `${label}${activity ? ` — ${activity}` : ''}${isManual ? ' (manual override)' : ''}`;
    } catch (e) { /* ignore */ }

    const charName     = getCharName();
    const msgCount     = phoneData?.messages?.length ?? 0;
    const hasSchedule  = !!(phoneData?.scheduleBlocks || phoneData?.schedule);
    const manualStatus = phoneData?.manualStatus || 'none';
    const stVersion    = ctx.version || 'unknown';
    const chatId       = ctx.getCurrentChatId?.() || ctx.chatId || 'unknown';

    // Settings snapshot (omit long prompts)
    const settingsSnap = {};
    for (const [k, v] of Object.entries(settings)) {
        if (k.endsWith('Prompt')) continue; // skip long prompt strings
        settingsSnap[k] = v;
    }

    const sep = '═'.repeat(60);
    const header = [
        `TextMe v${VERSION} — Log Export`,
        `Exported:       ${timestamp()}`,
        `ST Version:     ${stVersion}`,
        `Chat ID:        ${chatId}`,
        `Character:      ${charName}`,
        `Messages:       ${msgCount}`,
        `Schedule:       ${hasSchedule ? 'loaded' : 'not generated'}`,
        `Status:         ${statusStr}`,
        `Manual status:  ${manualStatus}`,
        `Log entries:    ${logEntries.length}`,
        sep,
        'Settings snapshot (prompts omitted):',
        JSON.stringify(settingsSnap, null, 2),
        sep,
        '',
    ].join('\n');

    if (logEntries.length === 0) {
        toastr.info('No log entries to export.');
        // Still export the header / diagnostics even with no logs
    }

    const body    = logEntries.map(e => `[${e.time}] [${e.level}] ${e.msg}`).join('\n');
    const content = header + (body || '(no log entries)');

    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `textme-logs-${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    toastr.success(`Exported ${logEntries.length} log entries + diagnostics.`);
}

/**
 * Get raw log entries array (for debug UI).
 */
export function getLogEntries() {
    return logEntries;
}
