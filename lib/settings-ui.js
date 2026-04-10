/**
 * TextMe — Settings panel UI binding
 * License: AGPL-3.0
 *
 * FIX: Disable branch calls stopAutonomousTimer().
 * FIX: Schedule editor deferred until chat_metadata is populated.
 * FIX: Generate button uses .html() to restore icon.
 * FIX: Added 'Schedule & Status' button that opens the modal editor.
 *
 * v1.4.0: Connection profile dropdown (issue #13).
 *   Uses ConnectionManagerRequestService.handleDropdown() from ST shared.js
 *   to populate and keep the dropdown live (reacts to profile create/update/delete).
 *   All Enable checkboxes and the profile selector now log to the TextMe logger.
 *
 * FIX: Enable Phone toggle no longer wraps initPhoneUI() in a redundant
 *   `context.characterId !== undefined` guard. That check was silently
 *   swallowing re-initializations when ST returned undefined for characterId
 *   at toggle time. initPhoneUI() has its own hasCharacter() guard inside.
 *
 * FIX (v1.0.3): Removed duplicate startAutonomousTimer() call from the
 *   Enable Phone ON branch. initPhoneUI() already starts the timer internally
 *   when both enabled and autonomousEnabled are true. The extra call here was
 *   causing a redundant stop→start cycle on every phone enable.
 *
 * FIX (v1.0.3): Added 'Show Phone' button as a reliable entry point on mobile.
 *   On mobile the floating bubble can be obscured by browser chrome or the ST
 *   navigation bar. The button in the settings panel provides a guaranteed way
 *   to open the phone UI without needing to tap the bubble.
 */

import { EXTENSION_NAME, DEFAULT_PROMPTS, getSettings, getPhoneData, updateSetting, DEFAULT_SETTINGS } from './state.js';
import { initPhoneUI, destroyPhoneUI, togglePhone, openPhone } from './phone-ui.js';
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
    if (phoneData && (phoneData.schedule || phoneData.scheduleBlocks)) {
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

    function bindCheckbox(selector, key, label) {
        $(selector).prop('checked', settings[key]).on('change', function () {
            const val = !!$(this).prop('checked');
            updateSetting(key, val);
            context.saveSettingsDebounced();
            // Log every Enable toggle for debug
            const displayLabel = label || key;
            log.info(`[Settings] "${displayLabel}" toggled → ${val ? 'ON ✓' : 'OFF'}`);
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
        log.info(`[Settings] "Enable Phone" toggled → ${enabled ? 'ON ✓' : 'OFF'}`);
        if (enabled) {
            // FIX: removed redundant `if (context.characterId !== undefined)` guard.
            // FIX (v1.0.3): removed duplicate startAutonomousTimer() call.
            //   initPhoneUI() already calls startAutonomousTimer() internally
            //   when settings.enabled && settings.autonomousEnabled are both true.
            //   Calling it again here only caused a superfluous stop→start cycle.
            log.info('[Settings] Enable Phone ON — calling initPhoneUI()...');
            initPhoneUI();
        } else {
            stopAutonomousTimer();
            destroyPhoneUI();
        }
    });

    // ── Show Phone button (mobile fallback entry point) ──
    // On mobile the floating bubble may be hidden behind browser chrome or the
    // ST navigation bar. This button provides a reliable way to open/toggle the
    // phone UI directly from the settings panel without relying on the bubble.
    $('#textme_show_phone').on('click', function () {
        const settings = getSettings();
        if (!settings.enabled) {
            toastr.warning('Enable Phone first.');
            return;
        }
        // If #textme-container doesn\'t exist yet, init it first
        if (!document.getElementById('textme-container')) {
            initPhoneUI();
        }
        openPhone();
        // Close settings panel on mobile so the phone is fully visible
        $('#extensions_settings2').closest('.drawer-content').slideUp(200);
    });

    bindNumber('#textme_max_tokens', 'maxTokens');
    bindNumber('#textme_sms_history', 'smsHistory');
    bindNumber('#textme_context_messages', 'contextMessages');

    bindCheckbox('#textme_send_on_enter', 'sendOnEnter', 'Send on Enter');

    // ── Connection Profile (issue #13) ──
    _initConnectionProfileDropdown(settings, context);

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
    bindCheckbox('#textme_read_receipts', 'readReceipts', 'Read Receipts');

    // ── Schedule ──
    bindCheckbox('#textme_schedule_enabled', 'scheduleEnabled', 'Enable Schedule');

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

    $('#textme_open_schedule_modal').on('click', async function () {
        await openScheduleModal();
        renderScheduleEditor(document.getElementById('textme_schedule_editor'));
    });

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

    renderScheduleEditorWhenReady(document.getElementById('textme_schedule_editor'));

    // ── Autonomous ──
    $('#textme_autonomous_enabled').prop('checked', settings.autonomousEnabled).on('change', function () {
        const enabled = !!$(this).prop('checked');
        updateSetting('autonomousEnabled', enabled);
        context.saveSettingsDebounced();
        log.info(`[Settings] "Enable Autonomous Messages" toggled → ${enabled ? 'ON ✓' : 'OFF'}`);
        if (enabled) {
            startAutonomousTimer();
        } else {
            stopAutonomousTimer();
        }
    });

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
    bindCheckbox('#textme_cooldown_escalation', 'cooldownEscalation', 'Cooldown Escalation');

    // ── Appearance ──
    bindSelect('#textme_theme', 'theme');
    bindSelect('#textme_color_scheme', 'colorScheme');
    bindSelect('#textme_phone_size', 'phoneSize');
    bindSelect('#textme_phone_position', 'phonePosition');
    bindCheckbox('#textme_sound_effects', 'soundEffects', 'Sound Effects');
    bindCheckbox('#textme_show_timestamps', 'showTimestamps', 'Show Timestamps');
    bindCheckbox('#textme_browser_notifications', 'browserNotifications', 'Browser Notifications');

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
// Connection Profile Dropdown (issue #13)
// ═══════════════════════════════════════════════════════════════

/**
 * Initialize the Connection Profile <select> in General settings.
 *
 * Uses ConnectionManagerRequestService.handleDropdown() which:
 *   - Populates the dropdown with all compatible profiles (Chat + Text completion)
 *   - Groups them by API type
 *   - Keeps the list live via ST events (profile created/updated/deleted)
 *
 * Falls back gracefully if Connection Manager is disabled or unavailable.
 *
 * @param {object} settings
 * @param {object} context
 */
async function _initConnectionProfileDropdown(settings, context) {
    const $select = $('#textme_connection_profile');
    if (!$select.length) return;

    // Check Connection Manager availability
    try {
        if (context.extensionSettings?.disabledExtensions?.includes('connection-manager')) {
            $select.closest('.textme-profile-row').hide();
            log.debug('[Profile] Connection Manager disabled — profile selector hidden.');
            return;
        }

        const profiles = context.extensionSettings?.connectionManager?.profiles;
        if (!Array.isArray(profiles)) {
            $select.closest('.textme-profile-row').hide();
            log.debug('[Profile] No Connection Manager profiles found — selector hidden.');
            return;
        }
    } catch (e) {
        $select.closest('.textme-profile-row').hide();
        log.warn('[Profile] Could not check Connection Manager:', e);
        return;
    }

    try {
        // Use ST's shared helper which wires up all live events automatically
        const { ConnectionManagerRequestService } = await import('/scripts/extensions/shared.js');

        ConnectionManagerRequestService.handleDropdown(
            '#textme_connection_profile',
            settings.connectionProfileId || '',
            // onChange — called when user selects a profile OR when selected profile is deleted
            (profile) => {
                const newId   = profile?.id   || null;
                const newName = profile?.name || '(default)';
                updateSetting('connectionProfileId', newId);
                context.saveSettingsDebounced();
                if (newId) {
                    log.info(`[Profile] Connection profile selected: "${newName}" (id: ${newId})`);
                    toastr.info(`TextMe will use profile: ${newName}`, '', { timeOut: 2000 });
                } else {
                    log.info('[Profile] Connection profile cleared — using default ST connection.');
                }
            },
        );

        log.debug('[Profile] Connection profile dropdown initialized.');
    } catch (e) {
        // shared.js import failed — hide the row gracefully
        $select.closest('.textme-profile-row').hide();
        log.warn('[Profile] Could not load ConnectionManagerRequestService:', e);
    }
}

// ═══════════════════════════════════════════════════════════════
// Prompt Presets
// ═══════════════════════════════════════════════════════════════

const PRESET_PROMPT_KEYS = ['smsPrompt', 'summaryPrompt', 'schedulePrompt', 'autonomousPrompt', 'autonomousTaskPrompt'];

/**
 * Initialize the Prompt Presets UI block.
 */
function _initPromptPresets(settings, context) {
    if (!settings.promptPresets) settings.promptPresets = {};

    const $select = $('#textme_preset_select');
    if (!$select.length) return;

    _refreshPresetSelect(settings);

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

function _keyToInputId(key) {
    return key.replace(/([A-Z])/g, '_$1').toLowerCase();
}

function _keyToDefaultKey(key) {
    const explicit = {
        autonomousTaskPrompt: 'autonomousTask',
    };
    if (explicit[key]) return explicit[key];
    const stripped = key.replace(/Prompt$/, '');
    return stripped.charAt(0).toLowerCase() + stripped.slice(1);
}
