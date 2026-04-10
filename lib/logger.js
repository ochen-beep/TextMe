/**
 * TextMe — Centralized logger with export capability
 * License: AGPL-3.0
 *
 * v1.4.0: Extended exportLogs() diagnostics:
 *   — active connection profile (name + id)
 *   — which profile each prompt was sent through (via [Profile] log entries)
 *   — all Enable/checkbox toggle events (via [Settings] log entries)
 *   — ST API type + model currently selected
 *   — autonomous timer state (running / stopped, next fire estimate)
 *   — phone data health (message count, lastActivity, autonomousCount, backoff)
 *   — Connection Manager availability + profile count
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
    const ctx       = SillyTavern.getContext();
    const settings  = getSettings();
    const phoneData = getPhoneData();

    // ── Status ──────────────────────────────────────────────────────────────
    let statusStr = 'unknown';
    try {
        const { status, activity, isManual } = getCurrentStatus();
        const { label } = getStatusInfo(status);
        statusStr = `${label}${activity ? ` — ${activity}` : ''}${isManual ? ' (manual override)' : ''}`;
    } catch (e) { /* ignore */ }

    // ── Basic fields ────────────────────────────────────────────────────────
    const charName     = getCharName();
    const msgCount     = phoneData?.messages?.length ?? 0;
    const hasSchedule  = !!(phoneData?.scheduleBlocks || phoneData?.schedule);
    const manualStatus = phoneData?.manualStatus || 'none';
    const stVersion    = ctx.version || 'unknown';
    const chatId       = ctx.getCurrentChatId?.() || ctx.chatId || 'unknown';

    // ── Connection Profile ───────────────────────────────────────────────────
    let profileInfo = 'none (using default ST connection)';
    try {
        const profileId = settings.connectionProfileId;
        if (profileId) {
            const profiles = ctx.extensionSettings?.connectionManager?.profiles;
            const profile  = Array.isArray(profiles) ? profiles.find(p => p.id === profileId) : null;
            if (profile) {
                profileInfo = `"${profile.name}" (id: ${profile.id}, api: ${profile.api || 'unknown'})`;
            } else {
                profileInfo = `id: ${profileId} — NOT FOUND (profile may have been deleted)`;
            }
        }
    } catch (e) {
        profileInfo = `error reading profile: ${e.message}`;
    }

    // ── Connection Manager availability ──────────────────────────────────────
    let cmInfo = 'unavailable';
    try {
        if (ctx.extensionSettings?.disabledExtensions?.includes('connection-manager')) {
            cmInfo = 'DISABLED';
        } else {
            const profiles = ctx.extensionSettings?.connectionManager?.profiles;
            if (Array.isArray(profiles)) {
                cmInfo = `available — ${profiles.length} profile${profiles.length !== 1 ? 's' : ''} total`;
            }
        }
    } catch (e) {
        cmInfo = `error: ${e.message}`;
    }

    // ── ST API type + model ──────────────────────────────────────────────────
    let apiInfo = 'unknown';
    try {
        const api   = ctx.main_api || ctx.mainAPI || 'unknown';
        const model = ctx.online_status?.model
                   || ctx.onlineStatus?.model
                   || ctx.currentModel
                   || 'unknown';
        apiInfo = `${api} / ${model}`;
    } catch (e) {
        apiInfo = `error: ${e.message}`;
    }

    // ── Phone data health ────────────────────────────────────────────────────
    let phoneHealth = 'no phone data';
    try {
        if (phoneData) {
            const lastAct    = phoneData.lastActivity
                ? new Date(phoneData.lastActivity).toISOString()
                : 'never';
            const backoff    = phoneData.autonomousErrorBackoff
                ? new Date(phoneData.autonomousErrorBackoff).toISOString()
                : 'none';
            const waitSince  = phoneData.autonomousWaitSince
                ? new Date(phoneData.autonomousWaitSince).toISOString()
                : 'none';
            const waitThresh = phoneData.autonomousWaitThreshold != null
                ? `${Math.round(phoneData.autonomousWaitThreshold / 60000)} min`
                : 'none';
            phoneHealth = [
                `messages: ${msgCount}`,
                `lastActivity: ${lastAct}`,
                `autonomousCount: ${phoneData.autonomousCount ?? 0}`,
                `autonomousErrorBackoff: ${backoff}`,
                `autonomousWaitSince: ${waitSince}`,
                `autonomousWaitThreshold: ${waitThresh}`,
            ].join(', ');
        }
    } catch (e) {
        phoneHealth = `error: ${e.message}`;
    }

    // ── Settings snapshot (omit long prompts) ────────────────────────────────
    const settingsSnap = {};
    for (const [k, v] of Object.entries(settings)) {
        if (k.endsWith('Prompt')) continue;
        settingsSnap[k] = v;
    }

    // ── Build header ─────────────────────────────────────────────────────────
    const sep = '═'.repeat(60);
    const header = [
        `TextMe v${VERSION} — Log Export`,
        `Exported:            ${timestamp()}`,
        `ST Version:          ${stVersion}`,
        `Chat ID:             ${chatId}`,
        `Character:           ${charName}`,
        `Messages:            ${msgCount}`,
        `Schedule:            ${hasSchedule ? 'loaded' : 'not generated'}`,
        `Status:              ${statusStr}`,
        `Manual status:       ${manualStatus}`,
        ``,
        `Connection profile:  ${profileInfo}`,
        `Connection Manager:  ${cmInfo}`,
        `ST API / Model:      ${apiInfo}`,
        ``,
        `Phone data health:   ${phoneHealth}`,
        ``,
        `Log entries:         ${logEntries.length}`,
        sep,
        'Settings snapshot (prompts omitted):',
        JSON.stringify(settingsSnap, null, 2),
        sep,
        '',
    ].join('\n');

    if (logEntries.length === 0) {
        toastr.info('No log entries to export.');
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
