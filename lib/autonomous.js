/**
 * TextMe — Autonomous messaging system
 * License: AGPL-3.0
 *
 * v1.3.0 changes:
 *   - Per-status thresholds (online / idle / dnd) instead of a single inactivityThreshold.
 *   - cooldownCap: maximum effective threshold in minutes (prevents infinite escalation).
 *   - Snapshot fix: threshold is determined once when inactivity begins and stored in
 *     phoneData.autonomousWaitThreshold. This prevents the bug where a schedule change
 *     mid-wait would cause a sudden threshold drop and premature firing.
 *   - Error backoff: after a failed generation, skip retries for 5 minutes.
 *   - Adaptive timer interval: re-evaluates every ~1/4 of the minimum threshold,
 *     so low thresholds get tighter polling and high thresholds don't waste cycles.
 *   - idle status now gets its own threshold (was identical to online before).
 */

import { getSettings, getPhoneData, savePhoneData, hasCharacter } from './state.js';
import { generateAutonomousMessage } from './prompt-engine.js';
import { getCurrentStatus } from './schedule.js';
import { addExternalMessages, isPhoneOpen } from './phone-ui.js';
import { showBrowserNotification } from './notifications.js';
import { log } from './logger.js';

let autonomousTimer   = null;
let isAutonomousGenerating = false;

/** AbortController for the currently-running autonomous generation. */
let autonomousAbortController = null;

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
 * @param {number} count   current autonomousCount
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

    if (!settings.enabled)           return;
    if (!settings.autonomousEnabled) return;
    if (!hasCharacter())             return;

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

    const now      = Date.now();
    const elapsed  = now - phoneData.lastActivity;

    // ── Snapshot threshold ────────────────────────────────────────────────────
    // On the first tick where the character is "overdue", record the threshold
    // that was in effect at that moment. Subsequent ticks reuse this snapshot so
    // a schedule change mid-wait cannot shrink the threshold and fire prematurely.
    //
    // The snapshot is cleared when:
    //   - the user sends a message        (handleSend / handleSilentSend)
    //   - an autonomous message fires     (below)
    //   - the chat changes               (events.js → stopAutonomousTimer resets everything)
    // ─────────────────────────────────────────────────────────────────────────

    let threshold;

    if (phoneData.autonomousWaitThreshold && phoneData.autonomousWaitSince) {
        // Re-use the snapshot established on a previous tick
        threshold = phoneData.autonomousWaitThreshold;
    } else {
        // No snapshot yet — compute fresh threshold for current status/count
        threshold = _resolveThreshold(status, phoneData.autonomousCount, settings);
    }

    log.debug(
        `Autonomous check: elapsed=${Math.round(elapsed / 1000)}s, ` +
        `threshold=${Math.round(threshold / 1000)}s, ` +
        `count=${phoneData.autonomousCount}/${maxFollowups}, ` +
        `status=${status}` +
        (phoneData.autonomousWaitThreshold ? ' [snapshot]' : '')
    );

    if (elapsed < threshold) {
        // Not ready yet — establish/keep the snapshot
        if (!phoneData.autonomousWaitThreshold) {
            phoneData.autonomousWaitThreshold = threshold;
            phoneData.autonomousWaitSince     = now;
            await savePhoneData();
        }
        return;
    }

    // ── Threshold crossed → generate ─────────────────────────────────────────

    isAutonomousGenerating        = true;
    autonomousAbortController     = new AbortController();

    // Clear the snapshot immediately so it doesn't survive past this generation
    const clearedThreshold = phoneData.autonomousWaitThreshold;
    phoneData.autonomousWaitThreshold = null;
    phoneData.autonomousWaitSince     = null;

    try {
        log.info(
            `Autonomous message #${phoneData.autonomousCount + 1} ` +
            `(elapsed: ${Math.round(elapsed / 1000)}s, threshold: ${Math.round((clearedThreshold ?? threshold) / 1000)}s)`
        );

        const parts = await generateAutonomousMessage(autonomousAbortController.signal);

        await addExternalMessages(parts);

        phoneData.autonomousCount = (phoneData.autonomousCount || 0) + 1;
        phoneData.lastActivity    = Date.now();
        // Clear any lingering error backoff on success
        phoneData.autonomousErrorBackoff = null;
        await savePhoneData();

        if (document.hidden) {
            // addExternalMessages already played the sound; show browser notification if tab is hidden
            const charName = (SillyTavern.getContext().characters?.[SillyTavern.getContext().characterId]?.name) || 'TextMe';
            showBrowserNotification(charName, parts.join(' ').substring(0, 100));
        }

        log.info('Autonomous message sent successfully.');

        // Restart timer with potentially updated interval (settings may have changed)
        startAutonomousTimer();

    } catch (err) {
        if (isCancelError(err)) {
            log.info('Autonomous generation cancelled (stop event or manual abort).');
            // On cancel: restore snapshot so we retry at the right time
            phoneData.autonomousWaitThreshold = clearedThreshold ?? threshold;
            phoneData.autonomousWaitSince     = phoneData.autonomousWaitSince || now;
        } else {
            log.error('Autonomous message failed:', err);
            // Set error backoff: don't retry for 5 minutes
            const backoffMs = 5 * 60_000;
            phoneData.autonomousErrorBackoff = Date.now() + backoffMs;
            // Also clear snapshot — we'll re-evaluate after the backoff
            phoneData.autonomousWaitThreshold = null;
            phoneData.autonomousWaitSince     = null;
            log.info(`Autonomous error backoff active for ${backoffMs / 60_000} min.`);
        }
        await savePhoneData();
    } finally {
        isAutonomousGenerating    = false;
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
    phoneData.autonomousWaitSince     = null;
    phoneData.autonomousErrorBackoff  = null;
}
