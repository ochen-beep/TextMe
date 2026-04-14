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
 *
 * FIX: Race condition between autonomous and regular generation.
 *   checkAndSend() now checks isPhoneGenerating() (shared mutex in state.js)
 *   before starting any autonomous generation. This prevents the scenario where
 *   the autonomous timer tick fires during the responseDelay window of handleSend()
 *   and both paths send API requests simultaneously, producing duplicate responses.
 *
 * FIX: In-flight autonomous request not aborted when user sends a message.
 *   The mutex (isPhoneGenerating) correctly blocked NEW autonomous ticks, but
 *   an already-in-flight autonomous API call was never cancelled. If the user
 *   sent a message 0.2s after autonomous started its API request, the autonomous
 *   response would arrive ~2 minutes later and render on top of the regular
 *   response, producing a semantic duplicate.
 *
 *   abortAutonomousGeneration() is now exported and called by phone-ui.js
 *   inside handleSend() right before setPhoneGenerating(true). It aborts only
 *   the current API call; the timer keeps running. The existing catch(isCancelError)
 *   path preserves the threshold snapshot so autonomous resumes cleanly after
 *   the regular response cycle finishes.
 *
 * FIX: Silent send no longer bypasses autonomous inactivity threshold.
 *   handleSilentSend() saves the user message but does NOT set isPhoneGenerating,
 *   so the next autonomous tick saw unanswered=true and bypassed the threshold,
 *   firing a parallel generation alongside the immediately following handleSend().
 *
 *   _isLastUserMsgUnanswered() now returns false when the last user message has
 *   silent=true. Autonomous treats a silent send like a char reply for threshold
 *   purposes — it waits the full configured threshold before texting unprompted.
 *   The isPhoneGenerating() guard still handles the handleSend() overlap case.
 *
 * v1.6.0 logging:
 *   — startAutonomousTimer: logs new interval when restarted after successful generation
 *   — resetAutonomousWait: logs when called and from where (via caller name in log)
 */

import { getSettings, getPhoneData, savePhoneData, hasCharacter, isPhoneGenerating } from './state.js';
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
 * @param {boolean} [afterSuccess=false] - if true, log a "restarted after success" message
 */
export function startAutonomousTimer(afterSuccess = false) {
    stopAutonomousTimer();

    const settings = getSettings();
    if (!settings.autonomousEnabled) return;
    if (!hasCharacter()) return;

    const intervalMs = _getTimerInterval();
    autonomousTimer = setInterval(checkAndSend, intervalMs);

    if (afterSuccess) {
        log.info(`[Autonomous] Timer restarted after successful generation — polling every ${Math.round(intervalMs / 1000)}s.`);
    } else {
        log.info(`[Autonomous] Timer started — polling every ${Math.round(intervalMs / 1000)}s.`);
    }

    // Listen for manual status changes so we can react immediately to offline→online
    try {
        const context = SillyTavern.getContext();
        if (context?.eventSource) {
            _statusChangedListener = _onStatusChanged;
            context.eventSource.on('textme:statusChanged', _statusChangedListener);
            log.debug('[Autonomous] Subscribed to textme:statusChanged.');
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
        log.info('[Autonomous] Timer stopped.');
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
                log.debug('[Autonomous] Unsubscribed from textme:statusChanged.');
            }
        } catch (e) { /* ignore */ }
        _statusChangedListener = null;
    }
}

/**
 * Abort only the currently in-flight autonomous API request, without
 * stopping the timer. The threshold snapshot is preserved by the
 * catch(isCancelError) path in checkAndSend(), so autonomous resumes
 * normally on the next tick after the regular generation completes.
 *
 * Called by phone-ui.js → handleSend() before setPhoneGenerating(true),
 * so that an autonomous request that was already in flight when the user
 * typed a message gets cancelled immediately rather than delivering a
 * stale response on top of the regular one minutes later.
 */
export function abortAutonomousGeneration() {
    if (autonomousAbortController) {
        autonomousAbortController.abort();
        autonomousAbortController = null;
        log.info('[Autonomous] In-flight generation aborted (user sent a message).');
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
    const prevLabel = prev ?? 'schedule';
    const nextLabel = next ?? 'schedule';
    log.info(`[Autonomous] Status changed: ${prevLabel} → ${nextLabel}`);

    const prevWasOffline = prev === 'offline';
    const nextIsOffline  = next === 'offline';

    // Only react when coming back from offline
    if (!prevWasOffline || nextIsOffline) {
        log.debug(`[Autonomous] Status change ignored (not an offline→online transition).`);
        return;
    }

    const settings = getSettings();
    if (!settings.enabled || !settings.autonomousEnabled) return;
    if (!hasCharacter()) return;

    const phoneData = getPhoneData();
    if (!phoneData) return;

    // Check if there's an unanswered non-silent user message
    const messages = phoneData.messages ?? [];
    const hasUnanswered = _isLastUserMsgUnanswered(messages);
    if (!hasUnanswered) {
        log.info('[Autonomous] Came online — no unanswered user message, skipping immediate reply.');
        return;
    }

    log.info('[Autonomous] Came back online with unanswered message — scheduling immediate reply in 3–7s.');

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
 * Returns true if the last message in the array is a regular (non-silent)
 * user message with no character reply after it.
 *
 * Silent sends (msg.silent === true) are excluded: handleSilentSend() queues
 * a message without expecting an immediate reply, so autonomous should wait
 * the full configured threshold rather than bypassing it immediately.
 *
 * @param {Array} messages
 * @returns {boolean}
 */
function _isLastUserMsgUnanswered(messages) {
    if (!messages?.length) return false;
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        // Character replied — not unanswered
        if (!msg.isUser) return false;
        // Silent send — treat as if char already replied (no bypass)
        if (msg.isUser && msg.silent) return false;
        // Regular user message with no reply after it
        if (msg.isUser) return true;
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

    // FIX: skip if phone-ui.js is already generating a response (handleSend /
    // regenerate). This covers the responseDelay window AND the actual API call,
    // so autonomous never fires a parallel request while the regular path is active.
    if (isPhoneGenerating()) {
        log.debug('[Autonomous] Skipping tick — phone generation in progress.');
        return;
    }

    const settings = getSettings();
    if (!settings.enabled) return;
    if (!settings.autonomousEnabled) return;
    if (!hasCharacter()) return;

    const phoneData = getPhoneData();
    if (!phoneData) return;

    // Error backoff: don't retry until the backoff window expires
    if (phoneData.autonomousErrorBackoff && Date.now() < phoneData.autonomousErrorBackoff) {
        const remainS = Math.round((phoneData.autonomousErrorBackoff - Date.now()) / 1000);
        log.debug(`[Autonomous] Error backoff active — ${remainS}s remaining, skipping tick.`);
        return;
    }

    const { status } = getCurrentStatus();
    if (status === 'offline') {
        log.debug('[Autonomous] Status is offline — skipping tick.');
        return;
    }

    const maxFollowups = settings.maxFollowups ?? 3;
    if (phoneData.autonomousCount >= maxFollowups) {
        log.debug(`[Autonomous] Max follow-ups reached (${phoneData.autonomousCount}/${maxFollowups}) — skipping tick.`);
        return;
    }

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
        `[Autonomous] Tick: elapsed=${Math.round(elapsed / 1000)}s / ` +
        `threshold=${Math.round(threshold / 1000)}s | ` +
        `status=${status}, followups=${phoneData.autonomousCount}/${maxFollowups}` +
        (phoneData.autonomousWaitThreshold ? ' [snapshot]' : '')
    );

    // Bypass threshold only for regular (non-silent) unanswered user messages
    const unanswered = _isLastUserMsgUnanswered(phoneData.messages ?? []);
    if (elapsed < threshold && !unanswered) {
        if (!phoneData.autonomousWaitThreshold) {
            phoneData.autonomousWaitThreshold = threshold;
            phoneData.autonomousWaitSince = now;
            await savePhoneData();
            log.debug(`[Autonomous] Waiting — threshold snapshot saved: ${Math.round(threshold / 60000)}min.`);
        }
        return;
    }

    if (elapsed < threshold && unanswered) {
        log.info('[Autonomous] Unanswered user message detected — bypassing inactivity threshold.');
    }

    // ── Threshold crossed → generate ───────────────────────────────────────
    isAutonomousGenerating = true;
    autonomousAbortController = new AbortController();

    const clearedThreshold = phoneData.autonomousWaitThreshold;
    phoneData.autonomousWaitThreshold = null;
    phoneData.autonomousWaitSince = null;

    try {
        log.info(
            `[Autonomous] Sending message #${phoneData.autonomousCount + 1} ` +
            `(elapsed: ${Math.round(elapsed / 1000)}s, threshold: ${Math.round((clearedThreshold ?? threshold) / 1000)}s, status: ${status})`
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

        log.info(`[Autonomous] Message sent successfully (${parts.length} part(s)). Total follow-ups: ${phoneData.autonomousCount}.`);
        // Pass afterSuccess=true so the restart log message is distinguishable
        // from the initial startAutonomousTimer() call on chat load.
        startAutonomousTimer(true);
    } catch (err) {
        if (isCancelError(err)) {
            log.info('[Autonomous] Generation cancelled (stop button or manual abort) — threshold snapshot preserved.');
            phoneData.autonomousWaitThreshold = clearedThreshold ?? threshold;
            phoneData.autonomousWaitSince = phoneData.autonomousWaitSince || now;
        } else {
            log.error('[Autonomous] Generation failed:', err);
            const backoffMs = 5 * 60_000;
            phoneData.autonomousErrorBackoff = Date.now() + backoffMs;
            phoneData.autonomousWaitThreshold = null;
            phoneData.autonomousWaitSince = null;
            log.info(`[Autonomous] Error backoff set — retries paused for ${backoffMs / 60_000} min.`);
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
    const hadSnapshot = !!(phoneData.autonomousWaitThreshold || phoneData.autonomousWaitSince || phoneData.autonomousErrorBackoff);
    phoneData.autonomousWaitThreshold = null;
    phoneData.autonomousWaitSince = null;
    phoneData.autonomousErrorBackoff = null;
    if (hadSnapshot) {
        log.debug('[Autonomous] resetAutonomousWait — snapshot cleared (user activity detected).');
    }
}
