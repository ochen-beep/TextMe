/**
 * TextMe — Settings panel UI binding
 * License: AGPL-3.0
 *
 * FIX: Disable branch calls stopAutonomousTimer().
 * FIX: Schedule editor deferred until chat_metadata is populated.
 * FIX: Generate button uses .html() to restore icon.
 * FIX: Added 'Schedule & Status' button that opens the modal editor.
 */

import { EXTENSION_NAME, DEFAULT_PROMPTS, getSettings, getPhoneData, updateSetting, DEFAULT_SETTINGS } from './state.js';
import { initPhoneUI, destroyPhoneUI } from './phone-ui.js';
import { generateSchedule, renderScheduleEditor, openScheduleModal, exportScheduleJSON, importScheduleJSON } from './schedule.js';
import { startAutonomousTimer, stopAutonomousTimer } from './autonomous.js';
import { requestNotificationPermission } from './notifications.js';
import { openTimeEditor, isCustomTimeEnabled, getFormattedGameTime } from './custom-time.js';
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
    bindNumber('#textme_sms_history', 'smsHistory');
    bindNumber('#textme_context_messages', 'contextMessages');

    bindCheckbox('#textme_send_on_enter', 'sendOnEnter');

    // ── Prompts ──
    bindPrompt('#textme_sms_prompt',                '#textme_sms_prompt_reset',                'smsPrompt',            DEFAULT_PROMPTS.sms);
    bindPrompt('#textme_summary_prompt',            '#textme_summary_prompt_reset',            'summaryPrompt',        DEFAULT_PROMPTS.summary);
    bindPrompt('#textme_schedule_prompt',           '#textme_schedule_prompt_reset',           'schedulePrompt',       DEFAULT_PROMPTS.schedule);
    bindPrompt('#textme_autonomous_prompt',         '#textme_autonomous_prompt_reset',         'autonomousPrompt',     DEFAULT_PROMPTS.autonomous);
    bindPrompt('#textme_autonomous_task_prompt',    '#textme_autonomous_task_prompt_reset',    'autonomousTaskPrompt', DEFAULT_PROMPTS.autonomousTask);

    // ── Prompt Presets ──
    _initPromptPresets(settings, context);

    // ── World Info ──
    bindSelect('#textme_wi_scan_source', 'wiScanSource');
    bindNumber('#textme_wi_scan_depth',  'wiScanDepth');

    // ── Response Delay ──
    // Helper: bind a responseDelay sub-field (settings.responseDelay[status].min/max)
    function bindDelayField(selector, status, field) {
        const cfg = settings.responseDelay?.[status];
        if (cfg === undefined) return;
        $(selector).val(cfg[field] ?? 0).on('change', function () {
            if (!settings.responseDelay[status]) settings.responseDelay[status] = {};
            settings.responseDelay[status][field] = Number($(this).val());
            context.saveSettingsDebounced();
        });
    }

    bindDelayField('#textme_delay_online_min', 'online', 'min');
    bindDelayField('#textme_delay_online_max', 'online', 'max');
    bindDelayField('#textme_delay_idle_min',   'idle',   'min');
    bindDelayField('#textme_delay_idle_max',   'idle',   'max');
    bindDelayField('#textme_delay_dnd_min',    'dnd',    'min');
    bindDelayField('#textme_delay_dnd_max',    'dnd',    'max');

    // ── Read Receipts ──
    bindCheckbox('#textme_read_receipts', 'readReceipts');

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

    // Export schedule JSON
    $('#textme_export_schedule').on('click', function () {
        const json = exportScheduleJSON();
        if (!json) {
            toastr.warning('No schedule to export. Generate one first.');
            return;
        }
        const blob = new Blob([json], { type: 'application/json' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = 'textme_schedule.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toastr.success('Schedule exported.');
    });

    // Import schedule JSON
    $('#textme_import_schedule').on('click', function () {
        const input = document.createElement('input');
        input.type   = 'file';
        input.accept = '.json,application/json';
        input.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const text = await file.text();
            const ok = await importScheduleJSON(text);
            if (ok) {
                toastr.success('Schedule imported!');
                renderScheduleEditor(document.getElementById('textme_schedule_editor'));
            }
        });
        input.click();
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

    // Per-status threshold fields
    function bindAutonomousThreshold(selector, statusKey) {
        const val = settings.autonomousThresholds?.[statusKey] ?? DEFAULT_SETTINGS.autonomousThresholds[statusKey];
        $(selector).val(val).on('change', function () {
            if (!settings.autonomousThresholds) settings.autonomousThresholds = {};
            settings.autonomousThresholds[statusKey] = Number($(this).val());
            context.saveSettingsDebounced();
        });
    }

    bindAutonomousThreshold('#textme_autonomous_threshold_online', 'online');
    bindAutonomousThreshold('#textme_autonomous_threshold_idle',   'idle');
    bindAutonomousThreshold('#textme_autonomous_threshold_dnd',    'dnd');

    bindNumber('#textme_max_followups',  'maxFollowups');
    bindNumber('#textme_cooldown_cap',   'cooldownCap');
    bindCheckbox('#textme_cooldown_escalation', 'cooldownEscalation');

    // ── Appearance ──
    bindSelect('#textme_theme', 'theme');
    bindSelect('#textme_color_scheme', 'colorScheme');
    bindSelect('#textme_phone_size', 'phoneSize');
    bindSelect('#textme_phone_position', 'phonePosition');
    bindCheckbox('#textme_sound_effects', 'soundEffects');
    bindCheckbox('#textme_show_timestamps', 'showTimestamps');
    bindCheckbox('#textme_browser_notifications', 'browserNotifications');

    $('#textme_sound_volume').val(settings.soundVolume ?? 70).on('input', function () {
        const val = parseInt($(this).val(), 10);
        $('#textme_sound_volume_value').text(val + '%');
        updateSetting('soundVolume', val);
        context.saveSettingsDebounced();
    });
    $('#textme_sound_volume_value').text((settings.soundVolume ?? 70) + '%');

    $('#textme_request_notif_permission').on('click', async function () {
        const perm = await requestNotificationPermission();
        if (perm === 'granted') {
            toastr.success('Browser notifications enabled!');
        } else {
            toastr.warning(`Permission: ${perm}`);
        }
    });

    // ── Game Time ──
    function refreshTimeStatus() {
        const el = document.getElementById('textme_time_status');
        if (!el) return;
        if (isCustomTimeEnabled()) {
            el.textContent = `Game time enabled — ${getFormattedGameTime()}`;
        } else {
            el.textContent = 'Disabled — using real clock.';
        }
    }

    $('#textme_open_time_editor').on('click', async function () {
        await openTimeEditor();
        refreshTimeStatus();
    });

    refreshTimeStatus();

    // ── Debug / Logs ──
    $('#textme_export_logs').on('click', exportLogs);
}

// ═══════════════════════════════════════════════════════════════
// Prompt Presets
// ═══════════════════════════════════════════════════════════════

const PRESET_PROMPT_KEYS = ['smsPrompt', 'summaryPrompt', 'schedulePrompt', 'autonomousPrompt', 'autonomousTaskPrompt'];

/**
 * Initialize the Prompt Presets UI block.
 * Expects these elements in settings.html:
 *   #textme_preset_select       — <select> dropdown of saved presets
 *   #textme_preset_save         — Save current prompts as preset
 *   #textme_preset_delete       — Delete selected preset
 *   #textme_preset_export       — Export all presets as JSON file
 *   #textme_preset_import       — Import presets from JSON file
 *   #textme_preset_reset_all    — Reset all prompts to built-in defaults
 * @param {object} settings
 * @param {object} context
 */
function _initPromptPresets(settings, context) {
    if (!settings.promptPresets) settings.promptPresets = {};

    const $select = $('#textme_preset_select');
    if (!$select.length) return; // element not in HTML yet — graceful skip

    _refreshPresetSelect(settings);

    // Load preset when dropdown changes
    $select.on('change', function () {
        const name = $(this).val();
        if (!name) {
            settings.activePreset = null;
            context.saveSettingsDebounced();
            return;
        }
        const preset = settings.promptPresets[name];
        if (!preset) return;

        for (const key of PRESET_PROMPT_KEYS) {
            if (preset[key] !== undefined) {
                settings[key] = preset[key];
                $(`#textme_${_keyToInputId(key)}`).val(preset[key]);
            }
        }
        settings.activePreset = name;
        context.saveSettingsDebounced();
        toastr.info(`Preset "${name}" loaded.`);
    });

    // Save preset
    $('#textme_preset_save').on('click', function () {
        const defaultName = settings.activePreset || '';
        const name = prompt('Save current prompts as preset:\nEnter preset name:', defaultName);
        if (!name?.trim()) return;
        const trimmed = name.trim();

        const presetData = {};
        for (const key of PRESET_PROMPT_KEYS) {
            presetData[key] = settings[key] || '';
        }

        settings.promptPresets[trimmed] = presetData;
        settings.activePreset           = trimmed;
        context.saveSettingsDebounced();
        _refreshPresetSelect(settings);
        toastr.success(`Preset "${trimmed}" saved.`);
    });

    // Delete preset
    $('#textme_preset_delete').on('click', function () {
        const name = $select.val();
        if (!name) {
            toastr.warning('Select a preset to delete first.');
            return;
        }
        if (!confirm(`Delete preset "${name}"?\nThis cannot be undone.`)) return;

        delete settings.promptPresets[name];
        if (settings.activePreset === name) settings.activePreset = null;
        context.saveSettingsDebounced();
        _refreshPresetSelect(settings);
        toastr.info(`Preset "${name}" deleted.`);
    });

    // Export presets as JSON file
    $('#textme_preset_export').on('click', function () {
        const data = settings.promptPresets;
        if (!data || Object.keys(data).length === 0) {
            toastr.warning('No presets to export. Save at least one first.');
            return;
        }
        const json = JSON.stringify(data, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `textme_presets_${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toastr.success('Presets exported.');
    });

    // Import presets from JSON file
    $('#textme_preset_import').on('click', function () {
        const input = document.createElement('input');
        input.type   = 'file';
        input.accept = '.json,application/json';
        input.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
                const text = await file.text();
                const data = JSON.parse(text);

                if (typeof data !== 'object' || data === null || Array.isArray(data)) {
                    toastr.error('Import failed: expected a JSON object.');
                    return;
                }

                let count = 0;
                for (const [name, preset] of Object.entries(data)) {
                    if (typeof preset === 'object' && preset !== null) {
                        settings.promptPresets[name] = preset;
                        count++;
                    }
                }

                context.saveSettingsDebounced();
                _refreshPresetSelect(settings);
                toastr.success(`Imported ${count} preset${count !== 1 ? 's' : ''}.`);
            } catch (err) {
                toastr.error(`Import failed: ${err.message}`);
            }
        });
        input.click();
    });

    // Reset ALL prompts to built-in defaults
    $('#textme_preset_reset_all').on('click', function () {
        if (!confirm('Reset ALL prompts to built-in defaults?\nThis will overwrite your current prompt text.')) return;

        for (const key of PRESET_PROMPT_KEYS) {
            const defaultVal = DEFAULT_PROMPTS[_keyToDefaultKey(key)];
            if (defaultVal !== undefined) {
                settings[key] = defaultVal;
                $(`#textme_${_keyToInputId(key)}`).val(defaultVal);
            }
        }
        settings.activePreset = null;
        context.saveSettingsDebounced();
        _refreshPresetSelect(settings);
        toastr.success('All prompts reset to defaults.');
    });
}

/**
 * Rebuild the preset <select> options.
 * @param {object} settings
 */
function _refreshPresetSelect(settings) {
    const $select = $('#textme_preset_select');
    if (!$select.length) return;

    const current = settings.activePreset || '';
    $select.empty().append('<option value="">— Custom (unsaved) —</option>');

    const names = Object.keys(settings.promptPresets || {}).sort();
    for (const name of names) {
        $select.append(`<option value="${name.replace(/"/g, '&quot;')}">${name}</option>`);
    }

    $select.val(current);
}

/**
 * Map settings key → HTML input element ID suffix.
 * e.g. "smsPrompt" → "sms_prompt"
 */
function _keyToInputId(key) {
    return key.replace(/([A-Z])/g, '_$1').toLowerCase(); // smsPrompt → sms_prompt
}

/**
 * Map settings key → DEFAULT_PROMPTS key.
 * e.g. "smsPrompt" → "sms", "autonomousTaskPrompt" → "autonomousTask"
 */
function _keyToDefaultKey(key) {
    // Explicit map for keys that don't follow the simple strip-"Prompt" pattern
    const explicit = {
        autonomousTaskPrompt: 'autonomousTask',
    };
    if (explicit[key]) return explicit[key];
    // Generic: strip trailing "Prompt", lowercase first char
    const stripped = key.replace(/Prompt$/, '');
    return stripped.charAt(0).toLowerCase() + stripped.slice(1);
}
