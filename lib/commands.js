/**
 * TextMe — Slash commands
 * License: AGPL-3.0
 */

import { EXTENSION_NAME, getSettings, updateSetting } from './state.js';
import { initPhoneUI, destroyPhoneUI, togglePhone, clearPhoneChat } from './phone-ui.js';

export function registerCommands() {
    const context = SillyTavern.getContext();

    if (!context.SlashCommandParser || !context.SlashCommand) {
        console.warn(`[${EXTENSION_NAME}] SlashCommandParser not available.`);
        return;
    }

    const { SlashCommandParser, SlashCommand } = context;

    // /phone — toggle phone UI
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'phone',
        helpString: 'Toggle the TextMe phone messenger',
        callback: async () => {
            const settings = getSettings();
            if (!settings.enabled) {
                updateSetting('enabled', true);
                context.saveSettingsDebounced();
                $('#textme_enabled').prop('checked', true);
                initPhoneUI();
            }
            togglePhone();
            return 'Phone toggled.';
        },
    }));

    // /phone-clear — clear phone chat
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'phone-clear',
        helpString: 'Clear the TextMe phone conversation',
        callback: async () => {
            await clearPhoneChat();
            return 'Phone chat cleared.';
        },
    }));

    // /selfie — request a selfie (placeholder for M7)
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'selfie',
        helpString: 'Request a selfie from the character (TextMe)',
        callback: async () => {
            toastr.info('Selfie generation is not yet implemented. Coming in a future update!');
            return 'Selfie feature not yet available.';
        },
    }));

    console.log(`[${EXTENSION_NAME}] Slash commands registered.`);
}
