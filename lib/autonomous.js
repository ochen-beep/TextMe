/**
 * TextMe — Autonomous messaging system
 * License: AGPL-3.0
 *
 * Sends unsolicited messages from the character based on:
 * - Inactivity threshold
 * - Character's current status (from schedule)
 * - Escalation with cooldown
 */

import { getSettings, getPhoneData, savePhoneData, hasCharacter } from './state.js';
import { generateAutonomousMessage } from './prompt-engine.js';
import { getCurrentStatus } from './schedule.js';
import { addExternalMessages, isPhoneOpen } from './phone-ui.js';
import { log } from './logger.js';

let autonomousTimer = null;
let isAutonomousGenerating = false;

/**
 * Start the autonomous messaging timer.
 */
export function startAutonomousTimer() {
    stopAutonomousTimer();

    const settings = getSettings();
    if (!settings.autonomousEnabled) return;
    if (!hasCharacter()) return;

    // Check every 30 seconds
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
}

/**
 * Check if conditions are met and send an autonomous message.
 */
async function checkAndSend() {
    if (isAutonomousGenerating) return;

    const settings = getSettings();
    if (!settings.autonomousEnabled) return;
    if (!hasCharacter()) return;

    const phoneData = getPhoneData();
    if (!phoneData) return;

    // Check status
    const { status } = getCurrentStatus();
    if (status === 'offline') return; // Never send when offline

    // Check follow-up limit
    const maxFollowups = settings.maxFollowups || 3;
    if (phoneData.autonomousCount >= maxFollowups) return;

    // Check inactivity threshold
    const lastActivity = phoneData.lastActivity || 0;
    const now = Date.now();
    const thresholdMs = (settings.inactivityThreshold || 5) * 60 * 1000;

    // Escalation: multiply threshold by 2^autonomousCount if cooldown enabled
    let effectiveThreshold = thresholdMs;
    if (settings.cooldownEscalation && phoneData.autonomousCount > 0) {
        effectiveThreshold = thresholdMs * Math.pow(2, phoneData.autonomousCount);
    }

    // DND: triple the threshold
    if (status === 'dnd') {
        effectiveThreshold *= 3;
    }

    const elapsed = now - lastActivity;
    if (elapsed < effectiveThreshold) return;

    // All conditions met — generate and send
    isAutonomousGenerating = true;

    try {
        log.info(`Autonomous message #${phoneData.autonomousCount + 1} (elapsed: ${Math.round(elapsed / 1000)}s, threshold: ${Math.round(effectiveThreshold / 1000)}s)`);

        const parts = await generateAutonomousMessage();

        // Save messages via phone UI
        await addExternalMessages(parts);

        // Update counters
        phoneData.autonomousCount = (phoneData.autonomousCount || 0) + 1;
        phoneData.lastActivity = Date.now();
        await savePhoneData();

        // Send browser notification if tab is in background
        if (document.hidden && settings.soundEffects) {
            sendNotification(parts.join(' '));
        }

        log.info('Autonomous message sent successfully.');
    } catch (err) {
        log.error('Autonomous message failed:', err);
    } finally {
        isAutonomousGenerating = false;
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

/**
 * Reset the autonomous counter (called when user sends a message).
 */
export function resetAutonomousCounter() {
    const phoneData = getPhoneData();
    if (phoneData) {
        phoneData.autonomousCount = 0;
    }
}
