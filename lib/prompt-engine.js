/**
 * TextMe — Prompt assembly & generation engine
 * License: AGPL-3.0
 *
 * Uses generateRaw() for full isolation from the main chat preset.
 * Reads character card, user persona, world info, lorebooks, summary,
 * and RP context from SillyTavern — all read-only.
 *
 * FIX (critical): generateRaw() uses camelCase `systemPrompt`, NOT snake_case
 *   `system_prompt`. Per official ST docs:
 *     generateRaw({ systemPrompt, prompt, prefill })
 *   With the wrong key, ST silently drops the system prompt — character card,
 *   lorebook, RP history, and persona are never sent to the API.
 *   This was the root cause of prompt_tokens: 63 despite 37764-char system prompt.
 *
 * FIX: getWorldInfoPrompt() called with context.chat array (not string)
 *      so keyword matching works against actual chat messages.
 * FIX: generateAutonomousMessage() includes phone conversation context.
 * FIX: Verbose logging — full systemPrompt and prompt logged at DEBUG level.
 */

import { getSettings, getPhoneData, savePhoneData, getCharName, getUserName } from './state.js';
import { getScheduleContext } from './schedule.js';
import { log } from './logger.js';

/**
 * Assemble the system prompt from ST context (read-only).
 * @returns {Promise<string>}
 */
async function assembleSystemPrompt() {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    const sub = context.substituteParams || ((s) => s);

    // 1. Base SMS system prompt with macros resolved
    let system = sub(settings.smsPrompt);

    // 2. Character info
    try {
        if (typeof context.getCharacterCardFields === 'function') {
            const fields = context.getCharacterCardFields();
            const parts = [];
            if (fields.description)  parts.push(`Description: ${fields.description}`);
            if (fields.personality)  parts.push(`Personality: ${fields.personality}`);
            if (fields.scenario)     parts.push(`Scenario: ${fields.scenario}`);
            if (fields.mes_example)  parts.push(`Example dialogue:\n${fields.mes_example}`);
            if (parts.length > 0) {
                system += `\n\n[Character Info]\n${parts.join('\n')}`;
            }
        } else {
            const char = context.characters?.[context.characterId];
            if (char) {
                const parts = [];
                if (char.description) parts.push(`Description: ${char.description}`);
                if (char.personality) parts.push(`Personality: ${char.personality}`);
                if (char.scenario)    parts.push(`Scenario: ${char.scenario}`);
                if (parts.length > 0) {
                    system += `\n\n[Character Info]\n${parts.join('\n')}`;
                }
            }
        }
    } catch (e) {
        log.warn('Could not get character card:', e);
    }

    // 3. User persona
    try {
        const userName = context.name1 || '';
        const userDesc = context.persona?.description || '';
        if (userName || userDesc) {
            let personaBlock = `[User Info]\nName: ${userName}`;
            if (userDesc) personaBlock += `\nDescription: ${userDesc}`;
            system += `\n\n${personaBlock}`;
        }
    } catch (e) { /* no persona */ }

    // 4. World Info / Lorebooks (async)
    // Pass context.chat (the actual message array) as the trigger input
    // so WI keyword scanning runs against real chat content.
    try {
        if (typeof context.getWorldInfoPrompt === 'function') {
            const chat = context.chat || [];
            const worldInfo = await context.getWorldInfoPrompt(chat, true);
            if (worldInfo && typeof worldInfo === 'string' && worldInfo.trim()) {
                system += `\n\n[World Info / Lorebook]\n${worldInfo.trim()}`;
                log.debug('World Info injected, length:', worldInfo.length);
            }
        }
    } catch (e) {
        log.warn('Could not get World Info:', e);
    }

    // 5. Summary from Summarize extension (read-only)
    try {
        const chat = context.chat;
        if (chat && chat.length > 0) {
            for (let i = chat.length - 1; i >= 0; i--) {
                if (chat[i].extra?.memory) {
                    system += `\n\n[Story Summary]\n${chat[i].extra.memory}`;
                    break;
                }
            }
        }
    } catch (e) { /* no summary */ }

    // 6. Recent RP messages for context
    try {
        const chat = context.chat;
        const limit = settings.contextMessages || 10;
        if (chat && chat.length > 0) {
            const recent = chat
                .filter(m => !m.is_system)
                .slice(-limit)
                .map(m => `${m.name}: ${m.mes}`)
                .join('\n');
            if (recent) {
                system += `\n\n[Recent RP Events — for context only, do NOT continue the roleplay]\n${recent}`;
            }
        }
    } catch (e) {
        log.warn('Could not read RP chat:', e);
    }

    // 7. Current time
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dateStr = now.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const dayStr  = now.toLocaleDateString([], { weekday: 'long' });
    system += `\n\nCurrent time: [${timeStr}], ${dayStr}, ${dateStr}.`;

    // 8. Schedule / Status context
    try {
        const schedCtx = getScheduleContext();
        if (schedCtx) system += schedCtx;
    } catch (e) {
        log.warn('Could not get schedule context:', e);
    }

    return system;
}

/**
 * Build the conversation text from phone history.
 * @param {string|null} userMessage
 * @returns {string}
 */
function buildConversationText(userMessage) {
    const phoneData = getPhoneData();
    const charName = getCharName();
    const userName = getUserName();

    const lines = [];

    if (phoneData && phoneData.messages.length > 0) {
        const msgs = phoneData.messages.slice(-50);
        for (const msg of msgs) {
            if (msg.type === 'image') continue;
            const ts = msg.time
                ? new Date(msg.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                : '';
            const prefix = ts ? `[${ts}] ` : '';
            const sender = msg.isUser ? userName : charName;
            lines.push(`${prefix}${sender}: ${msg.text}`);
        }
    }

    if (userMessage) {
        const nowTs = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        lines.push(`[${nowTs}] ${userName}: ${userMessage}`);
    }

    // End with character name to prompt response
    lines.push(`${charName}:`);

    return lines.join('\n');
}

/**
 * Split a response into individual messages.
 * @param {string} text
 * @returns {string[]}
 */
export function splitResponseIntoMessages(text) {
    if (!text) return [];

    const charName = getCharName();
    let cleaned = text.trim();
    if (cleaned.startsWith(`${charName}:`)) {
        cleaned = cleaned.substring(charName.length + 1).trim();
    }

    // Split by double newline
    const parts = cleaned.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0);

    // If no splits, try single newlines for short messages
    if (parts.length <= 1 && cleaned.includes('\n')) {
        const lines = cleaned.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        if (lines.length > 1 && lines.every(l => l.length < 200)) {
            return lines;
        }
    }

    return parts.length > 0 ? parts : (cleaned ? [cleaned] : []);
}

/**
 * Generate a phone response from the character.
 *
 * FIX (critical): uses `systemPrompt` (camelCase) per ST docs.
 * With `system_prompt` (snake_case), ST silently ignored the entire system
 * prompt — sending only the conversation text as a bare user message.
 *
 * @param {string|null} userMessage
 * @returns {Promise<string[]>}
 */
export async function generatePhoneResponse(userMessage) {
    const context = SillyTavern.getContext();
    const settings = getSettings();

    const systemPrompt     = await assembleSystemPrompt();
    const conversationText = buildConversationText(userMessage);

    const { generateRaw } = context;
    if (!generateRaw) {
        throw new Error('generateRaw not available. Update SillyTavern to the latest version.');
    }

    log.info('Generating phone response...');
    log.debug('System prompt length:', systemPrompt.length);
    log.debug('Conversation text length:', conversationText.length);
    // Verbose debug: log first 500 chars of each for proxy-less debugging
    log.debug('System prompt (first 500):', systemPrompt.substring(0, 500));
    log.debug('Conversation prompt (first 500):', conversationText.substring(0, 500));

    // CRITICAL FIX: ST generateRaw() uses camelCase `systemPrompt`, not `system_prompt`.
    // Reference: https://docs.sillytavern.app/for-contributors/writing-extensions/
    // "const result = await generateRaw({ systemPrompt, prompt, prefill });"
    const result = await generateRaw({
        prompt:        conversationText,
        systemPrompt:  systemPrompt,       // <-- camelCase, this is what ST actually reads
        max_new_tokens: settings.maxTokens || 300,
    });

    const replyText = (typeof result === 'string' ? result : '').trim();
    if (!replyText) {
        throw new Error('Empty response from API');
    }

    log.debug('Raw API response (first 500):', replyText.substring(0, 500));

    // Strip timestamp prefixes the model might have added
    const cleaned = replyText.replace(/^\[\d{1,2}:\d{2}\]\s*/gm, '');

    log.info('Response received, length:', cleaned.length);
    return splitResponseIntoMessages(cleaned);
}

/**
 * Generate an autonomous (unprompted) message.
 * @returns {Promise<string[]>}
 */
export async function generateAutonomousMessage() {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    const sub = context.substituteParams || ((s) => s);

    const systemPrompt          = await assembleSystemPrompt();
    const autonomousInstruction = sub(settings.autonomousPrompt);
    const conversationText      = buildConversationText(null);
    const fullSystemPrompt      = systemPrompt + '\n\n' + autonomousInstruction;

    const { generateRaw } = context;
    if (!generateRaw) throw new Error('generateRaw not available');

    log.info('Generating autonomous message...');
    log.debug('Autonomous system prompt length:', fullSystemPrompt.length);
    log.debug('Autonomous system prompt (first 500):', fullSystemPrompt.substring(0, 500));
    log.debug('Autonomous conversation (first 300):', conversationText.substring(0, 300));

    // CRITICAL FIX: camelCase `systemPrompt`
    const result = await generateRaw({
        prompt:        conversationText,
        systemPrompt:  fullSystemPrompt,   // <-- camelCase
        max_new_tokens: settings.maxTokens || 300,
    });

    const replyText = (typeof result === 'string' ? result : '').trim();
    if (!replyText) throw new Error('Empty autonomous response');

    log.debug('Autonomous raw response (first 500):', replyText.substring(0, 500));

    const cleaned = replyText.replace(/^\[\d{1,2}:\d{2}\]\s*/gm, '');
    return splitResponseIntoMessages(cleaned);
}
