// TextMe — SillyTavern Phone Messenger Extension
// License: AGPL-3.0

import { getContext, extension_settings } from '../../../extensions.js';
import { saveMetadataDebounced } from '../../../../script.js';
import { EXTENSION_NAME, DEFAULT_SETTINGS, getSettings, getPhoneData, savePhoneData } from './lib/state.js';
import { loadSettingsUI } from './lib/settings-ui.js';
import { initPhoneUI, destroyPhoneUI } from './lib/phone-ui.js';
import { bindEvents, unbindEvents } from './lib/events.js';
import { registerCommands } from './lib/commands.js';

// Entry point
jQuery(async () => {
    // 1. Load settings HTML template
    const settingsHtml = await $.get(`${import.meta.url.replace('/index.js', '')}/settings.html`);
    $('#extensions_settings2').append(settingsHtml);

    // 2. Initialize extension settings with defaults
    if (!extension_settings[EXTENSION_NAME]) {
        extension_settings[EXTENSION_NAME] = structuredClone(DEFAULT_SETTINGS);
    }

    // 3. Load settings UI (dropdowns, toggles, prompt fields)
    loadSettingsUI();

    // 4. Register slash commands
    registerCommands();

    // 5. Bind SillyTavern events
    bindEvents();

    // 6. If phone was active in previous session, restore it
    const settings = getSettings();
    if (settings.enabled && getContext().characterId !== undefined) {
        initPhoneUI();
    }

    console.log(`[${EXTENSION_NAME}] Extension loaded.`);
});
