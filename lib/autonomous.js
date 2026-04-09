/**
 * TextMe — Autonomous messaging system
 * License: AGPL-3.0
 *
 * FIX: lastActivity initialized to Date.now() instead of null.
 * FIX: settings.enabled guard in checkAndSend.
 * FIX: startAutonomousTimer() also called from initPhoneUI().
 *
 * FIX: Generation isolation.
 *   Each autonomous generation owns its own AbortController so it can be
 *   cancelled independently from the ST main-chat Stop button.
 *   If ST's stop event aborts the request anyway (older ST versions),
 *   the error is silently logged as info — no error toast shown to the user.
 */

import { getSettings, getPhoneData, savePhoneData, hasCharacter } from './state.js';
import { generateAutonomousMessage } from './prompt-engine.js';
import { getCurrentStatus } from './schedule.js';
import { addExternalMessages, isPhoneOpen } from './phone-ui.js';
import { log } from './logger.js';

let autonomousTimer = null;
let isAutonomousGenerating = false;

/** AbortController for the currently-running autonomous generation. */
let autonomousAbortController = null;

/**
 * Start the autonomous messaging timer.
 */
export function startAutonomousTimer() {
    stopAutonomousTimer();

    const settings = getSettings();
    if (!settings.autonomousEnabled) return;
    if (!hasCharacter()) return;

    autonomousTimer = setInterval(checkAndSend, 30000);
    log.info('Autonomous timer started.');
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
    // Also abort any in-flight autonomous generation
    if (autonomousAbortController) {
        autonomousAbortController.abort();
        autonomousAbortController = null;
    }
}

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

    const { status } = getCurrentStatus();
    if (status === 'offline') return;

    const maxFollowups = settings.maxFollowups || 3;
    if (phoneData.autonomousCount >= maxFollowups) return;

    if (!phoneData.lastActivity) {
        phoneData.lastActivity = Date.now();
        await savePhoneData();
        return;
    }

    const lastActivity    = phoneData.lastActivity;
    const now             = Date.now();
    const thresholdMs     = (settings.inactivityThreshold || 5) * 60 * 1000;

    let effectiveThreshold = thresholdMs;
    if (settings.cooldownEscalation && phoneData.autonomousCount > 0) {
        effectiveThreshold = thresholdMs * Math.pow(2, phoneData.autonomousCount);
    }

    if (status === 'dnd') {
        effectiveThreshold *= 3;
    }

    const elapsed = now - lastActivity;

    log.debug(`Autonomous check: elapsed=${Math.round(elapsed/1000)}s, threshold=${Math.round(effectiveThreshold/1000)}s, count=${phoneData.autonomousCount}/${maxFollowups}, status=${status}`);

    if (elapsed < effectiveThreshold) return;

    isAutonomousGenerating = true;
    autonomousAbortController = new AbortController();

    try {
        log.info(`Autonomous message #${phoneData.autonomousCount + 1} (elapsed: ${Math.round(elapsed / 1000)}s, threshold: ${Math.round(effectiveThreshold / 1000)}s)`);

        const parts = await generateAutonomousMessage(autonomousAbortController.signal);

        await addExternalMessages(parts);

        phoneData.autonomousCount = (phoneData.autonomousCount || 0) + 1;
        phoneData.lastActivity    = Date.now();
        await savePhoneData();

        if (document.hidden && settings.soundEffects) {
            sendNotification(parts.join(' '));
        }

        log.info('Autonomous message sent successfully.');
    } catch (err) {
        if (isCancelError(err)) {
            // ST Stop button or our own abort — not an error, just silently note it
            log.info('Autonomous generation cancelled (stop event or manual abort).');
        } else {
            log.error('Autonomous message failed:', err);
        }
    } finally {
        isAutonomousGenerating = false;
        autonomousAbortController = null;
    }
}

/**
 * Send a browser push notification.
 */
function sendNotification(text) {
    if (!('Notification' in window)) return;

    if (Notification.permission === 'granted') {
        new Notification('TextMe 📱', {
            body: text.substring(0, 100),
            icon: '/img/ai4.png',
            tag: 'textme-autonomous',
        });
    } else if (Notification.permission !== 'denied') {
        Notification.requestPermission().then(p => {
            if (p === 'granted') {
                new Notification('TextMe 📱', {
                    body: text.substring(0, 100),
                    icon: '/img/ai4.png',
                    tag: 'textme-autonomous',
                });
            }
        });
    }
}
