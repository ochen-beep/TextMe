/**
 * TextMe — Slash commands
 * License: AGPL-3.0
 */

import { EXTENSION_NAME, getSettings, updateSetting, hasCharacter } from './state.js';
import { initPhoneUI, destroyPhoneUI, togglePhone, clearPhoneChat } from './phone-ui.js';
import { exportLogs, log } from './logger.js';

export function registerCommands() {
    const context = SillyTavern.getContext();

    if (!context.SlashCommandParser || !context.SlashCommand) {
        log.warn('SlashCommandParser not available.');
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
                if (hasCharacter()) initPhoneUI();
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

    // /phone-log — export extension logs
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'phone-log',
        helpString: 'Export TextMe extension logs',
        callback: async () => {
            exportLogs();
            return 'Logs exported.';
        },
    }));

    log.info('Slash commands registered.');
}
