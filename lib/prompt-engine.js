/**
 * TextMe — Prompt assembly & generation engine
 * License: AGPL-3.0
 *
 * Uses generateRaw() for full isolation from the main chat preset.
 * We assemble our own system prompt with character info, world info,
 * RP context summary, and phone conversation history.
 */

import { EXTENSION_NAME, getSettings, getPhoneData, savePhoneData, getCharName, getUserName } from './state.js';

/**
 * Assemble the system prompt from ST context (read-only).
 * @returns {string}
 */
function assembleSystemPrompt() {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    const substituteParams = context.substituteParams || ((s) => s);

    // 1. Base SMS system prompt with macros resolved
    let system = substituteParams(settings.smsPrompt);

    // 2. Character info from card
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

    // 3. World Info / Lorebooks (if available)
    try {
        if (typeof context.getWorldInfoPrompt === 'function') {
            const worldInfo = context.getWorldInfoPrompt();
            if (worldInfo && worldInfo.trim()) {
                system += `\n\n[World Info]\n${worldInfo.trim()}`;
            }
        }
    } catch (e) {
        console.warn(`[${EXTENSION_NAME}] Could not get World Info:`, e);
    }

    // 4. Summary from Summarize extension (read-only)
    try {
        const chat = context.chat;
        if (chat && chat.length > 0) {
            // Find the most recent message with a summary attached
            for (let i = chat.length - 1; i >= 0; i--) {
                if (chat[i].extra?.memory) {
                    system += `\n\n[Story Summary]\n${chat[i].extra.memory}`;
                    break;
                }
            }
        }
    } catch (e) { /* no summary */ }

    // 5. Recent RP messages for context
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
        console.warn(`[${EXTENSION_NAME}] Could not read RP chat:`, e);
    }

    // 6. Current time
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dayStr = now.toLocaleDateString([], { weekday: 'long' });
    system += `\n\nCurrent time: ${timeStr}, ${dayStr}.`;

    return system;
}

/**
 * Build the messages array for generation.
 * @param {string} userMessage - The new user message
 * @returns {Array<{role: string, content: string}>}
 */
function buildMessages(userMessage) {
    const phoneData = getPhoneData();
    const systemPrompt = assembleSystemPrompt();

    // Phone conversation history
    const history = [];
    if (phoneData && phoneData.messages.length > 0) {
        // Limit history to avoid token overflow — last 40 messages
        const msgs = phoneData.messages.slice(-40);
        for (const msg of msgs) {
            if (msg.type === 'image') continue; // skip images
            history.push({
                role: msg.isUser ? 'user' : 'assistant',
                content: msg.text,
            });
        }
    }

    // Add new user message
    history.push({ role: 'user', content: userMessage });

    return { systemPrompt, history };
}

/**
 * Generate a phone response from the character.
 * @param {string} userMessage
 * @returns {Promise<string>}
 */
export async function generatePhoneResponse(userMessage) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    const phoneData = getPhoneData();

    if (!phoneData) throw new Error('No active chat');

    const { systemPrompt, history } = buildMessages(userMessage);

    // Use generateRaw — it handles Chat Completion vs Text Completion automatically
    const { generateRaw } = context;
    if (!generateRaw) {
        throw new Error('generateRaw not available. Update SillyTavern to the latest version.');
    }

    // For generateRaw, we pass the system prompt separately and the conversation as the prompt.
    // generateRaw accepts a string prompt OR an array of chat completion messages.
    // We'll pass as array for Chat Completion APIs:
    const messages = [
        { role: 'system', content: systemPrompt },
        ...history,
    ];

    const result = await generateRaw({
        prompt: messages,
        maxTokens: settings.maxTokens || 300,
    });

    const replyText = (typeof result === 'string' ? result : '').trim();
    if (!replyText) {
        throw new Error('Empty response from API');
    }

    return replyText;
}

/**
 * Send a user message and get a response. Saves both to phone data.
 * @param {string} userMessage
 * @returns {Promise<string>} The assistant's reply
 */
export async function sendAndReceive(userMessage) {
    const phoneData = getPhoneData();
    if (!phoneData) throw new Error('No active chat');

    // Save user message
    phoneData.messages.push({
        isUser: true,
        text: userMessage,
        time: Date.now(),
    });
    phoneData.lastActivity = Date.now();
    phoneData.autonomousCount = 0;
    await savePhoneData();

    // Generate response
    const reply = await generatePhoneResponse(userMessage);

    // Save assistant message
    phoneData.messages.push({
        isUser: false,
        text: reply,
        time: Date.now(),
    });
    phoneData.lastActivity = Date.now();
    await savePhoneData();

    return reply;
}
