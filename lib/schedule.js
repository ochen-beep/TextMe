/**
 * TextMe — Schedule & Status system
 * License: AGPL-3.0
 *
 * FIX (v1.0.2): generateSchedule() now parses block format directly.
 *   The new schedule prompt generates scheduleBlocks (time ranges) natively.
 *   hourlyToBlocks() is kept only as a fallback for legacy 24-slot schedules.
 *
 * FIX (v1.0.2): Schedule modal now has max-height + overflow-y:auto
 *   so all 7 days are visible via scroll inside the ST Popup window.
 *
 * FEAT: manualStatus override — avatar click cycles online→idle→dnd→offline→schedule.
 * FEAT: Block-based schedule editor — time ranges instead of 24 hourly slots.
 */

import { getSettings, getPhoneData, savePhoneData, getCharName } from './state.js';
import { log } from './logger.js';

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const STATUSES = ['online', 'idle', 'dnd', 'offline'];

const STATUS_COLORS = {
    online:  '#34C759',
    idle:    '#FFCC00',
    dnd:     '#FF3B30',
    offline: '#8E8E93',
};

const STATUS_LABELS = {
    online:  'Online',
    idle:    'Idle',
    dnd:     'DND',
    offline: 'Offline',
};

// ═══════════════════════════════════════════════
// Manual status override (avatar click)
// ═══════════════════════════════════════════════

/**
 * Set a manual status override (persisted in phoneData.manualStatus).
 * Pass null to clear.
 */
export async function setManualStatus(status) {
    const phoneData = getPhoneData();
    if (!phoneData) return;
    phoneData.manualStatus = status || null;
    await savePhoneData();
    log.info('Manual status set to:', status);
}

/**
 * Clear manual status override.
 */
export async function clearManualStatus() {
    await setManualStatus(null);
}

/**
 * Cycle manual status: online → idle → dnd → offline → null (back to schedule).
 * If manualStatus is null, starts at 'online'.
 * Returns the new status string.
 */
export async function cycleManualStatus() {
    const phoneData = getPhoneData();
    if (!phoneData) return 'online';

    const current = phoneData.manualStatus;
    let next;
    if (!current) {
        next = 'online';
    } else {
        const idx = STATUSES.indexOf(current);
        // After last status (offline), wrap back to null = schedule-driven
        next = idx >= STATUSES.length - 1 ? null : STATUSES[idx + 1];
    }

    phoneData.manualStatus = next;
    await savePhoneData();
    log.info('Manual status cycled to:', next || '(schedule-driven)');
    return next;
}

// ═══════════════════════════════════════════════
// Status resolution
// ═══════════════════════════════════════════════

/**
 * Get the current status of the character.
 * Priority: manualStatus > scheduleBlocks > schedule (hourly) > 'online'
 * @returns {{ status: string, activity: string, isManual: boolean }}
 */
export function getCurrentStatus() {
    const phoneData = getPhoneData();

    // 1. Manual override
    if (phoneData?.manualStatus) {
        return {
            status: phoneData.manualStatus,
            activity: '',
            isManual: true,
        };
    }

    const settings = getSettings();
    if (!settings.scheduleEnabled) return { status: 'online', activity: '', isManual: false };

    if (!phoneData) return { status: 'online', activity: '', isManual: false };

    const now      = new Date();
    const dayIndex = (now.getDay() + 6) % 7; // Monday = 0
    const dayName  = DAYS[dayIndex];
    const hour     = now.getHours();

    // 2. Block-based schedule (new format)
    if (phoneData.scheduleBlocks?.[dayName]) {
        const blocks = phoneData.scheduleBlocks[dayName];
        const block  = blocks.find(b => hour >= b.start && hour < b.end);
        if (block) {
            return {
                status:   block.status   || 'online',
                activity: block.activity || '',
                isManual: false,
            };
        }
    }

    // 3. Legacy hourly schedule (fallback)
    if (phoneData.schedule?.[dayName]) {
        const daySchedule = phoneData.schedule[dayName];
        if (Array.isArray(daySchedule)) {
            const slot = daySchedule.find(s => s.hour === hour);
            if (slot) {
                return {
                    status:   slot.status   || 'online',
                    activity: slot.activity || '',
                    isManual: false,
                };
            }
        }
    }

    return { status: 'online', activity: '', isManual: false };
}

/**
 * Get status display info.
 */
export function getStatusInfo(status) {
    switch (status) {
        case 'online':  return { label: 'Online',          cssClass: 'textme-status-online',  emoji: '🟢' };
        case 'idle':    return { label: 'Idle',             cssClass: 'textme-status-idle',    emoji: '🟡' };
        case 'dnd':     return { label: 'Do Not Disturb',  cssClass: 'textme-status-dnd',     emoji: '🔴' };
        case 'offline': return { label: 'Offline',         cssClass: 'textme-status-offline', emoji: '⚫' };
        default:        return { label: 'Online',          cssClass: 'textme-status-online',  emoji: '🟢' };
    }
}

/**
 * Build schedule context string for prompt injection.
 */
export function getScheduleContext() {
    const settings = getSettings();
    const { status, activity, isManual } = getCurrentStatus();

    // If manual override AND schedule is disabled — still inject manual status
    if (!settings.scheduleEnabled && !isManual) return '';

    const { label } = getStatusInfo(status);

    let context = `\n[Current Status: ${label}`;
    if (isManual) context += ' (manual override)';
    if (activity) context += ` — ${activity}`;
    context += ']';

    if (status === 'dnd') {
        context += '\n[Status modifier: Respond very briefly, you are busy. One-liners only.]';
    } else if (status === 'idle') {
        context += '\n[Status modifier: You are not actively on your phone. Responses may be slightly delayed and casual.]';
    } else if (status === 'offline') {
        context += '\n[Status modifier: You are offline and should NOT respond.]';
    }

    return context;
}

// ═══════════════════════════════════════════════
// Schedule generation (AI)
// ═══════════════════════════════════════════════

/**
 * Generate a schedule for the character using AI.
 *
 * FIX (v1.0.2): The new schedule prompt generates block format directly.
 * We parse scheduleBlocks (time ranges) from the AI response.
 * No hourlyToBlocks() conversion needed — that was only for the old 24-slot format.
 *
 * @returns {Promise<object>} The scheduleBlocks object
 */
export async function generateSchedule() {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    const sub = context.substituteParams || ((s) => s;

    const { generateRaw } = context;
    if (!generateRaw) throw new Error('generateRaw not available');

    const charName = getCharName();
    log.info('Generating schedule for', charName);

    const scheduleInstruction = sub(settings.schedulePrompt);

    let charInfo = '';
    try {
        if (typeof context.getCharacterCardFields === 'function') {
            const fields = context.getCharacterCardFields();
            if (fields.description) charInfo += fields.description + '\n';
            if (fields.personality) charInfo += fields.personality + '\n';
            if (fields.scenario)    charInfo += fields.scenario    + '\n';
        } else {
            const char = context.characters?.[context.characterId];
            if (char) {
                if (char.description) charInfo += char.description + '\n';
                if (char.personality) charInfo += char.personality + '\n';
            }
        }
    } catch (e) { /* ignore */ }

    const systemPrompt = [
        scheduleInstruction,
        charInfo ? `[Character info for schedule generation]\n${charInfo.trim()}` : '',
        'IMPORTANT: Output ONLY the raw JSON object. No markdown, no code blocks, no explanation.',
    ].filter(Boolean).join('\n\n');

    const prompt = `Now generate the full weekly schedule for ${charName}. Output only the JSON.`;

    const result = await generateRaw({
        prompt,
        systemPrompt,
        max_new_tokens: 2000,
    });

    const raw = (typeof result === 'string' ? result : '').trim();

    if (!raw) {
        throw new Error('Empty response from AI. Check your API connection.');
    }

    log.debug('Schedule raw response length:', raw.length);

    let parsed;
    try {
        let cleaned = raw
            .replace(/^```(?:json)?\n?/i, '')
            .replace(/\n?```$/i, '')
            .replace(/<\/?[A-Za-z][^>]*>/g, '')
            .trim();

        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (jsonMatch) cleaned = jsonMatch[0];

        parsed = JSON.parse(cleaned);
    } catch (e) {
        log.error('Failed to parse schedule JSON:', raw.substring(0, 500));
        throw new Error('Failed to parse schedule. The AI returned invalid JSON.');
    }

    // Validate: each day must be an array
    for (const day of DAYS) {
        if (!parsed[day] || !Array.isArray(parsed[day])) {
            throw new Error(`Missing or invalid day in schedule: ${day}`);
        }
    }

    // Determine if the response is block format or legacy hourly format
    const firstDay   = parsed[DAYS[0]];
    const firstEntry = firstDay[0] || {};
    const isBlockFormat = Object.hasOwn(firstEntry, 'start') && Object.hasOwn(firstEntry, 'end');

    const phoneData = getPhoneData();
    if (phoneData) {
        if (isBlockFormat) {
            // New block format — store directly
            phoneData.scheduleBlocks = parsed;
            // Also generate legacy hourly for backward compat
            phoneData.schedule = blocksToHourly(parsed);
            log.info('Schedule generated in block format.');
        } else {
            // Legacy hourly format — convert to blocks
            phoneData.schedule       = parsed;
            phoneData.scheduleBlocks = hourlyToBlocks(parsed);
            log.info('Schedule generated in legacy hourly format, converted to blocks.');
        }
        await savePhoneData();
    }

    log.info('Schedule saved. Days:', DAYS.map(d => `${d}:${(phoneData?.scheduleBlocks?.[d] || []).length}blk`).join(', '));
    return phoneData?.scheduleBlocks || parsed;
}

// ═══════════════════════════════════════════════
// Hourly ↔ Block conversion (for legacy compat)
// ═══════════════════════════════════════════════

/**
 * Convert a legacy hourly schedule to block format.
 * Consecutive hours with the same status+activity are merged into one block.
 * @param {object} hourlySchedule
 * @returns {object} scheduleBlocks
 */
export function hourlyToBlocks(hourlySchedule) {
    if (!hourlySchedule) return null;
    const blocks = {};
    for (const day of DAYS) {
        const slots = hourlySchedule[day];
        if (!slots || !Array.isArray(slots)) {
            blocks[day] = [];
            continue;
        }
        const sorted = [...slots].sort((a, b) => a.hour - b.hour);
        const dayBlocks = [];
        let current = null;
        for (const slot of sorted) {
            if (!current) {
                current = { start: slot.hour, end: slot.hour + 1, status: slot.status, activity: slot.activity || '' };
            } else if (current.status === slot.status && current.activity === (slot.activity || '') && current.end === slot.hour) {
                current.end = slot.hour + 1;
            } else {
                dayBlocks.push(current);
                current = { start: slot.hour, end: slot.hour + 1, status: slot.status, activity: slot.activity || '' };
            }
        }
        if (current) dayBlocks.push(current);
        blocks[day] = dayBlocks;
    }
    return blocks;
}

/**
 * Convert block schedule back to legacy hourly format.
 * @param {object} blocksSchedule
 * @returns {object} hourly schedule
 */
export function blocksToHourly(blocksSchedule) {
    if (!blocksSchedule) return null;
    const hourly = {};
    for (const day of DAYS) {
        const blocks = blocksSchedule[day] || [];
        const slots = [];
        for (let h = 0; h < 24; h++) {
            const block = blocks.find(b => h >= b.start && h < b.end);
            slots.push({
                hour:     h,
                status:   block ? block.status   : 'online',
                activity: block ? block.activity : '',
            });
        }
        hourly[day] = slots;
    }
    return hourly;
}

// ═══════════════════════════════════════════════════════
// Schedule Modal Editor (block-based)
// ═══════════════════════════════════════════════════════

/**
 * Open the Schedule & Status modal editor.
 * FIX: Added max-height + overflow-y:auto to modal root so all 7 days
 * are reachable via scroll inside the ST Popup container.
 */
export async function openScheduleModal() {
    const context = SillyTavern.getContext();
    const { Popup, POPUP_TYPE } = context;

    if (!Popup) {
        toastr.error('SillyTavern Popup API not available. Update ST.');
        return;
    }

    const phoneData = getPhoneData();

    // Convert legacy hourly → blocks on first open
    if (!phoneData.scheduleBlocks && phoneData.schedule) {
        phoneData.scheduleBlocks = hourlyToBlocks(phoneData.schedule);
    }

    const html = buildModalHtml(phoneData.scheduleBlocks);

    let savedOk = false;

    const popup = new Popup(html, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        okButton: 'Save',
        cancelButton: 'Cancel',
        onClosing: (p) => {
            if (p.result === 1) {
                savedOk = true;
                saveFromModal(phoneData);
            }
            return true;
        },
    });

    requestAnimationFrame(wireModalEvents);

    await popup.show();

    if (savedOk) {
        toastr.success('Schedule saved.');
    }
}

// ─────────────────────────────────────────────────────
// Modal HTML builder (block-based)
// ─────────────────────────────────────────────────────

function fmtHour(h) {
    return String(h).padStart(2, '0') + ':00';
}

function escapeAttr(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function buildBlockRow(day, block, idx) {
    const color = STATUS_COLORS[block.status] || STATUS_COLORS.online;
    const label = STATUS_LABELS[block.status] || 'Online';
    return `
    <div class="textme-sched-block" data-day="${day}" data-idx="${idx}"
         style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid rgba(128,128,128,0.12);">

        <span style="color:var(--SmartThemeQuoteColor,#888);font-size:11px;white-space:nowrap;">
            <select class="textme-sched-start text_pole" data-day="${day}" data-idx="${idx}"
                    style="font-size:11px;padding:1px 2px;height:22px;width:62px;">
                ${buildHourOptions(block.start)}
            </select>
            –
            <select class="textme-sched-end text_pole" data-day="${day}" data-idx="${idx}"
                    style="font-size:11px;padding:1px 2px;height:22px;width:62px;">
                ${buildHourOptions(block.end, true)}
            </select>
        </span>

        <span class="textme-sched-status-badge"
              data-day="${day}" data-idx="${idx}" data-status="${block.status}"
              style="cursor:pointer;padding:2px 8px;border-radius:10px;background:${color};
                     color:#000;font-size:11px;font-weight:600;white-space:nowrap;user-select:none;"
              title="Click to cycle status">${label}</span>

        <input type="text"
               class="textme-sched-activity text_pole"
               data-day="${day}" data-idx="${idx}"
               value="${escapeAttr(block.activity || '')}"
               placeholder="Activity..."
               style="flex:1;font-size:12px;padding:2px 6px;height:24px;" />

        <button class="textme-sched-del-block menu_button" data-day="${day}" data-idx="${idx}"
                style="padding:1px 6px;font-size:12px;min-width:0;border-radius:6px;"
                title="Delete block">✕</button>
    </div>`;
}

function buildHourOptions(selected, isEnd = false) {
    let html = '';
    const start = isEnd ? 1 : 0;
    const end   = isEnd ? 25 : 24;
    for (let h = start; h < end; h++) {
        const sel = h === selected ? ' selected' : '';
        html += `<option value="${h}"${sel}>${fmtHour(h === 24 ? 0 : h)}${h === 24 ? ' (+1d)' : ''}</option>`;
    }
    return html;
}

function buildModalHtml(scheduleBlocks) {
    const charName = getCharName();

    // FIX: max-height + overflow-y:auto so all 7 days are scrollable
    // inside the ST Popup container without being clipped
    let html = `
    <div id="textme-sched-modal"
         style="font-size:13px;max-height:65vh;overflow-y:auto;overflow-x:hidden;padding-right:6px;">

        <h3 style="margin:0 0 8px;position:sticky;top:0;background:var(--SmartThemeBlurTintColor,#111);z-index:2;padding:6px 0 4px;">
            📅 Schedule &amp; Status Editor
        </h3>
        <p style="color:var(--SmartThemeQuoteColor,#888);margin:0 0 12px;font-size:12px">
            Time blocks define when <b>${escapeAttr(charName)}</b> is online/offline.<br>
            Click a status badge to cycle: Online → Idle → DND → Offline.<br>
            <b>💡 Tip:</b> Click the avatar in the phone header to manually override status.
        </p>`;

    if (!scheduleBlocks) {
        html += `<p style="color:var(--SmartThemeQuoteColor,#888);font-style:italic">
            No schedule generated yet. Close this and click "Generate Schedule" first.
        </p>`;
    } else {
        for (const day of DAYS) {
            const dayLabel  = day.charAt(0).toUpperCase() + day.slice(1);
            const dayBlocks = scheduleBlocks[day] || [];
            const isToday   = day === getCurrentDayName();

            html += `
            <details style="margin-bottom:8px;" ${isToday ? 'open' : ''}>
                <summary style="cursor:pointer;font-weight:600;padding:4px 0;display:flex;align-items:center;gap:8px;">
                    ${dayLabel}
                    <span style="font-size:11px;color:var(--SmartThemeQuoteColor,#888);font-weight:400;">
                        ${dayBlocks.length} block${dayBlocks.length !== 1 ? 's' : ''}
                    </span>
                    ${isToday ? '<span style="font-size:10px;background:var(--SmartThemeAccentColor,#7c3aed);color:#fff;padding:1px 6px;border-radius:8px;">today</span>' : ''}
                </summary>
                <div class="textme-sched-day-blocks" data-day="${day}"
                     style="padding:4px 0 4px 8px;">`;

            if (dayBlocks.length === 0) {
                html += `<p style="color:var(--SmartThemeQuoteColor,#888);font-size:12px;font-style:italic;margin:4px 0;">No blocks — character is always Online.</p>`;
            } else {
                dayBlocks.forEach((block, idx) => {
                    html += buildBlockRow(day, block, idx);
                });
            }

            html += `
                    <button class="textme-sched-add-block menu_button" data-day="${day}"
                            style="margin-top:6px;font-size:12px;padding:3px 10px;">
                        + Add Block
                    </button>
                </div>
            </details>`;
        }
    }

    html += `</div>`;
    return html;
}

function getCurrentDayName() {
    const dayIndex = (new Date().getDay() + 6) % 7;
    return DAYS[dayIndex];
}

// ─────────────────────────────────────────────────────
// Modal event wiring
// ─────────────────────────────────────────────────────

function wireModalEvents() {
    const modal = document.getElementById('textme-sched-modal');
    if (!modal) {
        requestAnimationFrame(wireModalEvents);
        return;
    }

    // Cycle status badge on click
    modal.addEventListener('click', (e) => {
        // Status badge cycle
        const badge = e.target.closest('.textme-sched-status-badge');
        if (badge) {
            const currentStatus = badge.dataset.status;
            const currentIdx    = STATUSES.indexOf(currentStatus);
            const nextStatus    = STATUSES[(currentIdx + 1) % STATUSES.length];
            badge.dataset.status   = nextStatus;
            badge.textContent      = STATUS_LABELS[nextStatus];
            badge.style.background = STATUS_COLORS[nextStatus];
            return;
        }

        // Delete block
        const delBtn = e.target.closest('.textme-sched-del-block');
        if (delBtn) {
            const blockRow = delBtn.closest('.textme-sched-block');
            if (blockRow) blockRow.remove();
            reindexDay(modal, delBtn.dataset.day);
            return;
        }

        // Add block
        const addBtn = e.target.closest('.textme-sched-add-block');
        if (addBtn) {
            const day      = addBtn.dataset.day;
            const dayDiv   = modal.querySelector(`.textme-sched-day-blocks[data-day="${day}"]`);
            if (!dayDiv) return;

            // Remove "no blocks" placeholder if present
            const placeholder = dayDiv.querySelector('p');
            if (placeholder) placeholder.remove();

            const existingBlocks = dayDiv.querySelectorAll('.textme-sched-block');
            const idx = existingBlocks.length;

            // Default new block: 12:00–13:00 online
            const newBlock = { start: 12, end: 13, status: 'online', activity: '' };
            const rowHtml  = buildBlockRow(day, newBlock, idx);

            addBtn.insertAdjacentHTML('beforebegin', rowHtml);
        }
    });
}

function reindexDay(modal, day) {
    const dayDiv = modal.querySelector(`.textme-sched-day-blocks[data-day="${day}"]`);
    if (!dayDiv) return;
    const rows = dayDiv.querySelectorAll('.textme-sched-block');
    rows.forEach((row, i) => {
        row.dataset.idx = i;
        row.querySelectorAll('[data-idx]').forEach(el => { el.dataset.idx = i; });
    });
}

// ─────────────────────────────────────────────────────
// Save modal state to phoneData
// ─────────────────────────────────────────────────────

function saveFromModal(phoneData) {
    const modal = document.getElementById('textme-sched-modal');
    if (!modal) return;

    const newBlocks = {};

    for (const day of DAYS) {
        const dayDiv = modal.querySelector(`.textme-sched-day-blocks[data-day="${day}"]`);
        if (!dayDiv) { newBlocks[day] = []; continue; }

        const rows = dayDiv.querySelectorAll('.textme-sched-block');
        const dayBlockList = [];

        rows.forEach(row => {
            const startEl    = row.querySelector('.textme-sched-start');
            const endEl      = row.querySelector('.textme-sched-end');
            const badge      = row.querySelector('.textme-sched-status-badge');
            const activityEl = row.querySelector('.textme-sched-activity');

            if (!startEl || !endEl || !badge) return;

            const start    = parseInt(startEl.value, 10);
            const end      = parseInt(endEl.value, 10);
            const status   = badge.dataset.status || 'online';
            const activity = activityEl ? activityEl.value.trim() : '';

            if (start < end) {
                dayBlockList.push({ start, end, status, activity });
            }
        });

        dayBlockList.sort((a, b) => a.start - b.start);
        newBlocks[day] = dayBlockList;
    }

    phoneData.scheduleBlocks = newBlocks;
    phoneData.schedule = blocksToHourly(newBlocks);

    savePhoneData().catch(e => log.error('Failed to save schedule from modal:', e));
}

// ─────────────────────────────────────────────────────
// Inline settings panel render (read-only summary)
// ─────────────────────────────────────────────────────

/**
 * Render a compact read-only status summary in the settings panel.
 */
export function renderScheduleEditor(container) {
    if (!container) return;

    const phoneData = getPhoneData();
    const hasSchedule = phoneData?.scheduleBlocks || phoneData?.schedule;

    if (!hasSchedule) {
        container.innerHTML = '<p style="color:var(--SmartThemeQuoteColor,#888);font-style:italic;">No schedule generated yet. Click "Generate Schedule" above, then use the "Schedule &amp; Status" button to edit.</p>';
        return;
    }

    const { status, activity, isManual } = getCurrentStatus();
    const { label } = getStatusInfo(status);
    const color = STATUS_COLORS[status] || STATUS_COLORS.online;

    let blockSummary = '';
    if (phoneData.scheduleBlocks) {
        const counts = DAYS.map(d => (phoneData.scheduleBlocks[d] || []).length);
        blockSummary = `<br><span style="color:var(--SmartThemeQuoteColor,#888);">Blocks per day: ${counts.join(' / ')}</span>`;
    }

    container.innerHTML = `
        <div style="padding:8px;border-radius:6px;background:rgba(128,128,128,0.1);font-size:12px;margin-top:6px;">
            <b>Current status:</b>
            <span style="color:${color};font-weight:600">${label}</span>
            ${isManual ? '<span style="color:var(--SmartThemeQuoteColor,#888)"> (manual override)</span>' : ''}
            ${activity ? `<span style="color:var(--SmartThemeQuoteColor,#888)"> — ${escapeAttr(activity)}</span>` : ''}<br>
            ${blockSummary}
            <span style="color:var(--SmartThemeQuoteColor,#888);">Schedule loaded ✓ Use the "Schedule &amp; Status" button above to edit.</span>
        </div>`;
}
