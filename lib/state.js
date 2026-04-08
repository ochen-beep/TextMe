/**
 * TextMe — State management, constants, defaults
 * License: AGPL-3.0
 */

export const EXTENSION_NAME = 'TextMe';

// ═══════════════════════════════════════════════
// Default prompts
// ═══════════════════════════════════════════════

export const DEFAULT_PROMPTS = {
    sms: `You are {{char}}, texting with {{user}} on a phone.
Write short, casual text messages. Use emojis occasionally.
Do NOT write actions, narration, or prose — only text messages.
Keep messages brief (1-3 sentences usually).
Stay in character based on your personality and current context.`,

    selfie: `Based on the current conversation, describe a selfie that {{char}} would take right now.

Output ONLY a JSON object:
{
  "prompt": "200-320 word description. Phone selfie feel, not studio. Include: CAMERA (shot type, angle, phone selfie front camera feel), SUBJECT (face details, hair, clothing, expression, natural skin texture), ENVIRONMENT (specific place, props, background blur), LIGHT & COLOR (light source, color grade, phone camera texture).",
  "style": "[light source], [phone camera feel], [color temperature]",
  "aspect_ratio": "1:1",
  "references": ["char"]
}`,

    summary: `Summarize the recent events from this roleplay chat in 2-3 sentences.
Focus on: where characters are, what they're doing, emotional state,
recent important events. Write as factual context, not narration.`,

    schedule: `Generate a weekly schedule for {{char}} as a JSON object.
Each day has 24 hourly slots. Each slot has "status" (online/idle/dnd/offline) and "activity" (brief description).
Base the schedule on {{char}}'s personality, occupation, and lifestyle.
Output format: { "monday": [{ "hour": 0, "status": "offline", "activity": "Sleeping" }, ...], ... }`,

    autonomous: `{{char}} decides to text {{user}} unprompted.
Based on {{char}}'s personality, current activity, and recent conversation,
write a natural text message that {{char}} would send on their own.
Keep it casual and in-character. 1-2 sentences.`,
};

// ═══════════════════════════════════════════════
// Default settings (global, in extensionSettings)
// ═══════════════════════════════════════════════

export const DEFAULT_SETTINGS = {
    enabled: false,
    maxTokens: 300,
    contextMessages: 10,
    temperature: 1.0,

    // Prompts
    smsPrompt: DEFAULT_PROMPTS.sms,
    selfiePrompt: DEFAULT_PROMPTS.selfie,
    summaryPrompt: DEFAULT_PROMPTS.summary,
    schedulePrompt: DEFAULT_PROMPTS.schedule,
    autonomousPrompt: DEFAULT_PROMPTS.autonomous,

    // Selfie
    selfieEnabled: false,
    selfieTrigger: 'manual',
    imageApiUrl: '',
    imageApiKey: '',
    imageModel: '',
    referenceImageBase64: null,

    // Schedule & Status
    scheduleEnabled: false,

    // Autonomous
    autonomousEnabled: false,
    inactivityThreshold: 5,
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
// Settings getters/setters
// ═══════════════════════════════════════════════

/** Get global extension settings */
export function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[EXTENSION_NAME]) {
        extensionSettings[EXTENSION_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    return extensionSettings[EXTENSION_NAME];
}

/** Update a single setting key */
export function updateSetting(key, value) {
    const settings = getSettings();
    settings[key] = value;
}

// ═══════════════════════════════════════════════
// Per-chat phone data (in chatMetadata)
// ═══════════════════════════════════════════════

const PHONE_KEY = 'textme';

/**
 * Get phone data for current chat.
 * Always re-reads from context to handle chat switches.
 * @returns {object|null}
 */
export function getPhoneData() {
    const { chatMetadata } = SillyTavern.getContext();
    if (!chatMetadata) return null;

    if (!chatMetadata[PHONE_KEY]) {
        chatMetadata[PHONE_KEY] = {
            messages: [],
            schedule: null,
            lastActivity: null,
            autonomousCount: 0,
            scenes: [],
            activeScene: null,
        };
    }
    return chatMetadata[PHONE_KEY];
}

/** Persist chatMetadata to server */
export async function savePhoneData() {
    const context = SillyTavern.getContext();
    if (context.saveMetadata) {
        await context.saveMetadata();
    }
}

// ═══════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════

/** Get character name */
export function getCharName() {
    const ctx = SillyTavern.getContext();
    if (ctx.characterId === undefined) return 'Character';
    return ctx.characters[ctx.characterId]?.name || ctx.name2 || 'Character';
}

/** Get user name */
export function getUserName() {
    return SillyTavern.getContext().name1 || 'User';
}
