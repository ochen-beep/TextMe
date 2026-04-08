/**
 * TextMe — Schedule & Status system
 * License: AGPL-3.0
 *
 * Generates character schedules via generateRaw(),
 * provides current status based on day/hour,
 * and status influence on prompt generation.
 *
 * FIX (critical): generateRaw uses camelCase `systemPrompt` per ST docs.
 * FIX: renderScheduleEditor replaced with openScheduleModal() —
 *      a full-featured popup editor using ST's Popup API,
 *      showing all 24 slots per day with editable activity text.
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

/**
 * Get the current status of the character based on schedule.
 * @returns {{ status: string, activity: string }}
 */
export function getCurrentStatus() {
    const settings = getSettings();
    if (!settings.scheduleEnabled) return { status: 'online', activity: '' };

    const phoneData = getPhoneData();
    if (!phoneData?.schedule) return { status: 'online', activity: '' };

    const now = new Date();
    const dayIndex = (now.getDay() + 6) % 7; // Monday = 0
    const dayName = DAYS[dayIndex];
    const hour = now.getHours();

    const daySchedule = phoneData.schedule[dayName];
    if (!daySchedule || !Array.isArray(daySchedule)) return { status: 'online', activity: '' };

    const slot = daySchedule.find(s => s.hour === hour);
    if (!slot) return { status: 'online', activity: '' };

    return {
        status: slot.status || 'online',
        activity: slot.activity || '',
    };
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
    if (!settings.scheduleEnabled) return '';

    const { status, activity } = getCurrentStatus();
    const { label } = getStatusInfo(status);

    let context = `\n[Current Status: ${label}`;
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

/**
 * Generate a schedule for the character using AI.
 *
 * FIX (critical): uses `systemPrompt` (camelCase) per official ST docs.
 * Reference: https://docs.sillytavern.app/for-contributors/writing-extensions/
 *
 * @returns {Promise<object>} The schedule object
 */
export async function generateSchedule() {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    const sub = context.substituteParams || ((s) => s);

    const { generateRaw } = context;
    if (!generateRaw) throw new Error('generateRaw not available');

    const charName = getCharName();
    log.info('Generating schedule for', charName);

    // Build system instruction
    const scheduleInstruction = sub(settings.schedulePrompt);

    // Get character info for context
    let charInfo = '';
    try {
        if (typeof context.getCharacterCardFields === 'function') {
            const fields = context.getCharacterCardFields();
            if (fields.description) charInfo += fields.description + '\n';
            if (fields.personality) charInfo += fields.personality + '\n';
        }
    } catch (e) { /* ignore */ }

    // CRITICAL FIX: `systemPrompt` camelCase
    const systemPrompt = `${scheduleInstruction}\n\n${charInfo}\nRespond ONLY with valid JSON. No markdown, no code blocks, no extra text — just the raw JSON object.`;
    const prompt = `Generate the weekly schedule for ${charName} now. Output only the JSON object with days monday through sunday, each containing 24 hourly slots with hour (0-23), status (online/idle/dnd/offline), and activity fields.`;

    const result = await generateRaw({
        prompt,
        systemPrompt,   // <-- camelCase
        max_new_tokens: 4000,
    });

    const raw = (typeof result === 'string' ? result : '').trim();

    if (!raw) {
        throw new Error('Empty response from AI. Check your API connection.');
    }

    log.debug('Schedule raw response length:', raw.length);

    // Parse JSON — strip markdown fences and any trailing tags
    let schedule;
    try {
        let cleaned = raw
            .replace(/^```(?:json)?\n?/i, '')
            .replace(/\n?```$/i, '')
            .replace(/<\/?[A-Za-z][^>]*>/g, '')
            .trim();

        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (jsonMatch) cleaned = jsonMatch[0];

        schedule = JSON.parse(cleaned);
    } catch (e) {
        log.error('Failed to parse schedule JSON:', raw.substring(0, 500));
        throw new Error('Failed to parse schedule. The AI returned invalid JSON.');
    }

    // Validate structure
    for (const day of DAYS) {
        if (!schedule[day] || !Array.isArray(schedule[day])) {
            throw new Error(`Missing or invalid day in schedule: ${day}`);
        }
    }

    // Save to phone data
    const phoneData = getPhoneData();
    if (phoneData) {
        phoneData.schedule = schedule;
        await savePhoneData();
    }

    log.info('Schedule generated and saved.');
    return schedule;
}

// ═══════════════════════════════════════════════════════
// Schedule Modal Editor
// Uses ST's Popup API — opens a full-featured day×hour editor
// Inspired by STC's schedule-editor.js approach
// ═══════════════════════════════════════════════════════

/**
 * Open the Schedule & Status modal editor.
 * Shows 7 days × 24 slots, each with status (click to cycle) + activity text.
 */
export async function openScheduleModal() {
    const context = SillyTavern.getContext();
    const { Popup, POPUP_TYPE } = context;

    if (!Popup) {
        toastr.error('SillyTavern Popup API not available. Update ST.');
        return;
    }

    const phoneData = getPhoneData();
    const schedule  = phoneData?.schedule;

    const html = buildModalHtml(schedule);

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

    await popup.show();

    if (savedOk) {
        toastr.success('Schedule saved.');
    }
}

/** Build HTML for the schedule modal */
function buildModalHtml(schedule) {
    let html = `
    <div id="textme-sched-modal" style="font-size:13px;">
        <h3 style="margin:0 0 8px">📅 Schedule & Status Editor</h3>
        <p style="color:var(--SmartThemeQuoteColor,#888);margin:0 0 12px;font-size:12px">
            Click a status badge to cycle: Online → Idle → DND → Offline.<br>
            Edit the activity text in the input field next to it.
        </p>`;

    if (!schedule) {
        html += `<p style="color:var(--SmartThemeQuoteColor,#888);font-style:italic">
            No schedule generated yet. Close this and click "Generate Schedule" first.
        </p>`;
    } else {
        for (const day of DAYS) {
            const dayLabel = day.charAt(0).toUpperCase() + day.slice(1);
            const dayData  = schedule[day] || [];

            html += `<details style="margin-bottom:6px;" ${day === getCurrentDayName() ? 'open' : ''}>
                <summary style="cursor:pointer;font-weight:600;padding:4px 0">
                    ${dayLabel}
                    <span style="font-size:11px;color:var(--SmartThemeQuoteColor,#888);margin-left:6px;font-weight:400">
                        ${buildDaySummary(dayData)}
                    </span>
                </summary>
                <div style="display:grid;grid-template-columns:auto auto 1fr;gap:4px 8px;align-items:center;padding:6px 0 6px 12px">`;

            for (let h = 0; h < 24; h++) {
                const slot   = dayData.find(s => s.hour === h) || { status: 'online', activity: '' };
                const color  = STATUS_COLORS[slot.status] || STATUS_COLORS.online;
                const label  = STATUS_LABELS[slot.status] || 'Online';
                const hourFmt = String(h).padStart(2, '0') + ':00';

                html += `
                    <span style="color:var(--SmartThemeQuoteColor,#888);font-size:11px;min-width:36px">${hourFmt}</span>
                    <span class="textme-sched-status-badge"
                        data-day="${day}" data-hour="${h}" data-status="${slot.status}"
                        style="cursor:pointer;padding:2px 8px;border-radius:10px;background:${color};color:#000;
                               font-size:11px;font-weight:600;white-space:nowrap;user-select:none;"
                        title="Click to cycle status">${label}</span>
                    <input type="text"
                        class="textme-sched-activity text_pole"
                        data-day="${day}" data-hour="${h}"
                        value="${escapeAttr(slot.activity || '')}"
                        placeholder="Activity description..."
                        style="font-size:12px;padding:2px 6px;height:24px;" />`;
            }

            html += `</div></details>`;
        }
    }

    html += `</div>`;
    return html;
}

/** Get the current day name (monday…sunday) */
function getCurrentDayName() {
    const dayIndex = (new Date().getDay() + 6) % 7;
    return DAYS[dayIndex];
}

/** Build a short summary of a day's schedule for the <details> label */
function buildDaySummary(dayData) {
    if (!dayData || dayData.length === 0) return 'no data';
    const counts = { online: 0, idle: 0, dnd: 0, offline: 0 };
    dayData.forEach(s => { if (counts[s.status] !== undefined) counts[s.status]++; });
    return Object.entries(counts)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `<span style="color:${STATUS_COLORS[k]}">${STATUS_LABELS[k]}: ${v}h</span>`)
        .join(' · ');
}

/** Escape value for use in HTML attribute */
function escapeAttr(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Wire status badge click-to-cycle after popup renders.
 * Called via requestAnimationFrame from openScheduleModal.
 *
 * Note: ST's Popup renders our HTML into a live DOM container.
 * We use event delegation on the modal root to catch clicks.
 */
function wireModalEvents() {
    const modal = document.getElementById('textme-sched-modal');
    if (!modal) return;

    modal.addEventListener('click', (e) => {
        const badge = e.target.closest('.textme-sched-status-badge');
        if (!badge) return;

        const currentStatus = badge.dataset.status;
        const currentIdx    = STATUSES.indexOf(currentStatus);
        const nextStatus    = STATUSES[(currentIdx + 1) % STATUSES.length];

        badge.dataset.status   = nextStatus;
        badge.textContent      = STATUS_LABELS[nextStatus];
        badge.style.background = STATUS_COLORS[nextStatus];
    });
}

/**
 * Read current modal state and save to phoneData.
 * Called in onClosing when user clicks Save.
 */
function saveFromModal(phoneData) {
    const modal = document.getElementById('textme-sched-modal');
    if (!modal || !phoneData?.schedule) return;

    // Read all activity inputs
    modal.querySelectorAll('.textme-sched-activity').forEach(input => {
        const day  = input.dataset.day;
        const hour = parseInt(input.dataset.hour, 10);
        const slot = phoneData.schedule[day]?.find(s => s.hour === hour);
        if (slot) slot.activity = input.value.trim();
    });

    // Read all status badges
    modal.querySelectorAll('.textme-sched-status-badge').forEach(badge => {
        const day  = badge.dataset.day;
        const hour = parseInt(badge.dataset.hour, 10);
        const slot = phoneData.schedule[day]?.find(s => s.hour === hour);
        if (slot) slot.status = badge.dataset.status;
    });

    // Async save (fire and forget — onClosing can't be async)
    savePhoneData().catch(e => log.error('Failed to save schedule from modal:', e));
}

/**
 * Legacy render function — still used in settings.html for the
 * inline "no schedule" placeholder. The actual editing is now in
 * the modal (openScheduleModal).
 */
export function renderScheduleEditor(container) {
    if (!container) return;

    const phoneData = getPhoneData();
    const schedule  = phoneData?.schedule;

    if (!schedule) {
        container.innerHTML = '<p style="color:var(--SmartThemeQuoteColor,#888);font-style:italic;">No schedule generated yet. Click "Generate Schedule" above, then use the "Schedule &amp; Status" button to edit.</p>';
        return;
    }

    // Show a compact read-only summary + prompt to use the edit button
    const { status, activity } = getCurrentStatus();
    const { label } = getStatusInfo(status);
    container.innerHTML = `
        <div style="padding:8px;border-radius:6px;background:rgba(128,128,128,0.1);font-size:12px;">
            <b>Current status:</b>
            <span style="color:${STATUS_COLORS[status]};font-weight:600">${label}</span>
            ${activity ? `<span style="color:var(--SmartThemeQuoteColor,#888)"> — ${escapeAttr(activity)}</span>` : ''}<br>
            <span style="color:var(--SmartThemeQuoteColor,#888);">Schedule loaded ✓ Use the button above to edit.</span>
        </div>`;
}

// Wire modal events after popup renders
// Must run after DOM is ready; ST Popup builds HTML synchronously
// but we need RAF to ensure it's in the DOM
const _origOpen = openScheduleModal;
export { _origOpen as openScheduleModal };

// Patch to wire events after show()
Object.defineProperty(exports, 'openScheduleModal', {
    get: () => async function() {
        const context = SillyTavern.getContext();
        const { Popup, POPUP_TYPE } = context;

        if (!Popup) {
            toastr.error('SillyTavern Popup API not available. Update ST.');
            return;
        }

        const phoneData = getPhoneData();
        const schedule  = phoneData?.schedule;
        const html = buildModalHtml(schedule);
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

        // Wire click handlers after popup renders DOM
        requestAnimationFrame(wireModalEvents);

        await popup.show();

        if (savedOk) {
            toastr.success('Schedule saved.');
        }
    },
});
