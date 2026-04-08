/**
 * TextMe — SillyTavern event handlers
 * License: AGPL-3.0
 */

import { EXTENSION_NAME, getSettings, getPhoneData, hasCharacter } from './state.js';
import { initPhoneUI, destroyPhoneUI, reloadPhoneData } from './phone-ui.js';
import { startAutonomousTimer, stopAutonomousTimer } from './autonomous.js';
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

    // Log phone data state
    const phoneData = getPhoneData();
    if (phoneData) {
        log.info(`Chat changed. Phone messages: ${phoneData.messages.length}`);
    }
}
