/**
 * TextMe — Notification sounds & browser notifications
 * License: AGPL-3.0
 *
 * Adapted from stc/src/features/notifications.js.
 *
 * Changes vs stc:
 *  - getSettings() from TextMe state (soundEffects key instead of soundEnabled)
 *  - Extension path points to TextMe folder
 *  - tag changed to 'textme-message'
 *  - soundVolume defaults to 70 (same) but reads from settings if present
 */

import { getSettings } from './state.js';
import { log } from './logger.js';

let audioContext = null;
let notificationBuffer = null;
let lastSoundTime = 0;

/** Minimum ms between notification sounds (prevents stagger spam) */
const SOUND_DEBOUNCE_MS = 800;

/**
 * Initialize the notification system.
 * Pre-loads a sound file; falls back to synthesized tone.
 * Call once from initPhoneUI().
 */
export async function initNotifications() {
    try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();

        const extensionPath = 'scripts/extensions/third-party/TextMe';

        // Try .mp3 first
        try {
            const response = await fetch(`${extensionPath}/assets/notification.mp3`);
            if (response.ok) {
                const arrayBuffer = await response.arrayBuffer();
                notificationBuffer = await audioContext.decodeAudioData(arrayBuffer);
                log.info('Notification sound loaded (mp3).');
                return;
            }
        } catch { /* not found */ }

        // Try .ogg
        try {
            const response = await fetch(`${extensionPath}/assets/notification.ogg`);
            if (response.ok) {
                const arrayBuffer = await response.arrayBuffer();
                notificationBuffer = await audioContext.decodeAudioData(arrayBuffer);
                log.info('Notification sound loaded (ogg).');
                return;
            }
        } catch { /* not found */ }

        // Synthesize a short ping as fallback
        notificationBuffer = _generateSynthTone(audioContext);
        log.info('Using synthesized notification sound.');
    } catch (e) {
        log.warn('Failed to initialize audio:', e);
    }
}

/**
 * Play the notification sound (debounced, respects soundEffects setting).
 */
export function playNotificationSound() {
    const settings = getSettings();
    if (!settings.soundEffects) return;
    if (!audioContext || !notificationBuffer) return;

    const now = Date.now();
    if (now - lastSoundTime < SOUND_DEBOUNCE_MS) return;
    lastSoundTime = now;

    try {
        // Resume AudioContext if suspended (browser autoplay policy)
        if (audioContext.state === 'suspended') {
            audioContext.resume();
        }

        const source = audioContext.createBufferSource();
        source.buffer = notificationBuffer;

        const gainNode = audioContext.createGain();
        // Use soundVolume if present, otherwise default 70%
        gainNode.gain.value = (settings.soundVolume ?? 70) / 100;

        source.connect(gainNode);
        gainNode.connect(audioContext.destination);
        source.start(0);
    } catch (e) {
        log.warn('Failed to play notification sound:', e);
    }
}

/**
 * Show a browser notification (if Notification API available, tab unfocused).
 * @param {string} title
 * @param {string} body
 * @param {string} [icon]
 */
export function showBrowserNotification(title, body, icon) {
    const settings = getSettings();
    if (!settings.browserNotifications) return;
    if (document.hasFocus()) return;
    if (typeof Notification === 'undefined') return;

    if (Notification.permission === 'granted') {
        try {
            const notification = new Notification(title, {
                body: body || '',
                icon: icon || '/img/ai4.png',
                tag: 'textme-message', // replaces previous notification
            });
            setTimeout(() => notification.close(), 5000);
            notification.addEventListener('click', () => {
                window.focus();
                notification.close();
            });
        } catch (e) {
            log.warn('Browser notification failed:', e);
        }
    }
}

/**
 * Request browser notification permission.
 * @returns {Promise<string>}
 */
export async function requestNotificationPermission() {
    if (typeof Notification === 'undefined') return 'denied';
    if (Notification.permission === 'granted') return 'granted';
    return Notification.requestPermission();
}

// ─── internal ───────────────────────────────────────────────────────────────

/**
 * Generate a two-tone synthesized ping (iMessage-style).
 * E6 (1318 Hz) → G6 (1568 Hz), 150 ms, quick decay.
 * @param {AudioContext} ctx
 * @returns {AudioBuffer}
 */
function _generateSynthTone(ctx) {
    const sampleRate = ctx.sampleRate;
    const duration   = 0.15;
    const length     = Math.floor(sampleRate * duration);
    const buffer     = ctx.createBuffer(1, length, sampleRate);
    const data       = buffer.getChannelData(0);

    const freq1   = 1318;
    const freq2   = 1568;
    const halfLen = Math.floor(length / 2);

    for (let i = 0; i < length; i++) {
        const t    = i / sampleRate;
        const freq = i < halfLen ? freq1 : freq2;
        const env  = Math.exp(-t * 12); // quick decay
        data[i]    = Math.sin(2 * Math.PI * freq * t) * env * 0.3;
    }

    return buffer;
}
