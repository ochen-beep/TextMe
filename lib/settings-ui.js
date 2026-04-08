/**
 * TextMe — Settings panel UI binding
 * License: AGPL-3.0
 *
 * FIX (bug-3): Disable branch calls stopAutonomousTimer().
 * FIX (schedule editor): renderScheduleEditor() is deferred until
 *   chat_metadata is actually populated. At APP_READY time the chat
 *   hasn't loaded yet, so getPhoneData().schedule is always null.
 *   We retry up to 10 times with 300ms gaps after the initial call.
 * FIX (generate button): btn.html() restores icon + text instead of
 *   btn.text() which stripped the <i> element.
 */

import { EXTENSION_NAME, DEFAULT_PROMPTS, getSettings, getPhoneData, updateSetting } from './state.js';
import { initPhoneUI, destroyPhoneUI } from './phone-ui.js';
import { generateSchedule, renderScheduleEditor } from './schedule.js';
import { startAutonomousTimer, stopAutonomousTimer } from './autonomous.js';
import { exportLogs, log } from './logger.js';

/**
 * Try to render the schedule editor.
 * If chat_metadata isn't loaded yet (APP_READY fires before CHAT_CHANGED
 * populates it), retry a few times with a short delay.
 * @param {HTMLElement} editorEl
 * @param {number} attemptsLeft
 */
function renderScheduleEditorWhenReady(editorEl, attemptsLeft = 10) {
    if (!editorEl) return;

    const phoneData = getPhoneData();
    if (phoneData && phoneData.schedule) {
        // Data available — render immediately
        renderScheduleEditor(editorEl);
        return;
    }

    if (attemptsLeft <= 0) {
        // Give up and render the empty state
        renderScheduleEditor(editorEl);
        return;
    }

    // Chat data not ready yet — wait 300ms and retry
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
        // FIX: use .html() not .text() so the <i> icon is preserved on restore
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

    // FIX: defer render until chat_metadata is populated
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
