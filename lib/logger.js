/**
 * TextMe — Centralized logger with export capability
 * License: AGPL-3.0
 */

import { EXTENSION_NAME, VERSION } from './state.js';

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
 */
export function exportLogs() {
    if (logEntries.length === 0) {
        toastr.info('No log entries to export.');
        return;
    }

    const header = `TextMe v${VERSION} — Log Export\nExported: ${timestamp()}\nEntries: ${logEntries.length}\n${'═'.repeat(60)}\n\n`;
    const body = logEntries.map(e => `[${e.time}] [${e.level}] ${e.msg}`).join('\n');
    const content = header + body;

    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `textme-logs-${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    toastr.success(`Exported ${logEntries.length} log entries.`);
}

/**
 * Get raw log entries array (for debug UI).
 */
export function getLogEntries() {
    return logEntries;
}
