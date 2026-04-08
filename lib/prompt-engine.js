/**
 * TextMe — Prompt assembly & generation engine
 * License: AGPL-3.0
 *
 * Uses generateRaw() for full isolation from the main chat preset.
 * Reads character card, user persona, world info, lorebooks, summary,
 * and RP context from SillyTavern — all read-only.
 *
 * CRITICAL: generateRaw signature is:
 *   generateRaw(prompt, api, instructOverride, quietToLoud, systemPrompt, maxTokens)
 *   - prompt: string (conversation/user text)
 *   - api: string ('' for default)
 *   - instructOverride: boolean
 *   - quietToLoud: boolean
 *   - systemPrompt: string
 *   - maxTokens: number
 */

import { getSettings, getPhoneData, savePhoneData, getCharName, getUserName } from './state.js';
import { log } from './logger.js';

/**
 * Assemble the system prompt from ST context (read-only).
 * @returns {string}
 */
function assembleSystemPrompt() {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    const sub = context.substituteParams || ((s) => s);

    // 1. Base SMS system prompt with macros resolved
    let system = sub(settings.smsPrompt);

    // 2. Character info — prefer getCharacterCardFields if available
    try {
        if (typeof context.getCharacterCardFields === 'function') {
            const fields = context.getCharacterCardFields();
            const parts = [];
            if (fields.description) parts.push(`Description: ${fields.description}`);
            if (fields.personality) parts.push(`Personality: ${fields.personality}`);
            if (fields.scenario) parts.push(`Scenario: ${fields.scenario}`);
            if (fields.mes_example) parts.push(`Example dialogue:\n${fields.mes_example}`);
            if (parts.length > 0) {
                system += `\n\n[Character Info]\n${parts.join('\n')}`;
            }
        } else {
            const char = context.characters?.[context.characterId];
            if (char) {
                const parts = [];
                if (char.description) parts.push(`Description: ${char.description}`);
                if (char.personality) parts.push(`Personality: ${char.personality}`);
                if (char.scenario) parts.push(`Scenario: ${char.scenario}`);
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

    // 4. World Info / Lorebooks (if available)
    try {
        if (typeof context.getWorldInfoPrompt === 'function') {
            const worldInfo = context.getWorldInfoPrompt();
            if (worldInfo && worldInfo.trim()) {
                system += `\n\n[World Info / Lorebook]\n${worldInfo.trim()}`;
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

    // 7. Current time with date
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dateStr = now.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const dayStr = now.toLocaleDateString([], { weekday: 'long' });
    system += `\n\nCurrent time: [${timeStr}], ${dayStr}, ${dateStr}.`;

    return system;
}

/**
 * Build the conversation text from phone history.
 * Formats as a multi-turn dialogue string.
 * @param {string|null} userMessage - The new user message
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
            const ts = msg.time ? new Date(msg.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
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
 * The model is instructed to separate messages with blank lines.
 * @param {string} text
 * @returns {string[]}
 */
export function splitResponseIntoMessages(text) {
    if (!text) return [];

    // Remove character name prefix if model added it
    const charName = getCharName();
    let cleaned = text.trim();
    if (cleaned.startsWith(`${charName}:`)) {
        cleaned = cleaned.substring(charName.length + 1).trim();
    }

    // Split by double newline (blank line separator)
    const parts = cleaned.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0);

    // If no splits found, try single newlines for short messages
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
 * Returns an array of message strings (split by blank lines).
 * @param {string|null} userMessage - null for autonomous messages
 * @returns {Promise<string[]>}
 */
export async function generatePhoneResponse(userMessage) {
    const context = SillyTavern.getContext();
    const settings = getSettings();

    const systemPrompt = assembleSystemPrompt();
    const conversationText = buildConversationText(userMessage);

    const { generateRaw } = context;
    if (!generateRaw) {
        throw new Error('generateRaw not available. Update SillyTavern to the latest version.');
    }

    log.info('Generating phone response...');
    log.debug('System prompt length:', systemPrompt.length);
    log.debug('Conversation text length:', conversationText.length);

    // generateRaw(prompt, api, instructOverride, quietToLoud, systemPrompt, maxTokens)
    const result = await generateRaw(
        conversationText,           // prompt (user/conversation text)
        '',                         // api (use default)
        false,                      // instructOverride
        false,                      // quietToLoud
        systemPrompt,               // systemPrompt
        settings.maxTokens || 300   // maxTokens
    );

    const replyText = (typeof result === 'string' ? result : '').trim();
    if (!replyText) {
        throw new Error('Empty response from API');
    }

    // Remove any timestamp prefixes the model might have added
    const cleaned = replyText.replace(/^\[\d{1,2}:\d{2}\]\s*/gm, '');

    log.info('Response received, length:', cleaned.length);
    return splitResponseIntoMessages(cleaned);
}

/**
 * Generate for autonomous message (no user input).
 * Uses the autonomous prompt as additional instruction.
 * @returns {Promise<string[]>}
 */
export async function generateAutonomousMessage() {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    const sub = context.substituteParams || ((s) => s);

    const systemPrompt = assembleSystemPrompt();
    const autonomousInstruction = sub(settings.autonomousPrompt);

    // Build conversation from recent phone history
    const conversationText = buildConversationText(null);

    // Combine system prompt with autonomous instruction
    const fullSystem = systemPrompt + '\n\n' + autonomousInstruction;

    const { generateRaw } = context;
    if (!generateRaw) throw new Error('generateRaw not available');

    // generateRaw(prompt, api, instructOverride, quietToLoud, systemPrompt, maxTokens)
    const result = await generateRaw(
        conversationText,
        '',
        false,
        false,
        fullSystem,
        settings.maxTokens || 300
    );

    const replyText = (typeof result === 'string' ? result : '').trim();
    if (!replyText) throw new Error('Empty autonomous response');

    const cleaned = replyText.replace(/^\[\d{1,2}:\d{2}\]\s*/gm, '');
    return splitResponseIntoMessages(cleaned);
}
