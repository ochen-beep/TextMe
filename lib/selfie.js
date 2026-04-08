/**
 * TextMe — Selfie generation pipeline
 * License: AGPL-3.0
 *
 * Generates selfie descriptions via AI, then sends to image API.
 * FIXED: generateRaw called with correct string signature.
 */

import { getSettings, getPhoneData, savePhoneData, getCharName } from './state.js';
import { log } from './logger.js';

/**
 * Generate a selfie and display it in the phone chat.
 * @returns {Promise<string>} The image URL/path
 */
export async function generateSelfie() {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    const sub = context.substituteParams || ((s) => s);

    if (!settings.selfieEnabled) {
        throw new Error('Selfie generation is not enabled.');
    }

    if (!settings.imageApiUrl) {
        throw new Error('Image API endpoint is not configured. Go to TextMe settings → Selfie Generation.');
    }

    const { generateRaw } = context;
    if (!generateRaw) throw new Error('generateRaw not available');

    log.info('Starting selfie generation pipeline...');

    // Step 1: Generate selfie description
    const selfiePrompt = sub(settings.selfiePrompt);

    // Gather context for the selfie
    let contextInfo = '';
    try {
        if (typeof context.getCharacterCardFields === 'function') {
            const fields = context.getCharacterCardFields();
            if (fields.description) contextInfo += `Character: ${fields.description}\n`;
        }
        const phoneData = getPhoneData();
        if (phoneData?.messages.length > 0) {
            const recent = phoneData.messages.slice(-10)
                .filter(m => m.text)
                .map(m => `${m.isUser ? 'User' : getCharName()}: ${m.text}`)
                .join('\n');
            if (recent) contextInfo += `\nRecent conversation:\n${recent}\n`;
        }
    } catch (e) { /* ignore */ }

    const systemPrompt = `${selfiePrompt}\n\n${contextInfo}\nRespond ONLY with valid JSON. No markdown, no code blocks.`;
    const userPrompt = `Describe a selfie that ${getCharName()} would take right now based on the context. Output only the JSON object.`;

    // generateRaw(prompt, api, instructOverride, quietToLoud, systemPrompt, maxTokens)
    const descResult = await generateRaw(
        userPrompt,
        '',
        false,
        false,
        systemPrompt,
        1000
    );

    const rawDesc = (typeof descResult === 'string' ? descResult : '').trim();
    log.debug('Selfie description raw:', rawDesc);

    if (!rawDesc) {
        throw new Error('Empty selfie description from AI.');
    }

    let selfieJson;
    try {
        const cleaned = rawDesc.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
        selfieJson = JSON.parse(cleaned);
    } catch (e) {
        log.error('Failed to parse selfie JSON:', rawDesc);
        throw new Error('AI returned invalid selfie description JSON.');
    }

    if (!selfieJson.prompt) {
        throw new Error('Selfie description is missing "prompt" field.');
    }

    // Step 2: Send to Image API
    log.info('Sending to image API:', settings.imageApiUrl);

    const imagePayload = {
        prompt: selfieJson.prompt,
        model: settings.imageModel || undefined,
        n: 1,
        size: '1024x1024',
    };

    if (settings.referenceImageBase64) {
        imagePayload.reference_image = settings.referenceImageBase64;
    }

    const headers = { 'Content-Type': 'application/json' };
    if (settings.imageApiKey) {
        headers['Authorization'] = `Bearer ${settings.imageApiKey}`;
    }

    const response = await fetch(settings.imageApiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(imagePayload),
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => 'Unknown error');
        throw new Error(`Image API error ${response.status}: ${errText}`);
    }

    const imageResult = await response.json();
    log.debug('Image API response received');

    let imageUrl = null;
    if (imageResult.data?.[0]?.url) {
        imageUrl = imageResult.data[0].url;
    } else if (imageResult.data?.[0]?.b64_json) {
        imageUrl = `data:image/png;base64,${imageResult.data[0].b64_json}`;
    } else if (imageResult.url) {
        imageUrl = imageResult.url;
    } else if (imageResult.image) {
        imageUrl = imageResult.image;
    }

    if (!imageUrl) {
        throw new Error('Could not extract image URL from API response.');
    }

    // Step 3: Save to phone messages
    const phoneData = getPhoneData();
    if (phoneData) {
        phoneData.messages.push({
            isUser: false,
            type: 'image',
            src: imageUrl,
            text: selfieJson.prompt.substring(0, 100) + '...',
            time: Date.now(),
        });
        phoneData.lastActivity = Date.now();
        await savePhoneData();
    }

    log.info('Selfie generated successfully.');
    return imageUrl;
}
