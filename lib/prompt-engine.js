// TextMe — Prompt assembly & generation engine
// License: AGPL-3.0

import { getContext } from '../../../../extensions.js';
import { substituteParams } from '../../../../script.js';
import { EXTENSION_NAME, getSettings, getPhoneData, savePhoneData } from './state.js';

/**
 * Generate a phone response from the character.
 * Uses ConnectionManagerRequestService.sendRequest() for full isolation
 * from the main chat preset.
 *
 * @param {string} userMessage — the user's text message
 * @returns {Promise<string>} — the character's reply
 */
export async function generatePhoneResponse(userMessage) {
    const context = getContext();
    const settings = getSettings();
    const phoneData = getPhoneData();

    if (!phoneData) throw new Error('No active chat');
    if (!settings.connectionProfileId) throw new Error('No Connection Profile selected in TextMe settings');

    // ── 1. Character info from card ──
    const char = context.characters[context.characterId];
    const charName = char?.name || context.name2;
    const userName = context.name1;
    const charDesc = char?.description || '';
    const charPersonality = char?.personality || '';
    const charScenario = char?.scenario || '';

    // ── 2. Recent RP chat context (read-only) ──
    const rpMessages = context.chat
        .filter(m => !m.is_system)
        .slice(-(settings.contextMessages || 10))
        .map(m => `${m.name}: ${m.mes}`)
        .join('\n');

    // ── 3. World Info / Lorebooks ──
    let worldInfo = '';
    try {
        if (typeof context.getWorldInfoPrompt === 'function') {
            worldInfo = context.getWorldInfoPrompt();
        }
    } catch (e) {
        console.warn(`[${EXTENSION_NAME}] Could not get World Info:`, e);
    }

    // ── 4. Summary (from Summarize extension if available) ──
    let summary = '';
    try {
        const summaryMsg = context.chat.slice().reverse().find(m => m.extra?.memory);
        if (summaryMsg) summary = summaryMsg.extra.memory;
    } catch (e) { /* no summary available */ }

    // ── 5. Assemble system prompt ──
    let systemPrompt = substituteParams(settings.smsPrompt)
        + `\n\nCharacter: ${charName}`
        + (charDesc ? `\nDescription: ${charDesc}` : '')
        + (charPersonality ? `\nPersonality: ${charPersonality}` : '')
        + (charScenario ? `\nScenario: ${charScenario}` : '');

    if (worldInfo) {
        systemPrompt += `\n\nWorld context:\n${worldInfo}`;
    }
    if (summary) {
        systemPrompt += `\n\nStory so far:\n${summary}`;
    }
    if (rpMessages) {
        systemPrompt += `\n\nRecent events (for context only — do NOT continue the roleplay, only use as background):\n${rpMessages}`;
    }

    // ── 6. Phone chat history ──
    const messages = [{ role: 'system', content: systemPrompt }];

    for (const msg of phoneData.messages) {
        if (msg.type === 'image') continue; // skip images in history
        messages.push({
            role: msg.isUser ? 'user' : 'assistant',
            content: msg.text,
        });
    }

    // Add current user message
    messages.push({ role: 'user', content: userMessage });

    // ── 7. Send via Connection Profile ──
    const response = await context.ConnectionManagerRequestService.sendRequest(
        settings.connectionProfileId,
        messages,
        settings.maxTokens,
        {
            temperature: settings.temperature,
            includePreset: false, // DO NOT apply main chat preset
            extractData: true,
        }
    );

    const replyText = typeof response === 'string' ? response : response?.content || response?.text || '';

    // ── 8. Save both messages to phone storage ──
    phoneData.messages.push(
        { isUser: true, text: userMessage, time: Date.now() },
        { isUser: false, text: replyText, time: Date.now() },
    );
    phoneData.lastActivity = Date.now();
    phoneData.autonomousCount = 0; // reset on user message
    savePhoneData();

    return replyText;
}
