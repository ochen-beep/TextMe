/**
 * TextMe — SillyTavern event handlers
 * License: AGPL-3.0
 */

import { EXTENSION_NAME, getSettings, getPhoneData } from './state.js';
import { initPhoneUI, destroyPhoneUI, reloadPhoneData } from './phone-ui.js';

let eventsBound = false;

export function bindEvents() {
    if (eventsBound) return;
    const { eventSource, event_types } = SillyTavern.getContext();

    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

    eventsBound = true;
    console.log(`[${EXTENSION_NAME}] Events bound.`);
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
    const { characterId } = SillyTavern.getContext();

    if (!settings.enabled || characterId === undefined) {
        destroyPhoneUI();
        return;
    }

    // Reinitialize phone UI for the new chat
    destroyPhoneUI();
    initPhoneUI();

    // Log phone data state
    const phoneData = getPhoneData();
    if (phoneData) {
        console.log(`[${EXTENSION_NAME}] Chat changed. Phone messages: ${phoneData.messages.length}`);
    }
}
