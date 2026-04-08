// TextMe — State management & defaults
// License: AGPL-3.0

import { getContext, extension_settings } from '../../../../extensions.js';

export const EXTENSION_NAME = 'TextMe';

// ═══════════════════════════════════════════════
// Default prompts
// ═══════════════════════════════════════════════

export const DEFAULT_PROMPTS = {
    sms: `You are {{char}}, texting with {{user}} on a phone.
Write short, casual text messages. Use emojis occasionally.
Do NOT write actions, narration, or prose — only text messages.
Stay in character based on your personality and current context.`,

    selfie: `Based on the current conversation, describe a selfie that {{char}} would take right now.

Output ONLY a JSON object:
{
  "prompt": "200-320 words in English. Phone selfie feel, not studio. Include: 1) CAMERA - shot type (arm/mirror/candid/pov_cam), angle, proximity, always mention phone selfie front camera feel. 2) SUBJECT - face details, hair, clothing, expression, natural skin texture, visible pores, real human asymmetry. 3) ENVIRONMENT - specific place, props, background blur. 4) LIGHT & COLOR - light source, color grade, phone camera texture, slight digital noise.",
  "style": "[light source], [phone camera feel], [color temperature]",
  "aspect_ratio": "1:1",
  "references": ["char"]
}`,

    summary: `Summarize the recent events from this roleplay chat in 2-3 sentences.
Focus on: where characters are, what they're doing, emotional state,
recent important events. Write as factual context, not narration.`,
};

// ═══════════════════════════════════════════════
// Default settings (global, saved in extension_settings)
// ═══════════════════════════════════════════════

export const DEFAULT_SETTINGS = {
    // General
    enabled: false,
    connectionProfileId: null,
    maxTokens: 300,
    contextMessages: 10,
    temperature: 1.0,

    // Prompts
    smsPrompt: DEFAULT_PROMPTS.sms,
    selfiePrompt: DEFAULT_PROMPTS.selfie,
    summaryPrompt: DEFAULT_PROMPTS.summary,

    // Selfie
    selfieEnabled: false,
    selfieTrigger: 'manual', // 'auto' | 'manual' | 'slash'
    imageApiUrl: '',
    imageApiKey: '',
    imageModel: '',
    referenceImageBase64: null,

    // Schedule & Status
    scheduleEnabled: false,

    // Autonomous
    autonomousEnabled: false,
    inactivityThreshold: 5, // minutes
    maxFollowups: 3,
    cooldownEscalation: true,

    // Appearance
    theme: 'dark',
    colorScheme: 'default',
    phoneSize: 'normal',
    phonePosition: 'right',
    soundEffects: true,
    showTimestamps: true,
};

// ═══════════════════════════════════════════════
// Getters
// ═══════════════════════════════════════════════

/** Get global extension settings */
export function getSettings() {
    return extension_settings[EXTENSION_NAME] || DEFAULT_SETTINGS;
}

/** Update a setting and save */
export function updateSetting(key, value) {
    if (!extension_settings[EXTENSION_NAME]) {
        extension_settings[EXTENSION_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    extension_settings[EXTENSION_NAME][key] = value;
}

// ═══════════════════════════════════════════════
// Per-chat phone data (stored in chatMetadata)
// ═══════════════════════════════════════════════

/**
 * Get phone data for current chat from chatMetadata.
 * Structure:
 * {
 *   messages: [{ isUser, text, time, type?, src? }],
 *   schedule: { ... },
 *   lastActivity: timestamp,
 *   autonomousCount: 0,
 *   scenes: [],       // future: completed scene summaries
 *   activeScene: null  // future: current scene metadata
 * }
 */
export function getPhoneData() {
    const context = getContext();
    if (!context.chatMetadata) return null;

    if (!context.chatMetadata.textme) {
        context.chatMetadata.textme = {
            messages: [],
            schedule: null,
            lastActivity: null,
            autonomousCount: 0,
            scenes: [],
            activeScene: null,
        };
    }
    return context.chatMetadata.textme;
}

/** Save phone data (debounced metadata save) */
export function savePhoneData() {
    const { saveMetadataDebounced } = getContext();
    if (saveMetadataDebounced) {
        saveMetadataDebounced();
    }
}
