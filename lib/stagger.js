/**
 * TextMe — Staggered message reveal
 * License: AGPL-3.0
 *
 * Adapted from stc/src/features/stagger.js.
 *
 * Replaces the simple sleep-loop in phone-ui.js streamMessages() with a
 * proper stagger that:
 *  - Uses an AbortController so the user can skip reveal by clicking the
 *    typing indicator.
 *  - Exposes cancelStagger() so abort from external code (destroy, etc.)
 *    shows all remaining parts instantly rather than just stopping mid-way.
 *  - Delay formula: same as before (600 + len*20, max 2000) + random ±500 ms.
 */

import { getSettings } from './state.js';
import { log } from './logger.js';

/** AbortController for the currently-running stagger. Module-level singleton. */
let staggerAbort = null;
let isStaggering = false;

/**
 * Stream multiple message parts into the phone UI with typing-indicator
 * delays between them.
 *
 * @param {string[]} parts       - Message texts to stream.
 * @param {object}   phoneData   - Live phoneData reference.
 * @param {Function} appendFn    - appendMessage(msg, index) from phone-ui.
 * @param {Function} showTyping  - showTyping() from phone-ui.
 * @param {Function} hideTyping  - hideTyping() from phone-ui.
 * @param {Function} saveFn      - savePhoneData() async.
 * @returns {Promise<void>}
 */
export async function staggerMessages(parts, phoneData, appendFn, showTyping, hideTyping, saveFn) {
    if (!parts || parts.length === 0) return;

    // Cancel any previous stagger first
    cancelStagger();

    const abort = new AbortController();
    staggerAbort = abort;
    isStaggering = true;

    try {
        for (let i = 0; i < parts.length; i++) {
            // Check abort before processing each part
            if (abort.signal.aborted) {
                // Show all remaining parts immediately
                _flushRemaining(parts, i, phoneData, appendFn);
                break;
            }

            const text = parts[i];

            // Typing indicator between parts (skip before first part)
            if (i > 0) {
                showTyping();
                const delay = Math.min(600 + text.length * 20, 2000) + Math.random() * 500;
                try {
                    await _waitWithAbort(delay, abort.signal);
                } catch {
                    // Aborted during wait — flush remaining and stop
                    hideTyping();
                    _flushRemaining(parts, i, phoneData, appendFn);
                    break;
                }
                hideTyping();
            }

            const msg = { isUser: false, text, time: Date.now() };
            phoneData.messages.push(msg);
            appendFn(msg, phoneData.messages.length - 1);

            // Small breath between parts so DOM updates
            if (i < parts.length - 1) {
                await _sleep(50);
            }
        }
    } finally {
        isStaggering = false;
        staggerAbort = null;

        phoneData.lastActivity    = Date.now();
        phoneData.autonomousCount = 0;
        await saveFn();
    }
}

/**
 * Cancel an in-progress stagger (aborts wait, shows remaining immediately).
 */
export function cancelStagger() {
    if (staggerAbort) {
        staggerAbort.abort();
        staggerAbort = null;
    }
    isStaggering = false;
}

/** Whether a stagger is currently running. */
export function isStaggerActive() {
    return isStaggering;
}

// ─── internal helpers ───────────────────────────────────────────────────────

function _flushRemaining(parts, fromIndex, phoneData, appendFn) {
    for (let i = fromIndex; i < parts.length; i++) {
        const msg = { isUser: false, text: parts[i], time: Date.now() };
        phoneData.messages.push(msg);
        appendFn(msg, phoneData.messages.length - 1);
    }
}

function _waitWithAbort(ms, signal) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
    });
}

function _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
