/**
 * TextMe — Prompt assembly & generation engine
 * License: AGPL-3.0
 *
 * Uses generateRaw() for full isolation from the main chat preset.
 * Reads character card, user persona, world info, lorebooks, summary,
 * and RP context from SillyTavern — all read-only.
 *
 * Responses are split into multiple messages by blank lines.
 */

import { EXTENSION_NAME, getSettings, getPhoneData, savePhoneData, getCharName, getUserName } from './state.js';
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
        const userPersona = context.name1 || '';
        // User description if available (ST stores it in persona description)
        const userDesc = context.persona?.description || '';
        if (userPersona || userDesc) {
            let personaBlock = `[User Info]\nName: ${userPersona}`;
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
 * Build the messages array for generation.
 * @param {string} userMessage - The new user message (optional, for autonomous messages pass null)
 * @returns {{ systemPrompt: string, history: Array<{role:string,content:string}> }}
 */
function buildMessages(userMessage) {
    const phoneData = getPhoneData();
    const systemPrompt = assembleSystemPrompt();

    const history = [];
    if (phoneData && phoneData.messages.length > 0) {
        // Limit history to avoid token overflow — last 50 messages
        const msgs = phoneData.messages.slice(-50);
        for (const msg of msgs) {
            if (msg.type === 'image') continue;
            // Add timestamp prefix for context awareness
            const ts = msg.time ? new Date(msg.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
            const prefix = ts ? `[${ts}] ` : '';
            history.push({
                role: msg.isUser ? 'user' : 'assistant',
                content: prefix + msg.text,
            });
        }
    }

    if (userMessage) {
        const nowTs = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        history.push({ role: 'user', content: `[${nowTs}] ${userMessage}` });
    }

    return { systemPrompt, history };
}

/**
 * Split a response into individual messages.
 * The model is instructed to separate messages with blank lines.
 * @param {string} text
 * @returns {string[]}
 */
export function splitResponseIntoMessages(text) {
    if (!text) return [];

    // Split by double newline (blank line separator)
    const parts = text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0);

    // If no splits found, try single newlines for short messages
    if (parts.length <= 1 && text.includes('\n')) {
        const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        // Only split by single newline if messages are short (chat-like)
        if (lines.length > 1 && lines.every(l => l.length < 200)) {
            return lines;
        }
    }

    return parts.length > 0 ? parts : [text.trim()];
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

    const { systemPrompt, history } = buildMessages(userMessage);

    const { generateRaw } = context;
    if (!generateRaw) {
        throw new Error('generateRaw not available. Update SillyTavern to the latest version.');
    }

    log.info('Generating phone response...');
    log.debug('System prompt length:', systemPrompt.length);
    log.debug('History messages:', history.length);

    const messages = [
        { role: 'system', content: systemPrompt },
        ...history,
    ];

    const result = await generateRaw(messages, {
        maxTokens: settings.maxTokens || 300,
        temperature: settings.temperature ?? 1.0,
    });

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
 * Uses the autonomous prompt.
 * @returns {Promise<string[]>}
 */
export async function generateAutonomousMessage() {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    const sub = context.substituteParams || ((s) => s);

    // Build a modified system prompt with autonomous instruction
    const { systemPrompt } = buildMessages(null);
    const autonomousInstruction = sub(settings.autonomousPrompt);

    const messages = [
        { role: 'system', content: systemPrompt + '\n\n' + autonomousInstruction },
    ];

    // Add recent phone history
    const phoneData = getPhoneData();
    if (phoneData && phoneData.messages.length > 0) {
        const recent = phoneData.messages.slice(-20);
        for (const msg of recent) {
            if (msg.type === 'image') continue;
            messages.push({
                role: msg.isUser ? 'user' : 'assistant',
                content: msg.text,
            });
        }
    }

    const { generateRaw } = context;
    if (!generateRaw) throw new Error('generateRaw not available');

    const result = await generateRaw(messages, {
        maxTokens: settings.maxTokens || 300,
        temperature: settings.temperature ?? 1.0,
    });

    const replyText = (typeof result === 'string' ? result : '').trim();
    if (!replyText) throw new Error('Empty autonomous response');

    const cleaned = replyText.replace(/^\[\d{1,2}:\d{2}\]\s*/gm, '');
    return splitResponseIntoMessages(cleaned);
}
