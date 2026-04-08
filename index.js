/**
 * TextMe — SillyTavern Phone Messenger Extension
 * License: AGPL-3.0
 *
 * Entry point: loaded as ES module by SillyTavern extension system.
 */

import { EXTENSION_NAME, DEFAULT_SETTINGS, getSettings } from './lib/state.js';
import { loadSettingsUI } from './lib/settings-ui.js';
import { initPhoneUI, destroyPhoneUI } from './lib/phone-ui.js';
import { bindEvents } from './lib/events.js';
import { registerCommands } from './lib/commands.js';

const extensionFolderPath = new URL('.', import.meta.url).pathname.replace(/\/$/, '');

/**
 * Main initialization — runs when ST is ready.
 */
async function init() {
    const context = SillyTavern.getContext();
    console.log(`[${EXTENSION_NAME}] Initializing v0.2.0...`);

    // Ensure settings exist with all default keys
    if (!context.extensionSettings[EXTENSION_NAME]) {
        context.extensionSettings[EXTENSION_NAME] = structuredClone(DEFAULT_SETTINGS);
    } else {
        // Merge defaults for any new keys added in updates
        const saved = context.extensionSettings[EXTENSION_NAME];
        for (const key of Object.keys(DEFAULT_SETTINGS)) {
            if (!Object.hasOwn(saved, key)) {
                saved[key] = DEFAULT_SETTINGS[key];
            }
        }
    }

    // Inject settings panel HTML
    try {
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $('#extensions_settings2').append(settingsHtml);
    } catch (e) {
        console.error(`[${EXTENSION_NAME}] Failed to load settings HTML:`, e);
    }

    // Bind UI controls to settings
    loadSettingsUI();

    // Register slash commands
    registerCommands();

    // Bind SillyTavern events (CHAT_CHANGED etc.)
    bindEvents();

    // If extension was enabled in previous session, restore phone UI
    const settings = getSettings();
    if (settings.enabled && context.characterId !== undefined) {
        initPhoneUI();
    }

    console.log(`[${EXTENSION_NAME}] Extension loaded.`);
}

// Bootstrap
(function bootstrap() {
    const { eventSource, event_types } = SillyTavern.getContext();
    eventSource.on(event_types.APP_READY, () => init());
})();
