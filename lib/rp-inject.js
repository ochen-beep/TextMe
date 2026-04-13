/**
 * TextMe — RP Injection
 * License: AGPL-3.0
 *
 * Injects the SMS conversation history into the SillyTavern roleplay chat
 * prompt using ST's standard setExtensionPrompt() API.
 *
 * The injection is registered as a persistent slot ('TextMe_sms') that ST
 * automatically includes in every RP generation. Calling updateRpInjection()
 * refreshes the slot with the current message history; clearRpInjection()
 * sets the value to an empty string which effectively disables it.
 *
 * Format:
 *   <sms_history>
 *   [Optional header line from settings.rpInjectHeader]
 *   --- DD.MM.YYYY ---
 *   [HH:MM] User: message
 *   [HH:MM] CharName: message
 *   </sms_history>
 *
 * The header supports {{char}} and {{user}} macros which are resolved at
 * injection time via substituteParamsMacros (or simple string replace if
 * ST's helper is unavailable).
 *
 * Settings consumed:
 *   rpInjectEnabled  — master toggle
 *   rpInjectMessages — how many recent SMS to include (0 = all)
 *   rpInjectDepth    — ST injection depth (0 = after last message)
 *   rpInjectPosition — extension_prompt_types value (0/1/2)
 *   rpInjectRole     — extension_prompt_roles value (0/1/2)
 *   rpInjectHeader   — optional preamble injected inside <sms_history>
 */

import { getSettings, getPhoneData, getCharName, getUserName, sliceMessageHistory } from './state.js';
import { getCurrentTime } from './custom-time.js';
import { log } from './logger.js';

// Unique key for our ST extension prompt slot
const INJECT_KEY = 'TextMe_sms';

// ═══════════════════════════════════════════════
// Internal helpers
// ═══════════════════════════════════════════════

/**
 * Resolve {{char}} and {{user}} macros in a string.
 * Uses ST's substituteParams if available, falls back to a simple replace.
 * @param {string} text
 * @returns {string}
 */
function resolveMacros(text) {
    if (!text) return '';
    const context = SillyTavern.getContext();
    // ST's substituteParams resolves all standard macros including {{char}}/{{user}}
    if (typeof context.substituteParams === 'function') {
        return context.substituteParams(text);
    }
    // Fallback: manual substitution
    const charName = getCharName();
    const userName = getUserName();
    return text
        .replaceAll('{{char}}', charName)
        .replaceAll('{{Char}}', charName)
        .replaceAll('{{user}}', userName)
        .replaceAll('{{User}}', userName);
}

/**
 * Build the <sms_history>…</sms_history> injection block from current phone data.
 * Returns an empty string if there are no messages.
 * @returns {string}
 */
function buildSmsBlock() {
    const settings  = getSettings();
    const phoneData = getPhoneData();
    const charName  = getCharName();
    const userName  = getUserName();

    const allMessages = phoneData?.messages ?? [];
    if (allMessages.length === 0) return '';

    const msgs = sliceMessageHistory(
        allMessages,
        settings.rpInjectMessages ?? 20,
        settings.rpInjectDays     ?? 0,
        getCurrentTime,
    );

    // Filter out image-type messages
    const textMsgs = msgs.filter(m => m.type !== 'image' && m.text);
    if (textMsgs.length === 0) return '';

    const lines = [];

    // Optional header (supports {{char}} / {{user}} macros)
    const rawHeader = settings.rpInjectHeader ?? '';
    const header    = resolveMacros(rawHeader.trim());
    if (header) lines.push(header);

    let lastDay = '';
    let dayCount = 0;

    for (const msg of textMsgs) {
        if (msg.time) {
            const d   = new Date(msg.time);
            const day = d.toDateString();

            // Insert date separator when the calendar day changes
            if (day !== lastDay) {
                const dateLabel = d.toLocaleDateString('ru-RU', {
                    day: '2-digit', month: '2-digit', year: 'numeric',
                });
                lines.push(`--- ${dateLabel} ---`);
                lastDay = day;
                dayCount++;
            }

            const ts     = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const sender = msg.isUser ? userName : charName;
            lines.push(`[${ts}] ${sender}: ${msg.text}`);
        } else {
            const sender = msg.isUser ? userName : charName;
            lines.push(`${sender}: ${msg.text}`);
        }
    }

    return `<sms_history>\n${lines.join('\n')}\n</sms_history>`;
}

// ═══════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════

/**
 * Refresh the SMS injection block in ST's extension prompt registry.
 * Call this after every SMS send/receive to keep the RP context current.
 * Does nothing if rpInjectEnabled is false.
 */
export function updateRpInjection() {
    const settings = getSettings();
    const context  = SillyTavern.getContext();

    if (!settings.rpInjectEnabled) {
        // Ensure the slot is cleared if the feature is off
        if (typeof context.setExtensionPrompt === 'function') {
            context.setExtensionPrompt(INJECT_KEY, '', 1, 0);
        }
        return;
    }

    if (typeof context.setExtensionPrompt !== 'function') {
        log.warn('[RP Inject] setExtensionPrompt not available in this ST version.');
        return;
    }

    const block    = buildSmsBlock();
    const position = Number(settings.rpInjectPosition ?? 1);  // default: IN_CHAT
    const depth    = Number(settings.rpInjectDepth    ?? 0);
    const role     = Number(settings.rpInjectRole     ?? 0);  // default: SYSTEM

    // Human-readable position label for the log
    const posLabel = ['after_sys', 'in_chat', 'before_sys'][position] ?? position;
    const roleLabel = ['system', 'user', 'assistant'][role] ?? role;

    context.setExtensionPrompt(INJECT_KEY, block, position, depth, false, role);

    if (block) {
        // Count messages injected (lines starting with [ or sender:)
        const msgLines = block.split('\n').filter(l => l.match(/^\[\d{2}:\d{2}\]|^\w.*:/) );
        log.info(
            `[RP Inject] Injected ${msgLines.length} messages (${block.length} chars) ` +
            `→ position=${posLabel}, depth=${depth}, role=${roleLabel}`
        );
        // Show first line of resolved header for macro debugging
        const headerLine = (settings.rpInjectHeader ?? '').trim();
        if (headerLine) {
            const resolved = block.split('\n')[1] ?? '';
            log.debug(`[RP Inject] Resolved header: "${resolved.substring(0, 80)}"`);
        }
    } else {
        log.info('[RP Inject] No SMS messages to inject — slot cleared.');
    }
}

/**
 * Remove the SMS injection from ST's extension prompt registry.
 * Call this when the phone UI is destroyed or the feature is disabled.
 */
export function clearRpInjection() {
    const context = SillyTavern.getContext();
    if (typeof context.setExtensionPrompt === 'function') {
        context.setExtensionPrompt(INJECT_KEY, '', 1, 0);
        log.info('[RP Inject] Injection slot cleared (phone destroyed or feature disabled).');
    }
}
