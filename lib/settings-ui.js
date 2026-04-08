/**
 * TextMe — Settings panel UI binding
 * License: AGPL-3.0
 */

import { EXTENSION_NAME, DEFAULT_PROMPTS, getSettings, updateSetting } from './state.js';
import { initPhoneUI, destroyPhoneUI } from './phone-ui.js';
import { generateSchedule, renderScheduleEditor } from './schedule.js';
import { startAutonomousTimer, stopAutonomousTimer } from './autonomous.js';
import { exportLogs } from './logger.js';
import { log } from './logger.js';

/** Bind all settings controls to state */
export function loadSettingsUI() {
    const context = SillyTavern.getContext();
    const settings = getSettings();

    // Helper: bind a checkbox
    function bindCheckbox(selector, key) {
        $(selector).prop('checked', settings[key]).on('change', function () {
            updateSetting(key, !!$(this).prop('checked'));
            context.saveSettingsDebounced();
        });
    }

    // Helper: bind a number input
    function bindNumber(selector, key) {
        $(selector).val(settings[key]).on('change', function () {
            updateSetting(key, Number($(this).val()));
            context.saveSettingsDebounced();
        });
    }

    // Helper: bind a select
    function bindSelect(selector, key) {
        $(selector).val(settings[key]).on('change', function () {
            updateSetting(key, $(this).val());
            context.saveSettingsDebounced();
        });
    }

    // Helper: bind a text input
    function bindText(selector, key) {
        $(selector).val(settings[key]).on('change', function () {
            updateSetting(key, $(this).val());
            context.saveSettingsDebounced();
        });
    }

    // Helper: bind a textarea + reset button
    function bindPrompt(textSelector, resetSelector, key, defaultVal) {
        $(textSelector).val(settings[key]).on('change', function () {
            updateSetting(key, $(this).val());
            context.saveSettingsDebounced();
        });
        $(resetSelector).on('click', function () {
            $(textSelector).val(defaultVal).trigger('change');
            toastr.success('Prompt reset to default.');
        });
    }

    // ── General ──
    $('#textme_enabled').prop('checked', settings.enabled).on('change', function () {
        const enabled = !!$(this).prop('checked');
        updateSetting('enabled', enabled);
        context.saveSettingsDebounced();
        if (enabled) {
            if (context.characterId !== undefined) {
                initPhoneUI();
            }
        } else {
            destroyPhoneUI();
        }
    });

    bindNumber('#textme_max_tokens', 'maxTokens');
    bindNumber('#textme_context_messages', 'contextMessages');

    // Temperature slider
    $('#textme_temperature').val(settings.temperature).on('input', function () {
        const val = parseFloat($(this).val());
        $('#textme_temperature_value').text(val.toFixed(2));
        updateSetting('temperature', val);
        context.saveSettingsDebounced();
    });
    $('#textme_temperature_value').text((settings.temperature || 1.0).toFixed(2));

    // ── Prompts ──
    bindPrompt('#textme_sms_prompt', '#textme_sms_prompt_reset', 'smsPrompt', DEFAULT_PROMPTS.sms);
    bindPrompt('#textme_selfie_prompt', '#textme_selfie_prompt_reset', 'selfiePrompt', DEFAULT_PROMPTS.selfie);
    bindPrompt('#textme_summary_prompt', '#textme_summary_prompt_reset', 'summaryPrompt', DEFAULT_PROMPTS.summary);
    bindPrompt('#textme_schedule_prompt', '#textme_schedule_prompt_reset', 'schedulePrompt', DEFAULT_PROMPTS.schedule);
    bindPrompt('#textme_autonomous_prompt', '#textme_autonomous_prompt_reset', 'autonomousPrompt', DEFAULT_PROMPTS.autonomous);

    // ── Selfie ──
    bindCheckbox('#textme_selfie_enabled', 'selfieEnabled');
    bindSelect('#textme_selfie_trigger', 'selfieTrigger');
    bindText('#textme_image_api_url', 'imageApiUrl');
    bindText('#textme_image_api_key', 'imageApiKey');
    bindText('#textme_image_model', 'imageModel');

    // Reference image upload
    $('#textme_reference_image').on('change', function () {
        const file = this.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            updateSetting('referenceImageBase64', e.target.result);
            context.saveSettingsDebounced();
            $('#textme_reference_preview').html(
                `<img src="${e.target.result}" style="max-width:100px;max-height:100px;border-radius:8px;margin-top:4px;" />`
            );
        };
        reader.readAsDataURL(file);
    });

    if (settings.referenceImageBase64) {
        $('#textme_reference_preview').html(
            `<img src="${settings.referenceImageBase64}" style="max-width:100px;max-height:100px;border-radius:8px;margin-top:4px;" />`
        );
    }

    // ── Schedule ──
    bindCheckbox('#textme_schedule_enabled', 'scheduleEnabled');

    // Generate schedule button
    $('#textme_generate_schedule').on('click', async function () {
        const btn = $(this);
        btn.prop('disabled', true).text('Generating...');
        try {
            await generateSchedule();
            renderScheduleEditor(document.getElementById('textme_schedule_editor'));
            toastr.success('Schedule generated!');
        } catch (err) {
            log.error('Schedule generation failed:', err);
            toastr.error(`Schedule error: ${err.message}`);
        } finally {
            btn.prop('disabled', false).text('Generate Schedule');
        }
    });

    // Render existing schedule if available
    renderScheduleEditor(document.getElementById('textme_schedule_editor'));

    // ── Autonomous ──
    $('#textme_autonomous_enabled').prop('checked', settings.autonomousEnabled).on('change', function () {
        const enabled = !!$(this).prop('checked');
        updateSetting('autonomousEnabled', enabled);
        context.saveSettingsDebounced();
        if (enabled) {
            startAutonomousTimer();
        } else {
            stopAutonomousTimer();
        }
    });

    bindNumber('#textme_inactivity_threshold', 'inactivityThreshold');
    bindNumber('#textme_max_followups', 'maxFollowups');
    bindCheckbox('#textme_cooldown_escalation', 'cooldownEscalation');

    // ── Appearance ──
    bindSelect('#textme_theme', 'theme');
    bindSelect('#textme_color_scheme', 'colorScheme');
    bindSelect('#textme_phone_size', 'phoneSize');
    bindSelect('#textme_phone_position', 'phonePosition');
    bindCheckbox('#textme_sound_effects', 'soundEffects');
    bindCheckbox('#textme_show_timestamps', 'showTimestamps');

    // ── Debug / Logs ──
    $('#textme_export_logs').on('click', exportLogs);
}
