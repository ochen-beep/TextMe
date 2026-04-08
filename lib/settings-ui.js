// TextMe — Settings UI binding
// License: AGPL-3.0

import { saveSettingsDebounced } from '../../../../script.js';
import { getContext } from '../../../../extensions.js';
import { EXTENSION_NAME, DEFAULT_PROMPTS, getSettings, updateSetting } from './state.js';
import { initPhoneUI, destroyPhoneUI } from './phone-ui.js';

export function loadSettingsUI() {
    const settings = getSettings();

    // ── General ──
    $('#textme_enabled').prop('checked', settings.enabled).on('change', function () {
        updateSetting('enabled', !!$(this).prop('checked'));
        saveSettingsDebounced();
        if (settings.enabled) initPhoneUI(); else destroyPhoneUI();
    });

    // Connection Profile dropdown — use ST's built-in component
    try {
        const context = getContext();
        if (context.ConnectionManagerRequestService) {
            context.ConnectionManagerRequestService.handleDropdown(
                '#textme_connection_profile',
                (profileId) => {
                    updateSetting('connectionProfileId', profileId);
                    saveSettingsDebounced();
                },
                { selectedProfile: settings.connectionProfileId }
            );
        }
    } catch (e) {
        console.warn(`[${EXTENSION_NAME}] ConnectionManager not available:`, e);
        $('#textme_connection_profile').html('<i>Connection Manager not available. Update SillyTavern to staging branch.</i>');
    }

    $('#textme_max_tokens').val(settings.maxTokens).on('change', function () {
        updateSetting('maxTokens', Number($(this).val()));
        saveSettingsDebounced();
    });

    $('#textme_context_messages').val(settings.contextMessages).on('change', function () {
        updateSetting('contextMessages', Number($(this).val()));
        saveSettingsDebounced();
    });

    $('#textme_temperature').val(settings.temperature).on('input', function () {
        const val = parseFloat($(this).val());
        $('#textme_temperature_value').text(val.toFixed(2));
        updateSetting('temperature', val);
        saveSettingsDebounced();
    });
    $('#textme_temperature_value').text(settings.temperature.toFixed(2));

    // ── Prompts ──
    $('#textme_sms_prompt').val(settings.smsPrompt).on('change', function () {
        updateSetting('smsPrompt', $(this).val());
        saveSettingsDebounced();
    });
    $('#textme_sms_prompt_reset').on('click', function () {
        $('#textme_sms_prompt').val(DEFAULT_PROMPTS.sms).trigger('change');
    });

    $('#textme_selfie_prompt').val(settings.selfiePrompt).on('change', function () {
        updateSetting('selfiePrompt', $(this).val());
        saveSettingsDebounced();
    });
    $('#textme_selfie_prompt_reset').on('click', function () {
        $('#textme_selfie_prompt').val(DEFAULT_PROMPTS.selfie).trigger('change');
    });

    $('#textme_summary_prompt').val(settings.summaryPrompt).on('change', function () {
        updateSetting('summaryPrompt', $(this).val());
        saveSettingsDebounced();
    });
    $('#textme_summary_prompt_reset').on('click', function () {
        $('#textme_summary_prompt').val(DEFAULT_PROMPTS.summary).trigger('change');
    });

    // ── Selfie ──
    $('#textme_selfie_enabled').prop('checked', settings.selfieEnabled).on('change', function () {
        updateSetting('selfieEnabled', !!$(this).prop('checked'));
        saveSettingsDebounced();
    });

    $('#textme_selfie_trigger').val(settings.selfieTrigger).on('change', function () {
        updateSetting('selfieTrigger', $(this).val());
        saveSettingsDebounced();
    });

    $('#textme_image_api_url').val(settings.imageApiUrl).on('change', function () {
        updateSetting('imageApiUrl', $(this).val());
        saveSettingsDebounced();
    });

    $('#textme_image_api_key').val(settings.imageApiKey).on('change', function () {
        updateSetting('imageApiKey', $(this).val());
        saveSettingsDebounced();
    });

    $('#textme_image_model').val(settings.imageModel).on('change', function () {
        updateSetting('imageModel', $(this).val());
        saveSettingsDebounced();
    });

    // Reference image upload
    $('#textme_reference_image').on('change', function () {
        const file = this.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            updateSetting('referenceImageBase64', e.target.result);
            saveSettingsDebounced();
            $('#textme_reference_preview').html(`<img src="${e.target.result}" style="max-width:100px;max-height:100px;border-radius:8px;margin-top:4px;" />`);
        };
        reader.readAsDataURL(file);
    });

    if (settings.referenceImageBase64) {
        $('#textme_reference_preview').html(`<img src="${settings.referenceImageBase64}" style="max-width:100px;max-height:100px;border-radius:8px;margin-top:4px;" />`);
    }

    // ── Schedule ──
    $('#textme_schedule_enabled').prop('checked', settings.scheduleEnabled).on('change', function () {
        updateSetting('scheduleEnabled', !!$(this).prop('checked'));
        saveSettingsDebounced();
    });

    // ── Autonomous ──
    $('#textme_autonomous_enabled').prop('checked', settings.autonomousEnabled).on('change', function () {
        updateSetting('autonomousEnabled', !!$(this).prop('checked'));
        saveSettingsDebounced();
    });

    $('#textme_inactivity_threshold').val(settings.inactivityThreshold).on('change', function () {
        updateSetting('inactivityThreshold', Number($(this).val()));
        saveSettingsDebounced();
    });

    $('#textme_max_followups').val(settings.maxFollowups).on('change', function () {
        updateSetting('maxFollowups', Number($(this).val()));
        saveSettingsDebounced();
    });

    $('#textme_cooldown_escalation').prop('checked', settings.cooldownEscalation).on('change', function () {
        updateSetting('cooldownEscalation', !!$(this).prop('checked'));
        saveSettingsDebounced();
    });

    // ── Appearance ──
    $('#textme_theme').val(settings.theme).on('change', function () {
        updateSetting('theme', $(this).val());
        saveSettingsDebounced();
    });

    $('#textme_color_scheme').val(settings.colorScheme).on('change', function () {
        updateSetting('colorScheme', $(this).val());
        saveSettingsDebounced();
    });

    $('#textme_phone_size').val(settings.phoneSize).on('change', function () {
        updateSetting('phoneSize', $(this).val());
        saveSettingsDebounced();
    });

    $('#textme_phone_position').val(settings.phonePosition).on('change', function () {
        updateSetting('phonePosition', $(this).val());
        saveSettingsDebounced();
    });

    $('#textme_sound_effects').prop('checked', settings.soundEffects).on('change', function () {
        updateSetting('soundEffects', !!$(this).prop('checked'));
        saveSettingsDebounced();
    });

    $('#textme_show_timestamps').prop('checked', settings.showTimestamps).on('change', function () {
        updateSetting('showTimestamps', !!$(this).prop('checked'));
        saveSettingsDebounced();
    });
}
