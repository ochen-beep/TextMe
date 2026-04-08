/**
 * TextMe — SillyTavern event handlers
 * License: AGPL-3.0
 *
 * FIX (bug-4): onChatChanged now calls renderScheduleEditor() after
 *   reinitializing the phone UI. Schedule is stored per-chat in
 *   chatMetadata, so switching chats must refresh the editor panel
 *   to reflect the new chat's schedule (or show "no schedule" if none).
 */

import { EXTENSION_NAME, getSettings, getPhoneData, hasCharacter } from './state.js';
import { initPhoneUI, destroyPhoneUI, reloadPhoneData } from './phone-ui.js';
import { startAutonomousTimer, stopAutonomousTimer } from './autonomous.js';
import { renderScheduleEditor } from './schedule.js';
import { log } from './logger.js';

let eventsBound = false;

export function bindEvents() {
    if (eventsBound) return;
    const { eventSource, event_types } = SillyTavern.getContext();

    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

    eventsBound = true;
    log.info('Events bound.');
}

export function unbindEvents() {
    if (!eventsBound) return;
    const { eventSource, event_types } = SillyTavern.getContext();

    eventSource.off(event_types.CHAT_CHANGED, onChatChanged);

    eventsBound = false;
}

// ═══════════════════════════════════════════════
// Handlers
// ═══════════════════════════════════════════════

function onChatChanged() {
    const settings = getSettings();

    if (!settings.enabled || !hasCharacter()) {
        destroyPhoneUI();
        stopAutonomousTimer();
        return;
    }

    // Reinitialize phone UI for the new chat
    destroyPhoneUI();
    initPhoneUI();

    // Restart autonomous timer
    if (settings.autonomousEnabled) {
        startAutonomousTimer();
    }

    // FIX bug-4: Schedule is per-chat (stored in chatMetadata).
    // After a chat switch getPhoneData() returns the new chat's data,
    // so the settings panel editor must be re-rendered to show the
    // correct schedule (or the "no schedule" placeholder).
    const editorEl = document.getElementById('textme_schedule_editor');
    if (editorEl) {
        renderScheduleEditor(editorEl);
    }

    // Log phone data state
    const phoneData = getPhoneData();
    if (phoneData) {
        log.info(`Chat changed. Phone messages: ${phoneData.messages.length}`);
    }
}
