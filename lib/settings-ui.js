/**
 * TextMe — Settings panel UI binding
 * License: AGPL-3.0
 *
 * FIX: Disable branch calls stopAutonomousTimer().
 * FIX: Schedule editor deferred until chat_metadata is populated.
 * FIX: Generate button uses .html() to restore icon.
 * FIX: Added 'Schedule & Status' button that opens the modal editor.
 */

import { EXTENSION_NAME, DEFAULT_PROMPTS, getSettings, getPhoneData, updateSetting } from './state.js';
import { initPhoneUI, destroyPhoneUI } from './phone-ui.js';
import { generateSchedule, renderScheduleEditor, openScheduleModal } from './schedule.js';
import { startAutonomousTimer, stopAutonomousTimer } from './autonomous.js';
import { exportLogs, log } from './logger.js';

/**
 * Try to render the schedule editor placeholder.
 * Retries until chat_metadata is populated.
 */
function renderScheduleEditorWhenReady(editorEl, attemptsLeft = 10) {
    if (!editorEl) return;

    const phoneData = getPhoneData();
    if (phoneData && phoneData.schedule) {
        renderScheduleEditor(editorEl);
        return;
    }

    if (attemptsLeft <= 0) {
        renderScheduleEditor(editorEl);
        return;
    }

    setTimeout(() => {
        renderScheduleEditorWhenReady(
            document.getElementById('textme_schedule_editor'),
            attemptsLeft - 1
        );
    }, 300);
}

/** Bind all settings controls to state */
export function loadSettingsUI() {
    const context = SillyTavern.getContext();
    const settings = getSettings();

    function bindCheckbox(selector, key) {
        $(selector).prop('checked', settings[key]).on('change', function () {
            updateSetting(key, !!$(this).prop('checked'));
            context.saveSettingsDebounced();
        });
    }

    function bindNumber(selector, key) {
        $(selector).val(settings[key]).on('change', function () {
            updateSetting(key, Number($(this).val()));
            context.saveSettingsDebounced();
        });
    }

    function bindSelect(selector, key) {
        $(selector).val(settings[key]).on('change', function () {
            updateSetting(key, $(this).val());
            context.saveSettingsDebounced();
        });
    }

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
            if (getSettings().autonomousEnabled) {
                startAutonomousTimer();
            }
        } else {
            stopAutonomousTimer();
            destroyPhoneUI();
        }
    });

    bindNumber('#textme_max_tokens', 'maxTokens');
    bindNumber('#textme_context_messages', 'contextMessages');

    $('#textme_temperature').val(settings.temperature).on('input', function () {
        const val = parseFloat($(this).val());
        $('#textme_temperature_value').text(val.toFixed(2));
        updateSetting('temperature', val);
        context.saveSettingsDebounced();
    });
    $('#textme_temperature_value').text((settings.temperature || 1.0).toFixed(2));

    // ── Prompts ──
    bindPrompt('#textme_sms_prompt', '#textme_sms_prompt_reset', 'smsPrompt', DEFAULT_PROMPTS.sms);
    bindPrompt('#textme_summary_prompt', '#textme_summary_prompt_reset', 'summaryPrompt', DEFAULT_PROMPTS.summary);
    bindPrompt('#textme_schedule_prompt', '#textme_schedule_prompt_reset', 'schedulePrompt', DEFAULT_PROMPTS.schedule);
    bindPrompt('#textme_autonomous_prompt', '#textme_autonomous_prompt_reset', 'autonomousPrompt', DEFAULT_PROMPTS.autonomous);

    // ── Schedule ──
    bindCheckbox('#textme_schedule_enabled', 'scheduleEnabled');

    $('#textme_generate_schedule').on('click', async function () {
        const btn = $(this);
        btn.prop('disabled', true).html('Generating...');
        try {
            await generateSchedule();
            renderScheduleEditor(document.getElementById('textme_schedule_editor'));
            toastr.success('Schedule generated!');
        } catch (err) {
            log.error('Schedule generation failed:', err);
            toastr.error(`Schedule error: ${err.message}`);
        } finally {
            btn.prop('disabled', false).html('<i class="fa-solid fa-calendar-days"></i> Generate Schedule');
        }
    });

    // 'Schedule & Status' button — opens the full modal editor
    $('#textme_open_schedule_modal').on('click', async function () {
        await openScheduleModal();
        // Refresh the inline placeholder after editing
        renderScheduleEditor(document.getElementById('textme_schedule_editor'));
    });

    // Defer render until chat_metadata is populated
    renderScheduleEditorWhenReady(document.getElementById('textme_schedule_editor'));

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
