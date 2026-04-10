/**
 * TextMe — Schedule & Status system
 * License: AGPL-3.0
 *
 * v1.1.0 — Block format migrated to {from:"HH:MM", to:"HH:MM"} (minutes-precise).
 *          Legacy {start:int, end:int} data is auto-migrated on read.
 *          getCurrentStatus() uses getCurrentTime() to respect custom game time.
 *
 * Two-level Schedule Editor UI:
 *   Level 1 — openScheduleModal: all 7 days as compact rows with timeline bar.
 *   Level 2 — openDayEditor: per-day block list with time inputs (HH:MM).
 */

import { getSettings, getPhoneData, savePhoneData, getCharName, getUserName } from './state.js';
import { getCurrentTime } from './custom-time.js';
import { log } from './logger.js';

const DAYS    = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
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

// ═══════════════════════════════════════════════════════════════
// Time string helpers
// ═══════════════════════════════════════════════════════════════

/**
 * Convert integer hour (0–24) to "HH:MM" string.
 * 24 → "24:00" (end-of-day sentinel for display).
 * @param {number} h
 * @returns {string}
 */
function hourToTimeStr(h) {
    return `${String(h).padStart(2, '0')}:00`;
}

/**
 * Parse "HH:MM" to total minutes from midnight.
 * @param {string} t
 * @returns {number}
 */
function timeStrToMinutes(t) {
    if (!t || typeof t !== 'string') return 0;
    const [hh, mm] = t.split(':').map(Number);
    return (hh || 0) * 60 + (mm || 0);
}

/**
 * Pad minutes-from-midnight back to "HH:MM".
 * @param {number} mins
 * @returns {string}
 */
function minutesToTimeStr(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Migrate a single block from old integer format to new string format.
 * {start:int, end:int} → {from:"HH:MM", to:"HH:MM"}
 * Already-migrated blocks (with from/to) pass through unchanged.
 * @param {object} b
 * @returns {object}
 */
function migrateBlock(b) {
    if (b.from !== undefined && b.to !== undefined) return b;
    return {
        from:     hourToTimeStr(b.start ?? 0),
        to:       hourToTimeStr(b.end   ?? 1),
        status:   b.status   || 'online',
        activity: b.activity || '',
    };
}

/**
 * Migrate a full scheduleBlocks object (all days) in-place.
 * @param {object} blocks
 * @returns {object} same reference, migrated
 */
function migrateBlocksFormat(blocks) {
    if (!blocks) return blocks;
    for (const day of DAYS) {
        if (Array.isArray(blocks[day])) {
            blocks[day] = blocks[day].map(migrateBlock);
        }
    }
    return blocks;
}

/**
 * Get current HH:MM string from a Date.
 * @param {Date} d
 * @returns {string}
 */
function dateToHHMM(d) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

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
// Status resolution — uses getCurrentTime()
// ═══════════════════════════════════════════════

export function getCurrentStatus() {
    const phoneData = getPhoneData();

    if (phoneData?.manualStatus) {
        return { status: phoneData.manualStatus, activity: '', isManual: true };
    }

    const settings = getSettings();
    if (!settings.scheduleEnabled) return { status: 'online', activity: '', isManual: false };
    if (!phoneData) return { status: 'online', activity: '', isManual: false };

    // FIX: use getCurrentTime() so custom game time is respected
    const now      = getCurrentTime();
    const dayIndex = (now.getDay() + 6) % 7;   // Mon=0 … Sun=6
    const dayName  = DAYS[dayIndex];
    const currentHHMM = dateToHHMM(now);

    // Prefer new block format (from/to strings)
    if (phoneData.scheduleBlocks?.[dayName]) {
        // Migrate on-the-fly if still in old integer format
        phoneData.scheduleBlocks[dayName] = phoneData.scheduleBlocks[dayName].map(migrateBlock);

        const block = phoneData.scheduleBlocks[dayName].find(b =>
            currentHHMM >= b.from && currentHHMM < b.to
        );
        if (block) {
            return { status: block.status || 'online', activity: block.activity || '', isManual: false };
        }
    }

    // Legacy hourly fallback
    if (phoneData.schedule?.[dayName] && Array.isArray(phoneData.schedule[dayName])) {
        const hour = now.getHours();
        const slot = phoneData.schedule[dayName].find(s => s.hour === hour);
        if (slot) {
            return { status: slot.status || 'online', activity: slot.activity || '', isManual: false };
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
// getCurrentDayName — also uses getCurrentTime()
// ═══════════════════════════════════════════════

function getCurrentDayName() {
    const now = getCurrentTime();
    const dayIndex = (now.getDay() + 6) % 7;
    return DAYS[dayIndex];
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

    // ── Optional: recent RP context ───────────────────────────────────────
    let rpContextBlock = '';
    if (settings.scheduleIncludeContext) {
        try {
            const rpChat  = context.chat ?? [];
            const limit   = settings.contextMessages || 10;
            const sliced  = limit > 0 ? rpChat.slice(-limit) : rpChat;
            const userName = getUserName();
            const lines = sliced
                .filter(m => !m.is_system && m.mes)
                .map(m => `${m.name}: ${m.mes}`);
            if (lines.length > 0) {
                rpContextBlock = `[Recent RP events — use as context for the character's current mood and activities]\n${lines.join('\n')}`;
                log.debug('Schedule gen: injecting', lines.length, 'RP context messages.');
            }
        } catch (e) {
            log.warn('Schedule gen: failed to collect RP context:', e);
        }
    }

    // ── Optional: active World Info / lorebook entries ────────────────────
    let wiBlock = '';
    if (settings.scheduleIncludeWI) {
        try {
            if (typeof context.getWorldInfoPrompt === 'function') {
                const phoneData = getPhoneData();
                const wiDepth   = settings.wiScanDepth ?? 50;

                // Build a scan buffer from SMS history (same as assembleSystemPrompt)
                const smsMessages = phoneData?.messages ?? [];
                const sliced = wiDepth > 0 ? smsMessages.slice(-wiDepth) : smsMessages;
                const userName = getUserName();
                const scanLines = [];
                for (const m of sliced) {
                    if (m.type === 'image' || !m.text) continue;
                    scanLines.push(`${m.isUser ? userName : charName}: ${m.text}`);
                }

                const maxContext = context.max_context || 4096;
                const result     = await context.getWorldInfoPrompt(scanLines.reverse(), maxContext, true);
                let wiText = result?.worldInfoString || (typeof result === 'string' ? result : '');

                // Fallback to activated entries
                if (!wiText && context.activatedWorldInfo?.length > 0) {
                    wiText = context.activatedWorldInfo
                        .filter(e => e?.content)
                        .map(e => e.content)
                        .join('\n\n');
                }

                if (wiText?.trim()) {
                    wiBlock = `[World Info / Lorebook — use as additional character context]\n${wiText.trim()}`;
                    log.debug('Schedule gen: injecting WI block, length:', wiText.length);
                }
            }
        } catch (e) {
            log.warn('Schedule gen: failed to collect World Info:', e);
        }
    }

    const systemPrompt = [
        scheduleInstruction,
        charInfo ? `[Character info for schedule generation]\n${charInfo.trim()}` : '',
        rpContextBlock,
        wiBlock,
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

    // Detect format and normalize everything to {from, to} strings
    const firstDay   = parsed[DAYS[0]];
    const firstEntry = firstDay[0] || {};
    const isOldIntFormat = Object.hasOwn(firstEntry, 'start') && Object.hasOwn(firstEntry, 'end') && !firstEntry.from;

    let scheduleBlocks;
    if (isOldIntFormat) {
        // Old integer format → migrate to string format
        scheduleBlocks = {};
        for (const day of DAYS) {
            scheduleBlocks[day] = (parsed[day] || []).map(migrateBlock);
        }
        log.info('Schedule generated in old integer format — migrated to HH:MM strings.');
    } else {
        // Already {from, to} string format (or partially migrated)
        scheduleBlocks = {};
        for (const day of DAYS) {
            scheduleBlocks[day] = (parsed[day] || []).map(migrateBlock);
        }
        log.info('Schedule generated in HH:MM string format.');
    }

    const phoneData = getPhoneData();
    if (phoneData) {
        phoneData.scheduleBlocks = scheduleBlocks;
        // Keep legacy hourly for any code that still reads it
        phoneData.schedule = blocksToHourly(scheduleBlocks);
        await savePhoneData();
    }

    log.info('Schedule saved. Days:', DAYS.map(d => `${d}:${(scheduleBlocks[d] || []).length}blk`).join(', '));
    return scheduleBlocks;
}

// ═══════════════════════════════════════════════
// Conversion helpers (legacy compatibility)
// ═══════════════════════════════════════════════

/**
 * Convert new {from, to} block format to legacy hourly slots.
 * Used to keep phoneData.schedule in sync for older callers.
 */
export function blocksToHourly(blocksSchedule) {
    if (!blocksSchedule) return null;
    const hourly = {};
    for (const day of DAYS) {
        const blocks = (blocksSchedule[day] || []).map(migrateBlock);
        const slots = [];
        for (let h = 0; h < 24; h++) {
            const hhmm = hourToTimeStr(h);
            const block = blocks.find(b => hhmm >= b.from && hhmm < b.to);
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

/**
 * Convert legacy hourly slots to new {from, to} block format.
 * Groups consecutive same-status slots.
 */
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
                current = { from: hourToTimeStr(slot.hour), to: hourToTimeStr(slot.hour + 1), status: slot.status, activity: slot.activity || '' };
            } else if (current.status === slot.status && current.activity === (slot.activity || '') && current.to === hourToTimeStr(slot.hour)) {
                current.to = hourToTimeStr(slot.hour + 1);
            } else {
                dayBlocks.push(current);
                current = { from: hourToTimeStr(slot.hour), to: hourToTimeStr(slot.hour + 1), status: slot.status, activity: slot.activity || '' };
            }
        }
        if (current) dayBlocks.push(current);
        blocks[day] = dayBlocks;
    }
    return blocks;
}

// ═══════════════════════════════════════════════════════
// Timeline bar helper
// ═══════════════════════════════════════════════════════

/**
 * Build a flex color bar representing a day's schedule.
 * Blocks are {from:"HH:MM", to:"HH:MM"}.
 */
function buildTimelineBar(blocks) {
    const TOTAL = 24 * 60; // 1440 minutes

    if (!blocks || blocks.length === 0) {
        return `<div style="flex:1;height:18px;border-radius:4px;background:${STATUS_COLORS.online};opacity:0.5;"></div>`;
    }

    const migrated = blocks.map(migrateBlock);
    const sorted   = [...migrated].sort((a, b) => timeStrToMinutes(a.from) - timeStrToMinutes(b.from));

    // Fill gaps with 'online'
    const filled = [];
    let cursor = 0;
    for (const b of sorted) {
        const bStart = timeStrToMinutes(b.from);
        const bEnd   = timeStrToMinutes(b.to);
        if (bStart > cursor) {
            filled.push({ from: minutesToTimeStr(cursor), to: minutesToTimeStr(bStart), status: 'online', activity: '' });
        }
        filled.push(b);
        cursor = bEnd;
    }
    if (cursor < TOTAL) {
        filled.push({ from: minutesToTimeStr(cursor), to: '24:00', status: 'online', activity: '' });
    }

    const segments = filled.map(b => {
        const fromMin = timeStrToMinutes(b.from);
        const toMin   = b.to === '24:00' ? TOTAL : timeStrToMinutes(b.to);
        const pct     = ((toMin - fromMin) / TOTAL * 100).toFixed(2);
        const color   = STATUS_COLORS[b.status] || STATUS_COLORS.online;
        const title   = `${b.from}–${b.to} ${STATUS_LABELS[b.status] || 'Online'}${b.activity ? ': ' + b.activity : ''}`;
        return `<div title="${title.replace(/"/g, '&quot;')}" style="flex:${pct};height:18px;background:${color};min-width:2px;"></div>`;
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

    // Migrate legacy integer format on open
    if (phoneData.scheduleBlocks) {
        phoneData.scheduleBlocks = migrateBlocksFormat(phoneData.scheduleBlocks);
    } else if (phoneData.schedule) {
        phoneData.scheduleBlocks = hourlyToBlocks(phoneData.schedule);
    }

    const html = buildMainModalHtml(phoneData.scheduleBlocks);

    const popup = new Popup(html, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        okButton: 'Close',
        cancelButton: null,
    });

    requestAnimationFrame(() => wireMainModal(phoneData, popup));

    await popup.show();
}

function buildMainModalHtml(scheduleBlocks) {
    const charName  = getCharName();
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
                ? `<span style="font-size:10px;background:var(--SmartThemeAccentColor,#7c3aed);color:#fff;padding:1px 6px;border-radius:8px;white-space:nowrap;">today</span>`
                : '';

            html += `
            <div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;background:rgba(128,128,128,0.08);">
                <div style="display:flex;align-items:center;gap:5px;min-width:90px;flex-shrink:0;">
                    <span style="font-weight:${isToday ? '700' : '600'};font-size:12px;white-space:nowrap;">${dayLabel}</span>
                    ${todayBadge}
                </div>
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

    if (!phoneData.scheduleBlocks) phoneData.scheduleBlocks = {};
    if (!phoneData.scheduleBlocks[day]) phoneData.scheduleBlocks[day] = [];

    // Ensure blocks are in new format
    phoneData.scheduleBlocks[day] = phoneData.scheduleBlocks[day].map(migrateBlock);

    const dayLabel = day.charAt(0).toUpperCase() + day.slice(1);
    const html     = buildDayEditorHtml(day, phoneData.scheduleBlocks[day]);

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
        <h3 style="margin:0 0 4px;">${dayLabel} Schedule</h3>
        <p style="color:var(--SmartThemeQuoteColor,#888);font-size:11px;margin:0 0 10px;">
            Times are in 24h format (HH:MM). Blocks must not overlap.
        </p>`;

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
    const b     = migrateBlock(block);
    const color = STATUS_COLORS[b.status] || STATUS_COLORS.online;

    return `
    <div class="textme-day-block-row" data-idx="${idx}"
         style="display:flex;align-items:center;gap:6px;padding:5px 0;
                border-bottom:1px solid rgba(128,128,128,0.12);">

        <!-- Start time (HH:MM) -->
        <input type="time" class="textme-day-from text_pole" data-idx="${idx}"
               value="${escapeAttr(b.from)}"
               style="font-size:12px;padding:2px 4px;height:26px;width:80px;" />
        <span style="color:var(--SmartThemeQuoteColor,#888);font-size:12px;">–</span>
        <!-- End time (HH:MM) -->
        <input type="time" class="textme-day-to text_pole" data-idx="${idx}"
               value="${escapeAttr(b.to === '24:00' ? '00:00' : b.to)}"
               title="${b.to === '24:00' ? '24:00 = midnight (end of day)' : ''}"
               style="font-size:12px;padding:2px 4px;height:26px;width:80px;" />

        <!-- Status badge (click to cycle) -->
        <span class="textme-day-status-badge"
              data-idx="${idx}" data-status="${b.status}"
              style="cursor:pointer;padding:3px 10px;border-radius:12px;
                     background:${color};color:#000;
                     font-size:11px;font-weight:700;white-space:nowrap;
                     user-select:none;min-width:52px;text-align:center;"
              title="Click to cycle status">
            ${STATUS_LABELS[b.status] || 'Online'}
        </span>

        <!-- Activity -->
        <input type="text"
               class="textme-day-activity text_pole"
               data-idx="${idx}"
               value="${escapeAttr(b.activity || '')}"
               placeholder="Activity..."
               style="flex:1;font-size:12px;padding:2px 6px;height:26px;" />

        <!-- Delete -->
        <button class="textme-day-del-row menu_button" data-idx="${idx}"
                style="padding:1px 7px;font-size:13px;min-width:0;border-radius:6px;
                       background:rgba(255,60,60,0.15);color:#ff3c3c;"
                title="Delete block">×</button>
    </div>`;
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

            const existing     = blocksDiv.querySelectorAll('.textme-day-block-row');
            const idx          = existing.length;
            let defaultFrom    = '12:00';
            let defaultTo      = '13:00';

            if (existing.length > 0) {
                const lastRow  = existing[existing.length - 1];
                const lastToEl = lastRow.querySelector('.textme-day-to');
                if (lastToEl?.value) {
                    defaultFrom = lastToEl.value;
                    // +1 hour, clamped to 23:59
                    const mins  = timeStrToMinutes(defaultFrom);
                    const end   = Math.min(mins + 60, 23 * 60 + 59);
                    defaultTo   = minutesToTimeStr(end);
                }
            }

            const newBlock = { from: defaultFrom, to: defaultTo, status: 'online', activity: '' };
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

    const rows      = editor.querySelectorAll('.textme-day-block-row');
    const dayBlocks = [];

    rows.forEach(row => {
        const fromEl     = row.querySelector('.textme-day-from');
        const toEl       = row.querySelector('.textme-day-to');
        const badge      = row.querySelector('.textme-day-status-badge');
        const activityEl = row.querySelector('.textme-day-activity');

        if (!fromEl || !toEl || !badge) return;

        const from     = fromEl.value.trim();   // "HH:MM" from <input type="time">
        const to       = toEl.value.trim();
        const status   = badge.dataset.status || 'online';
        const activity = activityEl ? activityEl.value.trim() : '';

        if (!from || !to) return;

        // Treat "00:00" in the To field as "24:00" (end-of-day) only when
        // it's the last block and the From is after midday — avoids wrong ordering.
        const toNormalized = (to === '00:00' && timeStrToMinutes(from) >= 12 * 60) ? '24:00' : to;

        // Only add if from < to (or to is 24:00 sentinel)
        if (from < toNormalized || toNormalized === '24:00') {
            dayBlocks.push({ from, to: toNormalized, status, activity });
        }
    });

    dayBlocks.sort((a, b) => timeStrToMinutes(a.from) - timeStrToMinutes(b.from));

    if (!phoneData.scheduleBlocks) phoneData.scheduleBlocks = {};
    phoneData.scheduleBlocks[day] = dayBlocks;
    phoneData.schedule = blocksToHourly(phoneData.scheduleBlocks);

    savePhoneData().catch(e => log.error('Failed to save day schedule:', e));
}

// ─────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────

function escapeAttr(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ─────────────────────────────────────────────────────
// Export / Import schedule JSON
// ─────────────────────────────────────────────────────

/**
 * Export current scheduleBlocks as formatted JSON.
 * Always exports the migrated {from, to} format.
 * @returns {string}
 */
export function exportScheduleJSON() {
    const phoneData = getPhoneData();
    let data = phoneData?.scheduleBlocks || phoneData?.schedule;
    if (!data) return '';
    // Migrate before export so exported file is always in new format
    if (phoneData?.scheduleBlocks) {
        data = migrateBlocksFormat(structuredClone(phoneData.scheduleBlocks));
    }
    return JSON.stringify(data, null, 2);
}

/**
 * Import schedule from JSON.
 * Accepts both {from/to string} and legacy {start/end integer} formats.
 * @param {string} jsonStr
 * @returns {boolean} success
 */
export async function importScheduleJSON(jsonStr) {
    let parsed;
    try {
        parsed = JSON.parse(jsonStr);
    } catch (e) {
        toastr.error('Import failed: invalid JSON.');
        return false;
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        toastr.error('Import failed: expected a JSON object.');
        return false;
    }

    const hasDay = DAYS.some(d => Array.isArray(parsed[d]));
    if (!hasDay) {
        toastr.error('Import failed: no valid day keys found.');
        return false;
    }

    const phoneData = getPhoneData();
    if (!phoneData) {
        toastr.error('No active chat to import into.');
        return false;
    }

    // Normalize to {from, to} string format regardless of input
    const scheduleBlocks = {};
    for (const day of DAYS) {
        scheduleBlocks[day] = (parsed[day] || []).map(migrateBlock);
    }

    phoneData.scheduleBlocks = scheduleBlocks;
    phoneData.schedule       = blocksToHourly(scheduleBlocks);

    await savePhoneData();
    log.info('Schedule imported successfully.');
    return true;
}

// ─────────────────────────────────────────────────────
// Inline settings panel render (read-only summary)
// ─────────────────────────────────────────────────────

export function renderScheduleEditor(container) {
    if (!container) return;

    const phoneData   = getPhoneData();
    const hasSchedule = phoneData?.scheduleBlocks || phoneData?.schedule;

    if (!hasSchedule) {
        container.innerHTML = '<p style="color:var(--SmartThemeQuoteColor,#888);font-style:italic;">No schedule generated yet. Click "Generate Schedule" above, then use the "Schedule &amp; Status" button to edit.</p>';
        return;
    }

    const { status, activity, isManual } = getCurrentStatus();
    const { label }  = getStatusInfo(status);
    const color      = STATUS_COLORS[status] || STATUS_COLORS.online;

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
