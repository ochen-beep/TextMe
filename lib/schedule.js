/**
 * TextMe — Schedule & Status system
 * License: AGPL-3.0
 *
 * v1.1.0 — Block format migrated to {from:"HH:MM", to:"HH:MM"} (minutes-precise).
 * Legacy {start:int, end:int} data is auto-migrated on read.
 * getCurrentStatus() uses getCurrentTime() to respect custom game time.
 *
 * Two-level Schedule Editor UI:
 *   Level 1 — openScheduleModal: all 7 days as compact rows with timeline bar.
 *   Level 2 — openDayEditor: per-day block list with time inputs (HH:MM).
 *
 * FIX: buildDayBlockRow() now applies escapeAttr() to b.from and b.to.
 *   These time strings come from saved JSON and are normally well-formed
 *   ("HH:MM"), but a manually imported schedule could contain quote
 *   characters that would break the value="..." HTML attribute.
 *   b.activity was already escaped; now all three dynamic fields are
 *   consistently escaped.
 */

import { getSettings, getPhoneData, savePhoneData, getCharName, getUserName } from './state.js';
import { runVectorWIPipeline } from './vector-wi.js';
import { applyRpOutputRegex } from './regex-util.js';
import { getCurrentTime } from './custom-time.js';
import { log } from './logger.js';

const DAYS     = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const STATUSES = ['online', 'idle', 'dnd', 'offline'];
const STATUS_COLORS = { online: '#34C759', idle: '#FFCC00', dnd: '#FF3B30', offline: '#8E8E93' };
const STATUS_LABELS = { online: 'Online', idle: 'Idle', dnd: 'DND', offline: 'Offline' };

// ═══════════════════════════════════════════════════════════════
// Time string helpers
// ═══════════════════════════════════════════════════════════════

function hourToTimeStr(h) { return `${String(h).padStart(2, '0')}:00`; }

function timeStrToMinutes(t) {
    if (!t || typeof t !== 'string') return 0;
    const [hh, mm] = t.split(':').map(Number);
    return (hh || 0) * 60 + (mm || 0);
}

function minutesToTimeStr(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function migrateBlock(b) {
    if (b.from !== undefined && b.to !== undefined) return b;
    return { from: hourToTimeStr(b.start ?? 0), to: hourToTimeStr(b.end ?? 1), status: b.status || 'online', activity: b.activity || '' };
}

function migrateBlocksFormat(blocks) {
    if (!blocks) return blocks;
    for (const day of DAYS) {
        if (Array.isArray(blocks[day])) blocks[day] = blocks[day].map(migrateBlock);
    }
    return blocks;
}

function dateToHHMM(d) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ═══════════════════════════════════════════════
// Manual status override (avatar click)
// ═══════════════════════════════════════════════

export async function setManualStatus(status) {
    const phoneData = getPhoneData();
    if (!phoneData) return;
    const prevStatus = phoneData.manualStatus || null;
    phoneData.manualStatus = status || null;
    await savePhoneData();
    log.info('Manual status set to:', status);

    // Emit event so autonomous system can react to offline→online transitions
    try {
        const context = SillyTavern.getContext();
        if (context?.eventSource?.emit) {
            context.eventSource.emit('textme:statusChanged', { prev: prevStatus, next: phoneData.manualStatus });
        }
    } catch (e) { /* ignore */ }
}

export async function clearManualStatus() { await setManualStatus(null); }

export async function cycleManualStatus() {
    const phoneData = getPhoneData();
    if (!phoneData) return 'online';
    const current = phoneData.manualStatus;
    let next;
    if (!current) { next = 'online'; }
    else {
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
    if (phoneData?.manualStatus) return { status: phoneData.manualStatus, activity: '', isManual: true };
    const settings = getSettings();
    if (!settings.scheduleEnabled) return { status: 'online', activity: '', isManual: false };
    if (!phoneData) return { status: 'online', activity: '', isManual: false };

    const now         = getCurrentTime();
    const dayIndex    = (now.getDay() + 6) % 7;
    const dayName     = DAYS[dayIndex];
    const currentHHMM = dateToHHMM(now);

    if (phoneData.scheduleBlocks?.[dayName]) {
        phoneData.scheduleBlocks[dayName] = phoneData.scheduleBlocks[dayName].map(migrateBlock);
        const block = phoneData.scheduleBlocks[dayName].find(b => currentHHMM >= b.from && currentHHMM < b.to);
        if (block) return { status: block.status || 'online', activity: block.activity || '', isManual: false };
    }
    if (phoneData.schedule?.[dayName] && Array.isArray(phoneData.schedule[dayName])) {
        const hour = now.getHours();
        const slot = phoneData.schedule[dayName].find(s => s.hour === hour);
        if (slot) return { status: slot.status || 'online', activity: slot.activity || '', isManual: false };
    }
    return { status: 'online', activity: '', isManual: false };
}

export function getStatusInfo(status) {
    switch (status) {
        case 'online':  return { label: 'Online',          cssClass: 'textme-status-online',  emoji: '🟢' };
        case 'idle':    return { label: 'Idle',            cssClass: 'textme-status-idle',    emoji: '🟡' };
        case 'dnd':     return { label: 'Do Not Disturb', cssClass: 'textme-status-dnd',     emoji: '🔴' };
        case 'offline': return { label: 'Offline',        cssClass: 'textme-status-offline', emoji: '⚫' };
        default:        return { label: 'Online',          cssClass: 'textme-status-online',  emoji: '🟢' };
    }
}

export function getScheduleContext() {
    const settings = getSettings();
    const { status, activity, isManual } = getCurrentStatus();
    if (!settings.scheduleEnabled && !isManual) return '';
    const { label } = getStatusInfo(status);
    let context = `\n[Current Status: ${label}`;
    if (isManual)  context += ' (manual override)';
    if (activity)  context += ` — ${activity}`;
    context += ']';
    if (status === 'dnd')     context += '\n[Status modifier: Respond very briefly, you are busy. One-liners only.]';
    else if (status === 'idle')    context += '\n[Status modifier: You are not actively on your phone. Responses may be slightly delayed and casual.]';
    else if (status === 'offline') context += '\n[Status modifier: You are offline and should NOT respond.]';
    return context;
}

function getCurrentDayName() {
    const now = getCurrentTime();
    return DAYS[(now.getDay() + 6) % 7];
}

// ═══════════════════════════════════════════════
// Schedule generation (AI) — with RP context + WI
// ═══════════════════════════════════════════════

export async function generateSchedule() {
    const context  = SillyTavern.getContext();
    const settings = getSettings();
    const sub      = context.substituteParams || ((s) => s);
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

    // ── Optional: recent RP context ─────────────────────────────────────
    let rpContextBlock = '';
    if (settings.scheduleIncludeContext) {
        try {
            const rpChat  = context.chat ?? [];
            const limit   = settings.contextMessages || 10;
            const sliced  = limit > 0 ? rpChat.slice(-limit) : rpChat;
            const total   = sliced.length;
            const lines   = [];
            for (let i = 0; i < total; i++) {
                const m    = sliced[i];
                if (m.is_system || !m.mes) continue;
                const depth = total - 1 - i;
                const text  = await applyRpOutputRegex(m.mes, depth);
                lines.push(`${m.name}: ${text}`);
            }
            if (lines.length > 0) {
                rpContextBlock = `[Recent RP events — use as context for the character's current mood and activities]\n${lines.join('\n')}`;
                log.debug('Schedule gen: injecting', lines.length, 'RP context messages.');
            }
        } catch (e) { log.warn('Schedule gen: failed to collect RP context:', e); }
    }

    // ── Optional: active World Info / lorebook entries ────────────────
    let wiBlock = '';
    if (settings.scheduleIncludeWI) {
        try {
            if (typeof context.getWorldInfoPrompt === 'function') {
                const phoneData  = getPhoneData();
                const wiSource   = settings.wiScanSource || 'sms';
                const wiDepth    = settings.wiScanDepth ?? 50;
                const userName   = getUserName();

                const smsScanEntries = [];
                if (wiSource === 'sms' || wiSource === 'both') {
                    const smsMessages = phoneData?.messages ?? [];
                    const sliced      = wiDepth > 0 ? smsMessages.slice(-wiDepth) : smsMessages;
                    for (const m of sliced) {
                        if (m.type === 'image' || !m.text) continue;
                        smsScanEntries.push({ ts: m.time ?? 0, line: `${m.isUser ? userName : charName}: ${m.text}` });
                    }
                }
                const rpScanEntries = [];
                if (wiSource === 'rp' || wiSource === 'both') {
                    const rpChat  = context.chat ?? [];
                    const sliced  = wiDepth > 0 ? rpChat.slice(-wiDepth) : rpChat;
                    const total   = sliced.length;
                    for (let i = 0; i < total; i++) {
                        const m    = sliced[i];
                        if (m.is_system || !m.mes) continue;
                        const depth = total - 1 - i;
                        const text  = await applyRpOutputRegex(m.mes, depth);
                        const ts    = m.send_date
                            ? (typeof m.send_date === 'number' ? m.send_date * 1000 : new Date(m.send_date).getTime())
                            : 0;
                        rpScanEntries.push({ ts, line: `${m.name}: ${text}` });
                    }
                }

                const merged    = [...smsScanEntries, ...rpScanEntries].sort((a, b) => a.ts - b.ts);
                const scanLines = merged.map(e => e.line);

                const modelCtx  = context.max_context ?? 4096;
                const maxContext = Math.max(modelCtx - (settings.maxTokens || 300), Math.floor(modelCtx * 0.75));

                await runVectorWIPipeline(context.chat);
                const result = await context.getWorldInfoPrompt([...scanLines].reverse(), maxContext, true);
                let wiText = result?.worldInfoString || (typeof result === 'string' ? result : '');
                if (wiText?.trim()) {
                    wiBlock = `[World Info / Lorebook — use as additional character context]\n${wiText.trim()}`;
                    log.debug('Schedule gen: injecting WI block, length:', wiText.length);
                } else {
                    log.debug('Schedule gen: no WI entries activated.');
                }
            }
        } catch (e) { log.warn('Schedule gen: failed to collect World Info:', e); }
    }

    const systemPrompt = [
        scheduleInstruction,
        charInfo ? `[Character info for schedule generation]\n${charInfo.trim()}` : '',
        wiBlock,
        rpContextBlock,
        (() => {
            const now     = getCurrentTime();
            const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const dateStr = now.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
            const dayStr  = now.toLocaleDateString([], { weekday: 'long' });
            return `[Current time: ${timeStr}, ${dayStr}, ${dateStr} — use for day-of-week accuracy if relevant]`;
        })(),
        'IMPORTANT: Output ONLY the raw JSON object. No markdown, no code blocks, no explanation.',
    ].filter(Boolean).join('\n\n');

    const prompt = `Now generate the full weekly schedule for ${charName}. Output only the JSON.`;
    const result = await generateRaw({ prompt, systemPrompt, max_new_tokens: 2000 });
    const raw    = (typeof result === 'string' ? result : '').trim();
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

    const firstEntry    = (parsed[DAYS[0]] || [])[0] || {};
    const isOldIntFormat = Object.hasOwn(firstEntry, 'start') && Object.hasOwn(firstEntry, 'end') && !firstEntry.from;
    const scheduleBlocks = {};
    for (const day of DAYS) {
        scheduleBlocks[day] = (parsed[day] || []).map(migrateBlock);
    }
    log.info(`Schedule generated in ${isOldIntFormat ? 'old integer' : 'HH:MM string'} format — migrated.`);

    const phoneData = getPhoneData();
    if (phoneData) {
        phoneData.scheduleBlocks = scheduleBlocks;
        phoneData.schedule = blocksToHourly(scheduleBlocks);
        await savePhoneData();
    }
    log.info('Schedule saved. Days:', DAYS.map(d => `${d}:${(scheduleBlocks[d] || []).length}blk`).join(', '));
    return scheduleBlocks;
}

// ═══════════════════════════════════════════════
// Conversion helpers (legacy compatibility)
// ═══════════════════════════════════════════════

export function blocksToHourly(blocksSchedule) {
    if (!blocksSchedule) return null;
    const hourly = {};
    for (const day of DAYS) {
        const blocks = (blocksSchedule[day] || []).map(migrateBlock);
        const slots  = [];
        for (let h = 0; h < 24; h++) {
            const hhmm  = hourToTimeStr(h);
            const block = blocks.find(b => hhmm >= b.from && hhmm < b.to);
            slots.push({ hour: h, status: block ? block.status : 'online', activity: block ? block.activity : '' });
        }
        hourly[day] = slots;
    }
    return hourly;
}

export function hourlyToBlocks(hourlySchedule) {
    if (!hourlySchedule) return null;
    const blocks = {};
    for (const day of DAYS) {
        const slots  = hourlySchedule[day];
        if (!slots || !Array.isArray(slots)) { blocks[day] = []; continue; }
        const sorted    = [...slots].sort((a, b) => a.hour - b.hour);
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

function buildTimelineBar(blocks) {
    const TOTAL = 24 * 60;
    if (!blocks || blocks.length === 0) {
        return `<div class="textme-timeline-bar"><div class="textme-timeline-seg" style="flex:1;background:${STATUS_COLORS.online};"></div></div>`;
    }
    const migrated = blocks.map(migrateBlock);
    const sorted   = [...migrated].sort((a, b) => timeStrToMinutes(a.from) - timeStrToMinutes(b.from));
    const filled   = [];
    let cursor = 0;
    for (const b of sorted) {
        const bStart = timeStrToMinutes(b.from);
        const bEnd   = timeStrToMinutes(b.to);
        if (bStart > cursor) filled.push({ from: minutesToTimeStr(cursor), to: minutesToTimeStr(bStart), status: 'online', activity: '' });
        filled.push(b);
        cursor = bEnd;
    }
    if (cursor < TOTAL) filled.push({ from: minutesToTimeStr(cursor), to: '24:00', status: 'online', activity: '' });
    const segments = filled.map(b => {
        const fromMin = timeStrToMinutes(b.from);
        const toMin   = b.to === '24:00' ? TOTAL : timeStrToMinutes(b.to);
        const pct     = ((toMin - fromMin) / TOTAL * 100).toFixed(2);
        const color   = STATUS_COLORS[b.status] || STATUS_COLORS.online;
        const title   = `${b.from}–${b.to} ${STATUS_LABELS[b.status] || 'Online'}${b.activity ? ': ' + b.activity : ''}`;
        return `<div class="textme-timeline-seg" style="flex:${pct};background:${color};" title="${escapeAttr(title)}"></div>`;
    }).join('');
    return `<div class="textme-timeline-bar">${segments}</div>`;
}

// ═══════════════════════════════════════════════════════
// Level 1 — Main Schedule Modal
// ═══════════════════════════════════════════════════════

export async function openScheduleModal() {
    const context = SillyTavern.getContext();
    const { Popup, POPUP_TYPE } = context;
    if (!Popup) { toastr.error('SillyTavern Popup API not available. Update ST.'); return; }

    const phoneData = getPhoneData();
    if (phoneData.scheduleBlocks)  { phoneData.scheduleBlocks = migrateBlocksFormat(phoneData.scheduleBlocks); }
    else if (phoneData.schedule)   { phoneData.scheduleBlocks = hourlyToBlocks(phoneData.schedule); }

    const html  = buildMainModalHtml(phoneData.scheduleBlocks);
    const popup = new Popup(html, POPUP_TYPE.TEXT, '', { wide: true, large: true, okButton: 'Close', cancelButton: null });
    requestAnimationFrame(() => wireMainModal(phoneData, popup));
    await popup.show();
}

function buildMainModalHtml(scheduleBlocks) {
    const charName  = getCharName();
    const todayName = getCurrentDayName();
    const legendItems = Object.entries(STATUS_COLORS).map(([s, c]) =>
        `<span><span class="textme-sched-legend-dot" style="background:${c};"></span>${STATUS_LABELS[s]}</span>`
    ).join('');
    let html = `<div id="textme-sched-main" class="textme-popup">
        <h3>📅 Schedule &amp; Status Editor</h3>
        <p class="textme-popup-hint">Time blocks define when ${escapeAttr(charName)} is online/offline. Click Edit on any day to modify.</p>
        <div class="textme-sched-legend">${legendItems}</div>`;
    if (!scheduleBlocks) {
        html += `<p class="textme-popup-hint">No schedule generated yet.<br>Close this and click "Generate Schedule" first.</p>`;
    } else {
        html += `<div class="textme-sched-days">`;
        for (const day of DAYS) {
            const dayLabel  = day.charAt(0).toUpperCase() + day.slice(1);
            const dayBlocks = scheduleBlocks[day] || [];
            const isToday   = day === todayName;
            const badge     = isToday ? `<span class="textme-sched-today-badge">today</span>` : '';
            html += `<div class="textme-sched-day-row">
                <span class="textme-sched-day-label">${dayLabel}${badge}</span>
                <div class="textme-sched-timeline">${buildTimelineBar(dayBlocks)}</div>
                <button class="menu_button textme-sched-edit-day textme-sched-edit-btn" data-day="${day}">Edit</button>
            </div>`;
        }
        html += `</div>`;
    }
    html += `</div>`;
    return html;
}

function wireMainModal(phoneData, parentPopup) {
    const modal = document.getElementById('textme-sched-main');
    if (!modal) { requestAnimationFrame(() => wireMainModal(phoneData, parentPopup)); return; }
    modal.addEventListener('click', async (e) => {
        const btn = e.target.closest('.textme-sched-edit-day');
        if (!btn) return;
        await openDayEditor(btn.dataset.day, phoneData);
        refreshMainModal(phoneData);
    });
}

function refreshMainModal(phoneData) {
    const modal = document.getElementById('textme-sched-main');
    if (!modal) return;
    for (const day of DAYS) {
        const btn = modal.querySelector(`.textme-sched-edit-day[data-day="${day}"]`);
        if (!btn) continue;
        const row = btn.closest('.textme-sched-day-row');
        if (!row) continue;
        const barContainer = row.querySelector('.textme-sched-timeline');
        if (barContainer) barContainer.innerHTML = buildTimelineBar(phoneData.scheduleBlocks?.[day] || []);
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
    phoneData.scheduleBlocks[day] = phoneData.scheduleBlocks[day].map(migrateBlock);
    const dayLabel = day.charAt(0).toUpperCase() + day.slice(1);
    const html     = buildDayEditorHtml(day, phoneData.scheduleBlocks[day]);
    let saved = false;
    const popup = new Popup(html, POPUP_TYPE.TEXT, '', {
        wide: true, large: false,
        okButton: 'Save Day', cancelButton: 'Cancel',
        onClosing: (p) => { if (p.result === 1) { saved = true; saveDay(day, phoneData); } return true; },
    });
    requestAnimationFrame(() => wireDayEditor(day));
    await popup.show();
    if (saved) toastr.success(`${dayLabel} schedule saved.`);
    return saved;
}

function buildDayEditorHtml(day, blocks) {
    const dayLabel = day.charAt(0).toUpperCase() + day.slice(1);
    let html = `<div id="textme-day-editor" class="textme-popup">
        <h3>${dayLabel} Schedule</h3>
        <p class="textme-popup-hint">Times in 24h format (HH:MM). Blocks must not overlap.</p>
        <div class="textme-day-blocks">`;
    if (!blocks || blocks.length === 0) {
        html += `<span class="textme-day-empty">No blocks — character is always Online.</span>`;
    } else {
        blocks.forEach((block, idx) => { html += buildDayBlockRow(day, block, idx); });
    }
    html += `</div>
        <button class="menu_button textme-day-add-block textme-day-add-btn">+ Add Block</button>
    </div>`;
    return html;
}

function buildDayBlockRow(day, block, idx) {
    const b     = migrateBlock(block);
    const color = STATUS_COLORS[b.status] || STATUS_COLORS.online;
    const safeFrom = escapeAttr(b.from);
    const safeTo   = escapeAttr(b.to === '24:00' ? '00:00' : b.to);
    return `<div class="textme-day-block-row" data-idx="${idx}">
        <input class="textme-day-from textme-popup-time" type="time" value="${safeFrom}" data-idx="${idx}">
        <span class="textme-day-sep">–</span>
        <input class="textme-day-to textme-popup-time" type="time" value="${safeTo}" data-idx="${idx}">
        <button class="textme-day-status-badge" data-idx="${idx}" data-status="${b.status}"
            style="background:${color};">
            ${STATUS_LABELS[b.status] || 'Online'}
        </button>
        <input class="textme-day-activity-input" type="text" value="${escapeAttr(b.activity || '')}" placeholder="activity" data-idx="${idx}">
        <button class="textme-day-del-btn" data-idx="${idx}" title="Remove block">×</button>
    </div>`;
}

function wireDayEditor(day) {
    const editor = document.getElementById('textme-day-editor');
    if (!editor) { requestAnimationFrame(() => wireDayEditor(day)); return; }
    editor.addEventListener('click', (e) => {
        const badge = e.target.closest('.textme-day-status-badge');
        if (badge) {
            const next = STATUSES[(STATUSES.indexOf(badge.dataset.status) + 1) % STATUSES.length];
            badge.dataset.status    = next;
            badge.textContent       = STATUS_LABELS[next];
            badge.style.background  = STATUS_COLORS[next];
            return;
        }
        const del = e.target.closest('.textme-day-del-btn');
        if (del) {
            const row = del.closest('.textme-day-block-row');
            if (row) row.remove();
            reindexDayEditor(editor);
            const blocksDiv = editor.querySelector('.textme-day-blocks');
            if (blocksDiv && blocksDiv.querySelectorAll('.textme-day-block-row').length === 0) {
                if (!blocksDiv.querySelector('.textme-day-empty')) {
                    blocksDiv.insertAdjacentHTML('beforeend', `<span class="textme-day-empty">No blocks — character is always Online.</span>`);
                }
            }
            return;
        }
        const addBtn = e.target.closest('.textme-day-add-block');
        if (addBtn) {
            const blocksDiv = editor.querySelector('.textme-day-blocks');
            if (!blocksDiv) return;
            const placeholder = blocksDiv.querySelector('.textme-day-empty');
            if (placeholder) placeholder.remove();
            const existing    = blocksDiv.querySelectorAll('.textme-day-block-row');
            const idx         = existing.length;
            let defaultFrom = '12:00', defaultTo = '13:00';
            if (existing.length > 0) {
                const lastToEl = existing[existing.length - 1].querySelector('.textme-day-to');
                if (lastToEl?.value) {
                    defaultFrom = lastToEl.value;
                    const end   = Math.min(timeStrToMinutes(defaultFrom) + 60, 23 * 60 + 59);
                    defaultTo   = minutesToTimeStr(end);
                }
            }
            blocksDiv.insertAdjacentHTML('beforeend', buildDayBlockRow(day, { from: defaultFrom, to: defaultTo, status: 'online', activity: '' }, idx));
        }
    });
}

function reindexDayEditor(editor) {
    editor.querySelectorAll('.textme-day-block-row').forEach((row, i) => {
        row.dataset.idx = i;
        row.querySelectorAll('[data-idx]').forEach(el => { el.dataset.idx = i; });
    });
}

function saveDay(day, phoneData) {
    const editor = document.getElementById('textme-day-editor');
    if (!editor) return;
    const dayBlocks = [];
    editor.querySelectorAll('.textme-day-block-row').forEach(row => {
        const from     = row.querySelector('.textme-day-from')?.value.trim();
        const to       = row.querySelector('.textme-day-to')?.value.trim();
        const badge    = row.querySelector('.textme-day-status-badge');
        const activity = row.querySelector('.textme-day-activity-input')?.value.trim() || '';
        if (!from || !to || !badge) return;
        const toNorm = (to === '00:00' && timeStrToMinutes(from) >= 12 * 60) ? '24:00' : to;
        if (from < toNorm || toNorm === '24:00') dayBlocks.push({ from, to: toNorm, status: badge.dataset.status || 'online', activity });
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
    return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─────────────────────────────────────────────────────
// Export / Import schedule JSON
// ─────────────────────────────────────────────────────

export function exportScheduleJSON() {
    const phoneData = getPhoneData();
    let data = phoneData?.scheduleBlocks || phoneData?.schedule;
    if (!data) return '';
    if (phoneData?.scheduleBlocks) data = migrateBlocksFormat(structuredClone(phoneData.scheduleBlocks));
    return JSON.stringify(data, null, 2);
}

export async function importScheduleJSON(jsonStr) {
    let parsed;
    try { parsed = JSON.parse(jsonStr); } catch (e) { toastr.error('Import failed: invalid JSON.'); return false; }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) { toastr.error('Import failed: expected a JSON object.'); return false; }
    if (!DAYS.some(d => Array.isArray(parsed[d]))) { toastr.error('Import failed: no valid day keys found.'); return false; }
    const phoneData = getPhoneData();
    if (!phoneData) { toastr.error('No active chat to import into.'); return false; }
    const scheduleBlocks = {};
    for (const day of DAYS) scheduleBlocks[day] = (parsed[day] || []).map(migrateBlock);
    phoneData.scheduleBlocks = scheduleBlocks;
    phoneData.schedule = blocksToHourly(scheduleBlocks);
    await savePhoneData();
    log.info('Schedule imported successfully.');
    return true;
}

// ─────────────────────────────────────────────────────
// Inline settings panel render (read-only summary)
// ─────────────────────────────────────────────────────

export function renderScheduleEditor(container) {
    if (!container) return;
    const phoneData    = getPhoneData();
    const hasSchedule  = phoneData?.scheduleBlocks || phoneData?.schedule;
    if (!hasSchedule) {
        container.innerHTML = 'No schedule generated yet. Click "Generate Schedule" above, then use the "Schedule & Status" button to edit.';
        return;
    }
    const { status, activity, isManual } = getCurrentStatus();
    const { label } = getStatusInfo(status);
    const color = STATUS_COLORS[status] || STATUS_COLORS.online;
    let blockSummary = '';
    if (phoneData.scheduleBlocks) {
        const counts = DAYS.map(d => (phoneData.scheduleBlocks[d] || []).length);
        blockSummary = `Blocks per day: ${counts.join(' / ')}`;
    }
    container.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
            <span style="width:10px;height:10px;border-radius:50%;background:${color};display:inline-block;flex-shrink:0;"></span>
            <span>Current status: <strong>${label}</strong>${isManual ? ' (manual override)' : ''}${activity ? ` — ${escapeAttr(activity)}` : ''}</span>
        </div>
        <div class="textme-hint">${blockSummary}</div>
        <div style="font-size:12px;margin-top:4px;">Schedule loaded ✓ Use the "Schedule &amp; Status" button above to edit.</div>`;
}
