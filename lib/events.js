// TextMe — SillyTavern event handlers
// License: AGPL-3.0

import { getContext } from '../../../../extensions.js';
import { eventSource, event_types } from '../../../../script.js';
import { EXTENSION_NAME, getSettings, getPhoneData } from './state.js';
import { initPhoneUI, destroyPhoneUI } from './phone-ui.js';

// ═══════════════════════════════════════════════
// Event binding
// ═══════════════════════════════════════════════

export function bindEvents() {
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    console.log(`[${EXTENSION_NAME}] Events bound.`);
}

export function unbindEvents() {
    eventSource.off(event_types.CHAT_CHANGED, onChatChanged);
    console.log(`[${EXTENSION_NAME}] Events unbound.`);
}

// ═══════════════════════════════════════════════
// Handlers
// ═══════════════════════════════════════════════

function onChatChanged() {
    const settings = getSettings();
    const context = getContext();

    if (!settings.enabled || context.characterId === undefined) {
        destroyPhoneUI();
        return;
    }

    // Reinitialize phone UI for the new chat
    destroyPhoneUI();
    initPhoneUI();

    // Load phone data for this chat
    const phoneData = getPhoneData();
    if (phoneData) {
        console.log(`[${EXTENSION_NAME}] Chat changed. Phone messages: ${phoneData.messages.length}`);
    }
}
