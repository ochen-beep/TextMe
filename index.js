/**
 * TextMe — SillyTavern Phone Messenger Extension
 * License: AGPL-3.0
 * Version: 1.0.0
 *
 * Entry point: loaded as ES module by SillyTavern extension system.
 */

import { EXTENSION_NAME, VERSION, DEFAULT_SETTINGS, getSettings, mergeDefaults, hasCharacter } from './lib/state.js';
import { loadSettingsUI } from './lib/settings-ui.js';
import { initPhoneUI, destroyPhoneUI } from './lib/phone-ui.js';
import { bindEvents } from './lib/events.js';
import { registerCommands } from './lib/commands.js';
import { log } from './lib/logger.js';

/**
 * Main initialization — runs when ST is ready.
 */
async function init() {
    const context = SillyTavern.getContext();
    log.info(`Initializing v${VERSION}...`);

    // Ensure settings exist with all default keys
    if (!context.extensionSettings[EXTENSION_NAME]) {
        context.extensionSettings[EXTENSION_NAME] = structuredClone(DEFAULT_SETTINGS);
    } else {
        mergeDefaults(context.extensionSettings[EXTENSION_NAME]);
    }

    // Inject settings panel HTML.
    // renderExtensionTemplateAsync automatically applies data-i18n translations
    // from the manifest i18n entry (i18n/ru-ru.json) before inserting the HTML.
    try {
        const settingsHtml = await context.renderExtensionTemplateAsync(
            'third-party/TextMe',
            'settings',
            {},
        );
        $('#extensions_settings2').append(settingsHtml);
    } catch (e) {
        log.error('Failed to load settings HTML:', e);
    }

    // Bind UI controls to settings
    loadSettingsUI();

    // Register slash commands
    registerCommands();

    // Bind SillyTavern events (CHAT_CHANGED etc.)
    bindEvents();

    // If extension was enabled in previous session, restore phone UI
    // (initPhoneUI internally starts the autonomous timer if autonomousEnabled)
    const settings = getSettings();
    if (settings.enabled && hasCharacter()) {
        initPhoneUI();
    }

    log.info('Extension loaded.');
}

// Bootstrap
// FIX (T-04): wrap init() in async try/catch so any uncaught error during
// initialisation is surfaced to the user via toastr instead of disappearing
// as a silent unhandled promise rejection.
(function bootstrap() {
    const { eventSource, event_types } = SillyTavern.getContext();
    eventSource.on(event_types.APP_READY, async () => {
        try {
            await init();
        } catch (e) {
            log.error('[TextMe] Initialization failed:', e);
            toastr.error(`TextMe failed to load: ${e?.message || e}`, 'TextMe', { timeOut: 0 });
        }
    });
})();
