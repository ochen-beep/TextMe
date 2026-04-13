/**
 * TextMe — SillyTavern event handlers
 * License: AGPL-3.0
 *
 * FIX: invalidatePhoneDataCache() called BEFORE initPhoneUI() on CHAT_CHANGED.
 * This ensures _lastPhoneData from the previous chat is cleared so getPhoneData()
 * reads fresh data from the new chat's context.chat_metadata instead of
 * returning stale cached data from the old chat.
 */

import { EXTENSION_NAME, getSettings, getPhoneData, hasCharacter, invalidatePhoneDataCache } from './state.js';
import { initPhoneUI, destroyPhoneUI } from './phone-ui.js';
import { renderScheduleEditor } from './schedule.js';
import { initCustomTime, stopCustomTime, advanceTimeOnMessage } from './custom-time.js';
import { log } from './logger.js';

let eventsBound = false;

export function bindEvents() {
    if (eventsBound) return;
    const { eventSource, event_types } = SillyTavern.getContext();
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

    // Advance game time on every user message sent
    if (event_types.MESSAGE_SENT) {
        eventSource.on(event_types.MESSAGE_SENT, onMessageSent);
    }

    eventsBound = true;
    log.info('Events bound.');
}

export function unbindEvents() {
    if (!eventsBound) return;
    const { eventSource, event_types } = SillyTavern.getContext();
    eventSource.off(event_types.CHAT_CHANGED, onChatChanged);
    if (event_types.MESSAGE_SENT) {
        eventSource.off(event_types.MESSAGE_SENT, onMessageSent);
    }
    eventsBound = false;
}

// ═══════════════════════════════════════════════
// Handlers
// ═══════════════════════════════════════════════

function onChatChanged() {
    const settings = getSettings();

    // CRITICAL: clear stale cache BEFORE any UI init so the new chat's
    // chatMetadata is read fresh from context, not from the old chat's cache.
    invalidatePhoneDataCache();

    // Stop custom time from previous chat
    stopCustomTime();

    if (!settings.enabled || !hasCharacter()) {
        destroyPhoneUI(); // also calls stopAutonomousTimer() internally
        return;
    }

    // Reinitialize phone UI for the new chat
    // destroyPhoneUI stops the timer; initPhoneUI restarts it if autonomousEnabled
    destroyPhoneUI();
    initPhoneUI();

    // Init game time for the new chat
    initCustomTime();

    // Schedule is per-chat — refresh the settings panel editor
    const editorEl = document.getElementById('textme_schedule_editor');
    if (editorEl) {
        renderScheduleEditor(editorEl);
    }

    const phoneData = getPhoneData();
    log.info(`Chat changed. Phone messages: ${phoneData?.messages?.length ?? 0}, schedule: ${phoneData?.schedule ? 'yes' : 'no'}`);
}

function onMessageSent() {
    // Advance game time (per-message mode)
    advanceTimeOnMessage();
}
