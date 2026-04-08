/**
 * TextMe — SillyTavern Phone Messenger Extension
 * License: AGPL-3.0
 *
 * Entry point: loaded as ES module by SillyTavern extension system.
 */

import { EXTENSION_NAME, DEFAULT_SETTINGS, getSettings, getPhoneData, savePhoneData } from './lib/state.js';
import { loadSettingsUI } from './lib/settings-ui.js';
import { initPhoneUI, destroyPhoneUI } from './lib/phone-ui.js';
import { bindEvents, unbindEvents } from './lib/events.js';
import { registerCommands } from './lib/commands.js';

// Derive folder path from module URL (works regardless of actual folder name).
const extensionFolderPath = new URL('.', import.meta.url).pathname.replace(/\/$/, '');

/**
 * Main initialization — runs when ST is ready.
 */
async function init() {
    const context = SillyTavern.getContext();
    console.log(`[${EXTENSION_NAME}] Initializing...`, 'Path:', extensionFolderPath);

    // Ensure settings are initialized
    if (!context.extensionSettings[EXTENSION_NAME]) {
        context.extensionSettings[EXTENSION_NAME] = structuredClone(DEFAULT_SETTINGS);
    }

    // Inject settings panel HTML
    try {
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $('#extensions_settings2').append(settingsHtml);
    } catch (e) {
        console.error(`[${EXTENSION_NAME}] Failed to load settings HTML:`, e);
    }

    // Load settings UI (dropdowns, toggles, prompt fields)
    loadSettingsUI();

    // Register slash commands
    registerCommands();

    // Bind SillyTavern events
    bindEvents();

    // If phone was active in previous session, restore it
    const settings = getSettings();
    if (settings.enabled && context.characterId !== undefined) {
        initPhoneUI();
    }

    console.log(`[${EXTENSION_NAME}] Extension loaded.`);
}

// Bootstrap via APP_READY (auto-fires for late listeners)
(function bootstrap() {
    const { eventSource, event_types } = SillyTavern.getContext();
    eventSource.on(event_types.APP_READY, () => {
        init();
    });
})();
