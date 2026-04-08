// TextMe — Slash commands
// License: AGPL-3.0

import { EXTENSION_NAME, getSettings, updateSetting } from './state.js';
import { initPhoneUI, destroyPhoneUI } from './phone-ui.js';

export function registerCommands() {
    const context = SillyTavern.getContext();

    if (!context.SlashCommandParser) {
        console.warn(`[${EXTENSION_NAME}] SlashCommandParser not available.`);
        return;
    }

    const { SlashCommandParser, SlashCommand } = context;

    // /phone — toggle phone UI
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'phone',
        helpString: 'Toggle the TextMe phone UI',
        callback: async () => {
            const settings = getSettings();
            const newState = !settings.enabled;
            updateSetting('enabled', newState);
            context.saveSettingsDebounced();
            $('#textme_enabled').prop('checked', newState);

            if (newState) {
                initPhoneUI();
                return 'Phone opened.';
            } else {
                destroyPhoneUI();
                return 'Phone closed.';
            }
        },
    }));

    console.log(`[${EXTENSION_NAME}] Slash commands registered.`);
}
