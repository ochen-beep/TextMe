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
import { startAutonomousTimer } from './lib/autonomous.js';
import { log } from './lib/logger.js';

/**
 * Resolve the extension's folder path from import.meta.url.
 * Falls back to the conventional ST third-party path if URL parsing fails
 * (edge-case environments: unusual Termux setups, some Android WebViews).
 * On a normal Windows/Linux/macOS install the try-branch always succeeds.
 * @returns {string} Absolute URL pathname, no trailing slash
 */
function getExtensionFolderPath() {
    try {
        return new URL('.', import.meta.url).pathname.replace(/\/$/, '');
    } catch {
        // Fallback: ST always mounts third-party extensions here
        return '/scripts/extensions/third-party/TextMe';
    }
}

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

    // Inject settings panel HTML
    // extensionFolderPath is resolved here (inside init) so that any URL
    // parsing error is caught cleanly and falls back gracefully.
    const extensionFolderPath = getExtensionFolderPath();
    let settingsLoaded = false;
    try {
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $('#extensions_settings2').append(settingsHtml);
        settingsLoaded = true;
    } catch (e) {
        log.error('Failed to load settings HTML:', e);
        // Make the failure visible to the user so they know something went wrong
        // and are not left with a blank, non-functional settings panel.
        toastr.error(
            'TextMe: could not load settings panel. Try reloading the page or reinstalling the extension.',
            'TextMe',
            { timeOut: 8000 },
        );
    }

    // Bind UI controls to settings only if the HTML was actually inserted.
    // Calling loadSettingsUI() against an empty DOM would silently skip all
    // bindings, leaving the user unable to enable the extension from the UI.
    if (settingsLoaded) {
        loadSettingsUI();
    }

    // Register slash commands
    registerCommands();

    // Bind SillyTavern events (CHAT_CHANGED etc.)
    bindEvents();

    // If extension was enabled in previous session, restore phone UI
    const settings = getSettings();
    if (settings.enabled && hasCharacter()) {
        initPhoneUI();

        // Start autonomous timer if enabled
        if (settings.autonomousEnabled) {
            startAutonomousTimer();
        }
    }

    log.info('Extension loaded.');
}

// Bootstrap
(function bootstrap() {
    const { eventSource, event_types } = SillyTavern.getContext();
    eventSource.on(event_types.APP_READY, () => init());
})();
