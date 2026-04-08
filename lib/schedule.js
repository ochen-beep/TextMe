/**
 * TextMe — Schedule & Status system
 * License: AGPL-3.0
 *
 * Generates character schedules via generateRaw(),
 * provides current status based on day/hour,
 * and status influence on prompt generation.
 *
 * FIX: generateRaw called with OBJECT signature — required for Chat
 * Completion API (OpenAI/Gemini/etc.). String-signature mode requires
 * an active chat slot to write the result into; object-signature returns
 * the text directly. This was the root cause of "No message generated".
 */

import { getSettings, getPhoneData, savePhoneData, getCharName } from './state.js';
import { log } from './logger.js';

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const STATUSES = ['online', 'idle', 'dnd', 'offline'];

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
 * FIX: Uses object-signature generateRaw({ prompt, system_prompt, max_new_tokens })
 * instead of the positional-string signature. With Chat Completion APIs
 * (OpenAI/Gemini/Claude), the string-signature routes the output through
 * ST's quiet generation pipeline which needs an active chat slot — when
 * called from an extension without one, ST throws "No message generated"
 * even though the API returns a perfect response (visible in server logs).
 * Object-signature bypasses this and returns the text directly.
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

    const systemPrompt = `${scheduleInstruction}\n\n${charInfo}\nRespond ONLY with valid JSON. No markdown, no code blocks, no extra text — just the raw JSON object.`;
    const userPrompt = `Generate the weekly schedule for ${charName} now. Output only the JSON object with days monday through sunday, each containing 24 hourly slots with hour (0-23), status (online/idle/dnd/offline), and activity fields.`;

    // FIX: Object-signature — returns result text directly, no chat slot needed.
    const result = await generateRaw({
        prompt: userPrompt,
        system_prompt: systemPrompt,
        max_new_tokens: 4000,
    });

    const raw = (typeof result === 'string' ? result : '').trim();

    if (!raw) {
        throw new Error('Empty response from AI. Check your API connection.');
    }

    log.debug('Schedule raw response length:', raw.length);

    // Parse JSON — strip markdown fences and any trailing XML-like tags the model may add
    let schedule;
    try {
        let cleaned = raw
            .replace(/^```(?:json)?\n?/i, '')
            .replace(/\n?```$/i, '')
            .replace(/<\/?[A-Za-z][^>]*>/g, '') // strip stray HTML/XML tags e.g. <P/>
            .trim();

        // If there's JSON buried inside surrounding text, extract it
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

/**
 * Render the schedule editor table.
 */
export function renderScheduleEditor(container) {
    if (!container) return;

    const phoneData = getPhoneData();
    const schedule = phoneData?.schedule;

    if (!schedule) {
        container.innerHTML = '<p style="color:var(--SmartThemeQuoteColor,#888);font-style:italic;">No schedule generated yet. Click "Generate Schedule" above.</p>';
        return;
    }

    let html = '<div class="textme-schedule-grid">';
    html += '<div class="textme-schedule-header"><span></span>';
    for (let h = 0; h < 24; h++) {
        html += `<span class="textme-schedule-hour">${h}</span>`;
    }
    html += '</div>';

    for (const day of DAYS) {
        html += '<div class="textme-schedule-row">';
        html += `<span class="textme-schedule-day">${day.charAt(0).toUpperCase() + day.slice(1, 3)}</span>`;
        const dayData = schedule[day] || [];
        for (let h = 0; h < 24; h++) {
            const slot = dayData.find(s => s.hour === h) || { status: 'online', activity: '' };
            const statusClass = `textme-sched-${slot.status}`;
            html += `<span class="textme-schedule-cell ${statusClass}" data-day="${day}" data-hour="${h}" title="${slot.activity || slot.status}"></span>`;
        }
        html += '</div>';
    }

    html += '</div>';
    html += '<div class="textme-schedule-legend">';
    html += '<span><span class="textme-sched-dot textme-sched-online"></span> Online</span>';
    html += '<span><span class="textme-sched-dot textme-sched-idle"></span> Idle</span>';
    html += '<span><span class="textme-sched-dot textme-sched-dnd"></span> DND</span>';
    html += '<span><span class="textme-sched-dot textme-sched-offline"></span> Offline</span>';
    html += '</div>';

    container.innerHTML = html;

    // Click to cycle status
    container.querySelectorAll('.textme-schedule-cell').forEach(cell => {
        cell.addEventListener('click', () => {
            const day = cell.dataset.day;
            const hour = parseInt(cell.dataset.hour, 10);
            cycleStatus(day, hour, cell);
        });
    });
}

async function cycleStatus(day, hour, cell) {
    const phoneData = getPhoneData();
    if (!phoneData?.schedule?.[day]) return;

    const slot = phoneData.schedule[day].find(s => s.hour === hour);
    if (!slot) return;

    const currentIdx = STATUSES.indexOf(slot.status);
    const nextIdx = (currentIdx + 1) % STATUSES.length;
    slot.status = STATUSES[nextIdx];

    cell.className = `textme-schedule-cell textme-sched-${slot.status}`;
    cell.title = `${slot.activity || slot.status}`;

    await savePhoneData();
}
