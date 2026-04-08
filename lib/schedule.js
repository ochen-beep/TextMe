/**
 * TextMe — Schedule & Status system
 * License: AGPL-3.0
 *
 * REDESIGN (v1.0.3): Two-level Schedule Editor UI
 *
 * Level 1 — Main modal (openScheduleModal):
 *   Shows all 7 days as compact rows.
 *   Each row: day name | color timeline bar (proportional segments) | "Edit" button.
 *   Minimal height, fits without inner scroll.
 *   "Save" persists any direct edits; "Edit" per day opens Level 2.
 *
 * Level 2 — Per-day popup (openDayEditor):
 *   Shows only one day's blocks as a clean list:
 *     [HH:00 ▾] — [HH:00 ▾]  [Status ▾]  [Activity text]  [×]
 *   "+ Add Block" at the bottom.
 *   "Save Day" / "Cancel" buttons.
 *   Stacks on top of the main modal via a second Popup.
 *
 * FIX: stripSpeakerPrefix per-part in prompt-engine.js (separate file).
 * FEAT: manualStatus override — avatar click cycles statuses.
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

export async function setManualStatus(status) {
    const phoneData = getPhoneData();
    if (!phoneData) return;
    phoneData.manualStatus = status || null;
    await savePhoneData();
    log.info('Manual status set to:', status);
}

export async function clearManualStatus() {
    await setManualStatus(null);
}

export async function cycleManualStatus() {
    const phoneData = getPhoneData();
    if (!phoneData) return 'online';

    const current = phoneData.manualStatus;
    let next;
    if (!current) {
        next = 'online';
    } else {
        const idx = STATUSES.indexOf(current);
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

export function getCurrentStatus() {
    const phoneData = getPhoneData();

    if (phoneData?.manualStatus) {
        return { status: phoneData.manualStatus, activity: '', isManual: true };
    }

    const settings = getSettings();
    if (!settings.scheduleEnabled) return { status: 'online', activity: '', isManual: false };
    if (!phoneData) return { status: 'online', activity: '', isManual: false };

    const now      = new Date();
    const dayIndex = (now.getDay() + 6) % 7;
    const dayName  = DAYS[dayIndex];
    const hour     = now.getHours();

    if (phoneData.scheduleBlocks?.[dayName]) {
        const blocks = phoneData.scheduleBlocks[dayName];
        const block  = blocks.find(b => hour >= b.start && hour < b.end);
        if (block) {
            return { status: block.status || 'online', activity: block.activity || '', isManual: false };
        }
    }

    if (phoneData.schedule?.[dayName]) {
        const daySchedule = phoneData.schedule[dayName];
        if (Array.isArray(daySchedule)) {
            const slot = daySchedule.find(s => s.hour === hour);
            if (slot) {
                return { status: slot.status || 'online', activity: slot.activity || '', isManual: false };
            }
        }
    }

    return { status: 'online', activity: '', isManual: false };
}

export function getStatusInfo(status) {
    switch (status) {
        case 'online':  return { label: 'Online',         cssClass: 'textme-status-online',  emoji: '🟢' };
        case 'idle':    return { label: 'Idle',            cssClass: 'textme-status-idle',    emoji: '🟡' };
        case 'dnd':     return { label: 'Do Not Disturb', cssClass: 'textme-status-dnd',     emoji: '🔴' };
        case 'offline': return { label: 'Offline',        cssClass: 'textme-status-offline', emoji: '⚫' };
        default:        return { label: 'Online',         cssClass: 'textme-status-online',  emoji: '🟢' };
    }
}

export function getScheduleContext() {
    const settings = getSettings();
    const { status, activity, isManual } = getCurrentStatus();

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

export async function generateSchedule() {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    const sub = context.substituteParams || ((s) => s);

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
    if (!raw) throw new Error('Empty response from AI. Check your API connection.');

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

    for (const day of DAYS) {
        if (!parsed[day] || !Array.isArray(parsed[day])) {
            throw new Error(`Missing or invalid day in schedule: ${day}`);
        }
    }

    const firstDay   = parsed[DAYS[0]];
    const firstEntry = firstDay[0] || {};
    const isBlockFormat = Object.hasOwn(firstEntry, 'start') && Object.hasOwn(firstEntry, 'end');

    const phoneData = getPhoneData();
    if (phoneData) {
        if (isBlockFormat) {
            phoneData.scheduleBlocks = parsed;
            phoneData.schedule = blocksToHourly(parsed);
            log.info('Schedule generated in block format.');
        } else {
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
// Hourly ↔ Block conversion
// ═══════════════════════════════════════════════

export function hourlyToBlocks(hourlySchedule) {
    if (!hourlySchedule) return null;
    const blocks = {};
    for (const day of DAYS) {
        const slots = hourlySchedule[day];
        if (!slots || !Array.isArray(slots)) { blocks[day] = []; continue; }
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
// Timeline bar helper
// ═══════════════════════════════════════════════════════

/**
 * Build an inline SVG-like color bar representing a day's schedule.
 * Uses flex segments proportional to block duration (out of 24 h).
 */
function buildTimelineBar(blocks) {
    if (!blocks || blocks.length === 0) {
        return `<div style="flex:1;height:18px;border-radius:4px;background:${STATUS_COLORS.online};opacity:0.5;"></div>`;
    }

    // Sort blocks
    const sorted = [...blocks].sort((a, b) => a.start - b.start);

    // Fill gaps with 'online'
    const filled = [];
    let cursor = 0;
    for (const b of sorted) {
        if (b.start > cursor) {
            filled.push({ start: cursor, end: b.start, status: 'online', activity: '' });
        }
        filled.push(b);
        cursor = b.end;
    }
    if (cursor < 24) {
        filled.push({ start: cursor, end: 24, status: 'online', activity: '' });
    }

    const segments = filled.map(b => {
        const pct   = ((b.end - b.start) / 24 * 100).toFixed(2);
        const color = STATUS_COLORS[b.status] || STATUS_COLORS.online;
        const title = `${String(b.start).padStart(2,'0')}:00–${String(b.end === 24 ? 0 : b.end).padStart(2,'0')}:00 ${STATUS_LABELS[b.status] || 'Online'}${b.activity ? ': ' + b.activity : ''}`;
        return `<div title="${title.replace(/"/g,'&quot;')}" style="flex:${pct};height:18px;background:${color};min-width:2px;"></div>`;
    }).join('');

    return `<div style="display:flex;flex:1;border-radius:4px;overflow:hidden;gap:1px;">${segments}</div>`;
}

// ═══════════════════════════════════════════════════════
// Level 1 — Main Schedule Modal
// ═══════════════════════════════════════════════════════

export async function openScheduleModal() {
    const context = SillyTavern.getContext();
    const { Popup, POPUP_TYPE } = context;

    if (!Popup) {
        toastr.error('SillyTavern Popup API not available. Update ST.');
        return;
    }

    const phoneData = getPhoneData();

    // Migrate legacy hourly → blocks on first open
    if (!phoneData.scheduleBlocks && phoneData.schedule) {
        phoneData.scheduleBlocks = hourlyToBlocks(phoneData.schedule);
    }

    const html = buildMainModalHtml(phoneData.scheduleBlocks);

    const popup = new Popup(html, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        okButton: 'Close',
        cancelButton: null,
    });

    // Wire Edit buttons after DOM is ready
    requestAnimationFrame(() => wireMainModal(phoneData, popup));

    await popup.show();
}

function buildMainModalHtml(scheduleBlocks) {
    const charName = getCharName();
    const todayName = getCurrentDayName();

    let html = `
    <div id="textme-sched-main" style="font-size:13px;padding:4px 0;">
        <h3 style="margin:0 0 10px;text-align:center;">📅 Schedule &amp; Status Editor</h3>
        <p style="color:var(--SmartThemeQuoteColor,#888);margin:0 0 14px;font-size:12px;text-align:center;">
            Time blocks define when <b>${escapeAttr(charName)}</b> is online/offline.<br>
            Click <b>Edit</b> on any day to modify its schedule.
        </p>`;

    // Legend
    html += `
        <div style="display:flex;gap:12px;margin-bottom:12px;flex-wrap:wrap;">
            ${Object.entries(STATUS_COLORS).map(([s, c]) =>
                `<span style="display:flex;align-items:center;gap:4px;font-size:11px;">
                    <span style="width:10px;height:10px;border-radius:50%;background:${c};display:inline-block;"></span>
                    ${STATUS_LABELS[s]}
                </span>`
            ).join('')}
        </div>`;

    if (!scheduleBlocks) {
        html += `<p style="color:var(--SmartThemeQuoteColor,#888);font-style:italic;text-align:center;padding:20px 0;">
            No schedule generated yet.<br>Close this and click "Generate Schedule" first.
        </p>`;
    } else {
        html += `<div style="display:flex;flex-direction:column;gap:6px;">`;
        for (const day of DAYS) {
            const dayLabel  = day.charAt(0).toUpperCase() + day.slice(1);
            const dayBlocks = scheduleBlocks[day] || [];
            const isToday   = day === todayName;
            const todayBadge = isToday
                ? `<span style="font-size:10px;background:var(--SmartThemeAccentColor,#7c3aed);color:#fff;padding:1px 6px;border-radius:8px;margin-left:4px;">today</span>`
                : '';

            html += `
            <div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;background:rgba(128,128,128,0.08);">
                <span style="font-weight:${isToday ? '700' : '600'};width:82px;flex-shrink:0;font-size:12px;">
                    ${dayLabel}${todayBadge}
                </span>
                ${buildTimelineBar(dayBlocks)}
                <button class="textme-sched-edit-day menu_button"
                        data-day="${day}"
                        style="flex-shrink:0;font-size:11px;padding:3px 10px;">
                    Edit
                </button>
            </div>`;
        }
        html += `</div>`;
    }

    html += `</div>`;
    return html;
}

function wireMainModal(phoneData, parentPopup) {
    const modal = document.getElementById('textme-sched-main');
    if (!modal) {
        requestAnimationFrame(() => wireMainModal(phoneData, parentPopup));
        return;
    }

    modal.addEventListener('click', async (e) => {
        const btn = e.target.closest('.textme-sched-edit-day');
        if (!btn) return;

        const day = btn.dataset.day;
        await openDayEditor(day, phoneData);

        // Refresh timeline bars after editing
        refreshMainModal(phoneData);
    });
}

function refreshMainModal(phoneData) {
    const modal = document.getElementById('textme-sched-main');
    if (!modal) return;

    for (const day of DAYS) {
        const btn = modal.querySelector(`.textme-sched-edit-day[data-day="${day}"]`);
        if (!btn) continue;
        const row = btn.closest('div[style]');
        if (!row) continue;

        // Find the timeline bar div (second child after the name span)
        const barContainer = row.querySelector('div[style*="display:flex"][style*="border-radius:4px"]');
        if (barContainer) {
            const newBar = buildTimelineBar(phoneData.scheduleBlocks?.[day] || []);
            barContainer.outerHTML = newBar;
        }
    }
}

// ═══════════════════════════════════════════════════════
// Level 2 — Per-day Editor Popup
// ═══════════════════════════════════════════════════════

async function openDayEditor(day, phoneData) {
    const context = SillyTavern.getContext();
    const { Popup, POPUP_TYPE } = context;
    if (!Popup) return;

    // Ensure scheduleBlocks exists for this day
    if (!phoneData.scheduleBlocks) phoneData.scheduleBlocks = {};
    if (!phoneData.scheduleBlocks[day]) phoneData.scheduleBlocks[day] = [];

    const dayLabel = day.charAt(0).toUpperCase() + day.slice(1);
    const html = buildDayEditorHtml(day, phoneData.scheduleBlocks[day]);

    let saved = false;

    const popup = new Popup(html, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: false,
        okButton: 'Save Day',
        cancelButton: 'Cancel',
        onClosing: (p) => {
            if (p.result === 1) {
                saved = true;
                saveDay(day, phoneData);
            }
            return true;
        },
    });

    requestAnimationFrame(() => wireDayEditor(day));

    await popup.show();

    if (saved) {
        toastr.success(`${dayLabel} schedule saved.`);
    }

    return saved;
}

function buildDayEditorHtml(day, blocks) {
    const dayLabel = day.charAt(0).toUpperCase() + day.slice(1);

    let html = `
    <div id="textme-day-editor" data-day="${day}"
         style="font-size:13px;max-height:60vh;overflow-y:auto;overflow-x:hidden;padding-right:4px;">
        <h3 style="margin:0 0 12px;">${dayLabel} Schedule</h3>`;

    html += `<div class="textme-day-blocks" data-day="${day}">`;

    if (!blocks || blocks.length === 0) {
        html += `<p class="textme-day-empty" style="color:var(--SmartThemeQuoteColor,#888);font-style:italic;margin:4px 0 12px;">No blocks — character is always Online.</p>`;
    } else {
        blocks.forEach((block, idx) => {
            html += buildDayBlockRow(day, block, idx);
        });
    }

    html += `</div>
        <button class="textme-day-add-block menu_button" data-day="${day}"
                style="margin-top:8px;font-size:12px;padding:4px 14px;">
            + Add Block
        </button>
    </div>`;

    return html;
}

function buildDayBlockRow(day, block, idx) {
    const color = STATUS_COLORS[block.status] || STATUS_COLORS.online;
    const startH = String(block.start).padStart(2, '0');
    const endH   = block.end === 24 ? '00' : String(block.end).padStart(2, '0');
    const endSuffix = block.end === 24 ? ' (+1d)' : '';

    return `
    <div class="textme-day-block-row" data-idx="${idx}"
         style="display:flex;align-items:center;gap:6px;padding:5px 0;
                border-bottom:1px solid rgba(128,128,128,0.12);">

        <!-- Start time -->
        <select class="textme-day-start text_pole" data-idx="${idx}"
                style="font-size:11px;padding:2px;height:24px;width:64px;">
            ${buildHourOptions(block.start, false)}
        </select>
        <span style="color:var(--SmartThemeQuoteColor,#888);font-size:12px;">–</span>
        <!-- End time -->
        <select class="textme-day-end text_pole" data-idx="${idx}"
                style="font-size:11px;padding:2px;height:24px;width:72px;">
            ${buildHourOptions(block.end, true)}
        </select>

        <!-- Status badge (click to cycle) -->
        <span class="textme-day-status-badge"
              data-idx="${idx}" data-status="${block.status}"
              style="cursor:pointer;padding:3px 10px;border-radius:12px;
                     background:${color};color:#000;
                     font-size:11px;font-weight:700;white-space:nowrap;
                     user-select:none;min-width:52px;text-align:center;"
              title="Click to cycle status">
            ${STATUS_LABELS[block.status] || 'Online'}
        </span>

        <!-- Activity -->
        <input type="text"
               class="textme-day-activity text_pole"
               data-idx="${idx}"
               value="${escapeAttr(block.activity || '')}"
               placeholder="Activity..."
               style="flex:1;font-size:12px;padding:2px 6px;height:24px;" />

        <!-- Delete -->
        <button class="textme-day-del-row menu_button" data-idx="${idx}"
                style="padding:1px 7px;font-size:13px;min-width:0;border-radius:6px;
                       background:rgba(255,60,60,0.15);color:#ff3c3c;"
                title="Delete block">×</button>
    </div>`;
}

function buildHourOptions(selected, isEnd) {
    let html = '';
    const start = isEnd ? 1 : 0;
    const end   = isEnd ? 25 : 24;
    for (let h = start; h < end; h++) {
        const label = `${String(h === 24 ? 0 : h).padStart(2,'0')}:00${h === 24 ? ' (+1d)' : ''}`;
        const sel   = h === selected ? ' selected' : '';
        html += `<option value="${h}"${sel}>${label}</option>`;
    }
    return html;
}

function wireDayEditor(day) {
    const editor = document.getElementById('textme-day-editor');
    if (!editor) {
        requestAnimationFrame(() => wireDayEditor(day));
        return;
    }

    editor.addEventListener('click', (e) => {
        // Cycle status badge
        const badge = e.target.closest('.textme-day-status-badge');
        if (badge) {
            const cur  = badge.dataset.status;
            const next = STATUSES[(STATUSES.indexOf(cur) + 1) % STATUSES.length];
            badge.dataset.status   = next;
            badge.textContent      = STATUS_LABELS[next];
            badge.style.background = STATUS_COLORS[next];
            return;
        }

        // Delete row
        const del = e.target.closest('.textme-day-del-row');
        if (del) {
            const row = del.closest('.textme-day-block-row');
            if (row) row.remove();
            reindexDayEditor(editor);

            // Show empty placeholder if no rows left
            const blocksDiv = editor.querySelector('.textme-day-blocks');
            if (blocksDiv && blocksDiv.querySelectorAll('.textme-day-block-row').length === 0) {
                if (!blocksDiv.querySelector('.textme-day-empty')) {
                    blocksDiv.insertAdjacentHTML('beforeend',
                        `<p class="textme-day-empty" style="color:var(--SmartThemeQuoteColor,#888);font-style:italic;margin:4px 0 12px;">No blocks — character is always Online.</p>`);
                }
            }
            return;
        }

        // Add block
        const addBtn = e.target.closest('.textme-day-add-block');
        if (addBtn) {
            const blocksDiv = editor.querySelector('.textme-day-blocks');
            if (!blocksDiv) return;

            const placeholder = blocksDiv.querySelector('.textme-day-empty');
            if (placeholder) placeholder.remove();

            const existing = blocksDiv.querySelectorAll('.textme-day-block-row');
            const idx = existing.length;

            // Default: start after last block or at 12:00
            let defaultStart = 12;
            let defaultEnd   = 13;
            if (existing.length > 0) {
                const lastRow = existing[existing.length - 1];
                const lastEnd = parseInt(lastRow.querySelector('.textme-day-end')?.value || '13', 10);
                defaultStart = Math.min(lastEnd, 23);
                defaultEnd   = Math.min(defaultStart + 1, 24);
            }

            const newBlock = { start: defaultStart, end: defaultEnd, status: 'online', activity: '' };
            blocksDiv.insertAdjacentHTML('beforeend', buildDayBlockRow(day, newBlock, idx));
        }
    });
}

function reindexDayEditor(editor) {
    const rows = editor.querySelectorAll('.textme-day-block-row');
    rows.forEach((row, i) => {
        row.dataset.idx = i;
        row.querySelectorAll('[data-idx]').forEach(el => { el.dataset.idx = i; });
    });
}

function saveDay(day, phoneData) {
    const editor = document.getElementById('textme-day-editor');
    if (!editor) return;

    const rows = editor.querySelectorAll('.textme-day-block-row');
    const dayBlocks = [];

    rows.forEach(row => {
        const startEl    = row.querySelector('.textme-day-start');
        const endEl      = row.querySelector('.textme-day-end');
        const badge      = row.querySelector('.textme-day-status-badge');
        const activityEl = row.querySelector('.textme-day-activity');

        if (!startEl || !endEl || !badge) return;

        const start    = parseInt(startEl.value, 10);
        const end      = parseInt(endEl.value, 10);
        const status   = badge.dataset.status || 'online';
        const activity = activityEl ? activityEl.value.trim() : '';

        if (start < end) {
            dayBlocks.push({ start, end, status, activity });
        }
    });

    dayBlocks.sort((a, b) => a.start - b.start);

    if (!phoneData.scheduleBlocks) phoneData.scheduleBlocks = {};
    phoneData.scheduleBlocks[day] = dayBlocks;
    phoneData.schedule = blocksToHourly(phoneData.scheduleBlocks);

    savePhoneData().catch(e => log.error('Failed to save day schedule:', e));
}

// ─────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────

function getCurrentDayName() {
    const dayIndex = (new Date().getDay() + 6) % 7;
    return DAYS[dayIndex];
}

function escapeAttr(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ─────────────────────────────────────────────────────
// Inline settings panel render (read-only summary)
// ─────────────────────────────────────────────────────

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
