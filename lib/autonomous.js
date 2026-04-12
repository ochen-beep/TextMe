/**
 * TextMe — Autonomous messaging system
 * License: AGPL-3.0
 *
 * v1.3.0 changes:
 * - Per-status thresholds (online / idle / dnd) instead of a single inactivityThreshold.
 * - cooldownCap: maximum effective threshold in minutes (prevents infinite escalation).
 * - Snapshot fix: threshold is determined once when inactivity begins and stored in
 *   phoneData.autonomousWaitThreshold. This prevents the bug where a schedule change
 *   mid-wait would cause a sudden threshold drop and premature firing.
 * - Error backoff: after a failed generation, skip retries for 5 minutes.
 * - Adaptive timer interval: re-evaluates every ~1/4 of the minimum threshold,
 *   so low thresholds get tighter polling and high thresholds don't waste cycles.
 * - idle status now gets its own threshold (was identical to online before).
 */

import { getSettings, getPhoneData, savePhoneData, hasCharacter } from './state.js';
import { generateAutonomousMessage } from './prompt-engine.js';
import { getCurrentStatus } from './schedule.js';
import { addExternalMessages, isPhoneOpen } from './phone-ui.js';
import { showBrowserNotification } from './notifications.js';
import { log } from './logger.js';

let autonomousTimer = null;
let isAutonomousGenerating = false;

/** AbortController for the currently-running autonomous generation. */
let autonomousAbortController = null;

/** Bound listener reference for textme:statusChanged — kept so we can remove it later. */
let _statusChangedListener = null;

// ─────────────────────────────────────────────────────────
// Timer management
// ─────────────────────────────────────────────────────────

/**
 * Compute the polling interval in ms.
 * Aim for ~4 checks per minimum-threshold period, bounded [15s, 5min].
 */
function _getTimerInterval() {
    const settings = getSettings();
    const t = settings.autonomousThresholds || {};
    const minThresholdMin = Math.min(
        t.online ?? 5,
        t.idle   ?? 15,
        t.dnd    ?? 30,
    );
    const intervalMs = Math.round((minThresholdMin * 60_000) / 4);
    return Math.min(Math.max(intervalMs, 15_000), 300_000);
}

/**
 * Start the autonomous messaging timer.
 */
export function startAutonomousTimer() {
    stopAutonomousTimer();

    const settings = getSettings();
    if (!settings.autonomousEnabled) return;
    if (!hasCharacter()) return;

    const intervalMs = _getTimerInterval();
    autonomousTimer = setInterval(checkAndSend, intervalMs);
    log.info(`Autonomous timer started (interval: ${Math.round(intervalMs / 1000)}s).`);

    // Listen for manual status changes so we can react immediately to offline→online
    try {
        const context = SillyTavern.getContext();
        if (context?.eventSource) {
            _statusChangedListener = _onStatusChanged;
            context.eventSource.on('textme:statusChanged', _statusChangedListener);
            log.debug('Autonomous: subscribed to textme:statusChanged.');
        }
    } catch (e) { /* ignore */ }
}

/**
 * Stop the autonomous messaging timer.
 */
export function stopAutonomousTimer() {
    if (autonomousTimer) {
        clearInterval(autonomousTimer);
        autonomousTimer = null;
        log.info('Autonomous timer stopped.');
    }
    if (autonomousAbortController) {
        autonomousAbortController.abort();
        autonomousAbortController = null;
    }

    // Unsubscribe from status change events
    if (_statusChangedListener) {
        try {
            const context = SillyTavern.getContext();
            if (context?.eventSource) {
                context.eventSource.removeListener('textme:statusChanged', _statusChangedListener);
                log.debug('Autonomous: unsubscribed from textme:statusChanged.');
            }
        } catch (e) { /* ignore */ }
        _statusChangedListener = null;
    }
}

// ─────────────────────────────────────────────────────────
// Status change handler
// ─────────────────────────────────────────────────────────

/**
 * Called when the user manually changes the character's status.
 * If the transition is offline → not-offline and there's an unanswered
 * user message, trigger checkAndSend immediately without waiting for
 * the next timer tick.
 *
 * @param {{ prev: string|null, next: string|null }} event
 */
async function _onStatusChanged({ prev, next }) {
    log.debug(`Autonomous: status changed ${prev ?? 'schedule'} → ${next ?? 'schedule'}`);

    const prevWasOffline = prev === 'offline';
    const nextIsOffline  = next === 'offline';

    // Only react when coming back from offline
    if (!prevWasOffline || nextIsOffline) return;

    const settings = getSettings();
    if (!settings.enabled || !settings.autonomousEnabled) return;
    if (!hasCharacter()) return;

    const phoneData = getPhoneData();
    if (!phoneData) return;

    // Check if there's an unanswered user message
    const messages = phoneData.messages ?? [];
    const hasUnanswered = _isLastUserMsgUnanswered(messages);
    if (!hasUnanswered) {
        log.debug('Autonomous: came online but no unanswered user message — skipping.');
        return;
    }

    log.info('Autonomous: came back online with unanswered message — scheduling immediate reply.');

    // Small delay: character "picks up the phone" after coming online
    const delayMs = 3000 + Math.random() * 4000; // 3–7 seconds
    await new Promise(r => setTimeout(r, delayMs));

    // Clear the snapshot so checkAndSend doesn't wait for the old threshold
    phoneData.autonomousWaitThreshold = null;
    phoneData.autonomousWaitSince = null;
    phoneData.autonomousErrorBackoff = null;

    // Reset lastActivity to now so elapsed check passes immediately
    phoneData.lastActivity = Date.now() - 1;
    await savePhoneData();

    await checkAndSend();
}

/**
 * Returns true if the last message in the array is from the user
 * (i.e. the character hasn't replied yet).
 *
 * @param {Array} messages
 * @returns {boolean}
 */
function _isLastUserMsgUnanswered(messages) {
    if (!messages?.length) return false;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (!messages[i].isUser) return false;
        if (messages[i].isUser)  return true;
    }
    return false;
}

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

/**
 * Returns true when an error is a cancellation/abort — either our own
 * controller or ST's global stop event leaking through.
 */
function isCancelError(err) {
    if (!err) return false;
    if (err.name === 'AbortError') return true;
    const msg = (err.message || '').toLowerCase();
    return msg.includes('cancel') || msg.includes('abort') || msg.includes('stop');
}

/**
 * Resolve the effective inactivity threshold in ms for a given status.
 * Applies cooldown escalation (2^count) capped at cooldownCap.
 *
 * @param {'online'|'idle'|'dnd'} status
 * @param {number} count  current autonomousCount
 * @param {object} settings
 * @returns {number} threshold in milliseconds
 */
function _resolveThreshold(status, count, settings) {
    const thresholds = settings.autonomousThresholds || {};
    const defaults   = { online: 5, idle: 15, dnd: 30 };
    const baseMin    = thresholds[status] ?? defaults[status] ?? 5;
    const capMin     = settings.cooldownCap ?? 120;

    let effectiveMin = baseMin;
    if (settings.cooldownEscalation && count > 0) {
        effectiveMin = baseMin * Math.pow(2, count);
    }
    // Apply cap
    effectiveMin = Math.min(effectiveMin, capMin);
    return effectiveMin * 60_000;
}

// ─────────────────────────────────────────────────────────
// Core check
// ─────────────────────────────────────────────────────────

/**
 * Check if conditions are met and send an autonomous message.
 */
async function checkAndSend() {
    if (isAutonomousGenerating) return;

    const settings = getSettings();
    if (!settings.enabled) return;
    if (!settings.autonomousEnabled) return;
    if (!hasCharacter()) return;

    const phoneData = getPhoneData();
    if (!phoneData) return;

    // Error backoff: don't retry until the backoff window expires
    if (phoneData.autonomousErrorBackoff && Date.now() < phoneData.autonomousErrorBackoff) {
        const remainS = Math.round((phoneData.autonomousErrorBackoff - Date.now()) / 1000);
        log.debug(`Autonomous: error backoff active, ${remainS}s remaining.`);
        return;
    }

    const { status } = getCurrentStatus();
    if (status === 'offline') return;

    const maxFollowups = settings.maxFollowups ?? 3;
    if (phoneData.autonomousCount >= maxFollowups) return;

    if (!phoneData.lastActivity) {
        phoneData.lastActivity = Date.now();
        await savePhoneData();
        return;
    }

    const now     = Date.now();
    const elapsed = now - phoneData.lastActivity;

    // ── Snapshot threshold ──────────────────────────────────────────────────
    let threshold;
    if (phoneData.autonomousWaitThreshold && phoneData.autonomousWaitSince) {
        threshold = phoneData.autonomousWaitThreshold;
    } else {
        threshold = _resolveThreshold(status, phoneData.autonomousCount, settings);
    }

    log.debug(
        `Autonomous check: elapsed=${Math.round(elapsed / 1000)}s, ` +
        `threshold=${Math.round(threshold / 1000)}s, ` +
        `count=${phoneData.autonomousCount}/${maxFollowups}, ` +
        `status=${status}` +
        (phoneData.autonomousWaitThreshold ? ' [snapshot]' : '')
    );

    // Bypass threshold if there's an unanswered user message
    const unanswered = _isLastUserMsgUnanswered(phoneData.messages ?? []);
    if (elapsed < threshold && !unanswered) {
        if (!phoneData.autonomousWaitThreshold) {
            phoneData.autonomousWaitThreshold = threshold;
            phoneData.autonomousWaitSince = now;
            await savePhoneData();
        }
        return;
    }

    if (elapsed < threshold && unanswered) {
        log.info('Autonomous: unanswered user message detected — bypassing threshold.');
    }

    // ── Threshold crossed → generate ───────────────────────────────────────
    isAutonomousGenerating = true;
    autonomousAbortController = new AbortController();

    const clearedThreshold = phoneData.autonomousWaitThreshold;
    phoneData.autonomousWaitThreshold = null;
    phoneData.autonomousWaitSince = null;

    try {
        log.info(
            `Autonomous message #${phoneData.autonomousCount + 1} ` +
            `(elapsed: ${Math.round(elapsed / 1000)}s, threshold: ${Math.round((clearedThreshold ?? threshold) / 1000)}s)`
        );
        const parts = await generateAutonomousMessage(autonomousAbortController.signal);
        await addExternalMessages(parts);

        phoneData.autonomousCount = (phoneData.autonomousCount || 0) + 1;
        phoneData.lastActivity = Date.now();
        phoneData.autonomousErrorBackoff = null;
        await savePhoneData();

        if (document.hidden) {
            const charName = (SillyTavern.getContext().characters?.[SillyTavern.getContext().characterId]?.name) || 'TextMe';
            showBrowserNotification(charName, parts.join(' ').substring(0, 100));
        }

        log.info('Autonomous message sent successfully.');
        startAutonomousTimer();
    } catch (err) {
        if (isCancelError(err)) {
            log.info('Autonomous generation cancelled (stop event or manual abort).');
            phoneData.autonomousWaitThreshold = clearedThreshold ?? threshold;
            phoneData.autonomousWaitSince = phoneData.autonomousWaitSince || now;
        } else {
            log.error('Autonomous message failed:', err);
            const backoffMs = 5 * 60_000;
            phoneData.autonomousErrorBackoff = Date.now() + backoffMs;
            phoneData.autonomousWaitThreshold = null;
            phoneData.autonomousWaitSince = null;
            log.info(`Autonomous error backoff active for ${backoffMs / 60_000} min.`);
        }
        await savePhoneData();
    } finally {
        isAutonomousGenerating = false;
        autonomousAbortController = null;
    }
}

/**
 * Clear the wait snapshot. Call this whenever the user sends a message,
 * so the next autonomous check starts a fresh threshold calculation.
 */
export function resetAutonomousWait(phoneData) {
    if (!phoneData) return;
    phoneData.autonomousWaitThreshold = null;
    phoneData.autonomousWaitSince = null;
    phoneData.autonomousErrorBackoff = null;
}
