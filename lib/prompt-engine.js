/**
 * TextMe — Prompt assembly & generation engine
 * License: AGPL-3.0
 *
 * FIX: buildConversationText() no longer takes a userMessage parameter.
 *      The user message is always already in phoneData.messages by the
 *      time this function is called, so passing it again caused every
 *      user message to appear twice in the prompt.
 *
 * FIX: World Info now receives chat.map(m => m.mes || '') instead of the
 *      raw context.chat array of objects — ST's getWorldInfoPrompt()
 *      expects strings, not message objects.
 *
 * FIX: stripSpeakerPrefix() now also matches the first token of charName
 *      (e.g. "CRISPIN™") so short model-generated prefixes are stripped
 *      even when charName is a long display string.
 *
 * FIX: splitResponseIntoMessages() Step 2 (single-\n expansion) is now
 *      applied to EVERY part produced by Step 1, not only when Step 1
 *      returned exactly one part.
 *
 * FIX: generatePhoneResponse() and generateAutonomousMessage() now accept
 *      an optional AbortSignal and forward it to generateRaw() so that
 *      TextMe's own generation can be cancelled independently from the
 *      ST main-chat Stop button.
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
    try {
        if (typeof context.getWorldInfoPrompt === 'function') {
            const chat = context.chat || [];
            const chatStrings = chat.map(m => (m && typeof m.mes === 'string' ? m.mes : ''));
            const worldInfo = await context.getWorldInfoPrompt(chatStrings, true);
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
 * @returns {string}
 */
function buildConversationText() {
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

    // End with character name to prompt response
    lines.push(`${charName}:`);

    return lines.join('\n');
}

/**
 * Strip a "Speaker: " prefix from a single text part.
 */
function stripSpeakerPrefix(part, charName) {
    const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const fullEscaped = escapeRe(charName);

    const firstWordMatch = charName.match(/^[\w™®©]+/);
    const firstToken = firstWordMatch ? firstWordMatch[0] : null;
    const firstEscaped = firstToken ? escapeRe(firstToken) : null;

    const alts = [fullEscaped];
    if (firstEscaped && firstEscaped !== fullEscaped) {
        alts.push(firstEscaped + '™?');
    }
    alts.push('\\{\\{char\\}\\}');

    const pattern = new RegExp(
        `^(?:${alts.join('|')})\\s*[:—–-]\\s*`,
        'i'
    );
    return part.replace(pattern, '').trim();
}

/**
 * Split a response into individual messages.
 */
export function splitResponseIntoMessages(text) {
    if (!text) return [];

    const charName = getCharName();
    let cleaned = text.trim();

    // Strip timestamp prefixes the model might have added
    cleaned = cleaned.replace(/^\[\d{1,2}:\d{2}\]\s*/gm, '');

    // Step 1: split by double newline
    let parts = cleaned.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0);

    // Step 2: for EVERY part, expand single-\n lines into separate bubbles
    const expanded = [];
    for (const part of parts) {
        if (part.includes('\n')) {
            const lines = part.split('\n').map(l => l.trim()).filter(l => l.length > 0);
            if (lines.length > 1 && lines.every(l => l.length <= 180)) {
                expanded.push(...lines);
                continue;
            }
        }
        expanded.push(part);
    }
    parts = expanded;

    // Step 3: strip "CharName:" prefix from EVERY part
    parts = parts
        .map(p => stripSpeakerPrefix(p, charName))
        .filter(p => p.length > 0);

    return parts.length > 0 ? parts : (cleaned ? [cleaned] : []);
}

/**
 * Generate a phone response from the character.
 *
 * @param {AbortSignal} [signal]  Optional AbortSignal for cancellation.
 *   Pass phoneAbortController.signal so TextMe can be cancelled independently
 *   from the ST main-chat Stop button.
 * @returns {Promise<string[]>}
 */
export async function generatePhoneResponse(signal) {
    const context = SillyTavern.getContext();
    const settings = getSettings();

    const systemPrompt     = await assembleSystemPrompt();
    const conversationText = buildConversationText();

    const { generateRaw } = context;
    if (!generateRaw) {
        throw new Error('generateRaw not available. Update SillyTavern to the latest version.');
    }

    log.info('Generating phone response...');
    log.debug('System prompt length:', systemPrompt.length);
    log.debug('Conversation text length:', conversationText.length);
    log.debug('System prompt (first 500):', systemPrompt.substring(0, 500));
    log.debug('Conversation prompt (first 500):', conversationText.substring(0, 500));

    const result = await generateRaw({
        prompt:         conversationText,
        systemPrompt:   systemPrompt,
        max_new_tokens: settings.maxTokens || 300,
        ...(signal ? { signal } : {}),
    });

    const replyText = (typeof result === 'string' ? result : '').trim();
    if (!replyText) {
        throw new Error('Empty response from API');
    }

    log.debug('Raw API response (first 500):', replyText.substring(0, 500));
    log.info('Response received, length:', replyText.length);
    return splitResponseIntoMessages(replyText);
}

/**
 * Generate an autonomous (unprompted) message.
 *
 * @param {AbortSignal} [signal]  Optional AbortSignal for cancellation.
 * @returns {Promise<string[]>}
 */
export async function generateAutonomousMessage(signal) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    const sub = context.substituteParams || ((s) => s);

    const systemPrompt          = await assembleSystemPrompt();
    const autonomousInstruction = sub(settings.autonomousPrompt);
    const conversationText      = buildConversationText();
    const fullSystemPrompt      = systemPrompt + '\n\n' + autonomousInstruction;

    const { generateRaw } = context;
    if (!generateRaw) throw new Error('generateRaw not available');

    log.info('Generating autonomous message...');
    log.debug('Autonomous system prompt length:', fullSystemPrompt.length);
    log.debug('Autonomous system prompt (first 500):', fullSystemPrompt.substring(0, 500));
    log.debug('Autonomous conversation (first 300):', conversationText.substring(0, 300));

    const result = await generateRaw({
        prompt:         conversationText,
        systemPrompt:   fullSystemPrompt,
        max_new_tokens: settings.maxTokens || 300,
        ...(signal ? { signal } : {}),
    });

    const replyText = (typeof result === 'string' ? result : '').trim();
    if (!replyText) throw new Error('Empty autonomous response');

    log.debug('Autonomous raw response (first 500):', replyText.substring(0, 500));

    return splitResponseIntoMessages(replyText);
}
