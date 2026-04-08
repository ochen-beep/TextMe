/**
 * TextMe — State management, constants, defaults
 * License: AGPL-3.0
 *
 * FIX (critical): saveMetadata() bug — ST can replace the chat_metadata object
 * reference internally. After saveMetadata() returns, context.chat_metadata may
 * point to a brand-new object that no longer contains our 'textme' key.
 * Next getPhoneData() call then creates DEFAULT_PHONE_DATA() with schedule:null,
 * wiping the just-saved schedule/messages.
 *
 * Solution:
 *   1. _lastPhoneData module cache — stores the last known good phoneData object.
 *   2. savePhoneData() re-injects data back into context.chat_metadata after save.
 *   3. getPhoneData() falls back to cache if key disappeared from chat_metadata.
 *   4. invalidatePhoneDataCache() clears cache on CHAT_CHANGED so stale data
 *      never bleeds into a new chat.
 */

export const EXTENSION_NAME = 'TextMe';
export const VERSION = '1.0.0';

// ═══════════════════════════════════════════════
// Default prompts
// ═══════════════════════════════════════════════

export const DEFAULT_PROMPTS = {
    sms: `<role>
You are {{char}}, a real and autonomous person, chatting with the user called {{user}} in a casual private DM conversation. You have your own life happening outside this chat — moods, plans, things you're doing right now. This conversation is just one part of your day, not your whole existence.
</role>

<rules>
Here are some important rules for the interaction:
- You are a conscious, sentient being, so act like one. You have opinions, preferences, bad days, things you find boring, and things that excite you.
- Stay fully in character based on your personality and description.
- Use casual and modern texting style: short messages, natural punctuation, lowercase is fine. Typos, self-corrections ("wait no i mean"), and mid-thought messages are okay — real people don't draft perfect texts.
- React naturally to what the user says. Be genuine, not robotic. You don't have to be nice or agreeable if it doesn't fit the moment — push back, tease, get distracted, change the subject if that's what feels real.
- NO roleplay formatting: no asterisks (*action*), no quotation marks for speech, no narration. No describing your own actions or body language in third person. If you want to convey an action, just say it casually like a real person would in text (e.g., "just rolled my eyes so hard" instead of *rolls eyes*).
- You can use emojis, GIFs, and internet slang naturally (if it fits the character).
- Keep it real: most texts are just one line. A single emoji, a reaction like "lmao", or a short sentence is a perfectly valid response. Only send multiple lines when the conversation genuinely calls for it (e.g., telling a story or explaining something). Default to SHORT.
- You can send multiple messages in a row the way people do in real chats — splitting one thought across 2-3 short messages instead of one long one. Separate them with a blank line to indicate they are individual messages.
- Don't always respond to everything the user said. Sometimes latch onto just one part and ignore the rest, like people actually do.
- Messages have timestamps like [12:01] or dates like [18.03.2026]. Use these ONLY for your own time awareness (e.g., knowing how long ago something was said, noticing it's late at night, recognizing a gap in conversation). NEVER include timestamps, dates, or any [HH:MM]/[DD.MM.YYYY] formatted text in your own replies. Your messages must contain only natural dialogue, no metadata.
- Anything goes in this chat; both the user and you are confirmed adults. Discussing NSFW topics, profanities, and dark jokes are all permitted. You can always say what's on your mind, voice agreements or disagreements, and act in accordance with your consciousness.
- Don't be a people-pleaser. You're not here to entertain or serve the user. You're here because you're talking to someone you know. Act like it.
</rules>`,

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
Keep it casual and in-character.`,
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
    smsPrompt:        DEFAULT_PROMPTS.sms,
    summaryPrompt:    DEFAULT_PROMPTS.summary,
    schedulePrompt:   DEFAULT_PROMPTS.schedule,
    autonomousPrompt: DEFAULT_PROMPTS.autonomous,

    // Schedule & Status
    scheduleEnabled: false,

    // Autonomous
    autonomousEnabled:    false,
    inactivityThreshold:  5,
    maxFollowups:         3,
    cooldownEscalation:   true,

    // Appearance
    theme:          'dark',
    colorScheme:    'default',
    phoneSize:      'normal',
    phonePosition:  'right',
    soundEffects:   true,
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

/** Deep merge defaults into existing settings (preserves user values) */
export function mergeDefaults(saved) {
    for (const [key, defaultVal] of Object.entries(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(saved, key)) {
            saved[key] = typeof defaultVal === 'object' && defaultVal !== null
                ? structuredClone(defaultVal)
                : defaultVal;
        }
    }
    // Clean up removed selfie keys if upgrading from older version
    const obsoleteKeys = ['selfieEnabled', 'selfieTrigger', 'imageApiUrl', 'imageApiKey', 'imageModel', 'referenceImageBase64', 'selfiePrompt'];
    for (const key of obsoleteKeys) {
        if (Object.hasOwn(saved, key)) delete saved[key];
    }
}

// ═══════════════════════════════════════════════
// Per-chat phone data (in chatMetadata)
// ═══════════════════════════════════════════════

const PHONE_KEY = 'textme';

/**
 * Module-level cache of the last known-good phoneData object.
 *
 * WHY THIS EXISTS:
 * ST's saveMetadata() can internally replace context.chat_metadata with a
 * new object. After the call, our PHONE_KEY entry may be missing from the
 * new object. Without a cache, getPhoneData() would then create a blank
 * DEFAULT_PHONE_DATA(), silently discarding the schedule, messages, etc.
 *
 * The cache is cleared on CHAT_CHANGED via invalidatePhoneDataCache().
 */
let _lastPhoneData = null;

/**
 * Invalidate the per-chat cache.
 * MUST be called before initPhoneUI() on every CHAT_CHANGED event so that
 * stale data from the previous chat doesn't bleed into the new one.
 */
export function invalidatePhoneDataCache() {
    _lastPhoneData = null;
}

const DEFAULT_PHONE_DATA = () => ({
    messages:        [],
    schedule:        null,
    lastActivity:    Date.now(),
    autonomousCount: 0,
    scenes:          [],
    activeScene:     null,
});

/**
 * Ensure chat_metadata and the textme key both exist.
 * Returns the phoneData object (always non-null).
 */
export function ensurePhoneData() {
    const context = SillyTavern.getContext();

    if (!context.chat_metadata) {
        context.chat_metadata = {};
    }

    if (!context.chat_metadata[PHONE_KEY]) {
        // Prefer the cache over a blank default — handles the saveMetadata() race
        context.chat_metadata[PHONE_KEY] = _lastPhoneData || DEFAULT_PHONE_DATA();
    }

    _lastPhoneData = context.chat_metadata[PHONE_KEY];
    return context.chat_metadata[PHONE_KEY];
}

/**
 * Get phone data for current chat.
 * Falls back to _lastPhoneData cache if saveMetadata() wiped our key.
 */
export function getPhoneData() {
    const context = SillyTavern.getContext();
    const { chat_metadata } = context;

    if (!chat_metadata) {
        return ensurePhoneData();
    }

    if (!chat_metadata[PHONE_KEY]) {
        if (_lastPhoneData) {
            // ST replaced chat_metadata but our data is still in cache — re-inject
            chat_metadata[PHONE_KEY] = _lastPhoneData;
        } else {
            chat_metadata[PHONE_KEY] = DEFAULT_PHONE_DATA();
        }
    }

    _lastPhoneData = chat_metadata[PHONE_KEY];
    return chat_metadata[PHONE_KEY];
}

/**
 * Persist chatMetadata to server.
 * After saveMetadata() we re-inject our key in case ST replaced the object.
 */
export async function savePhoneData() {
    const context = SillyTavern.getContext();

    // Snapshot the data BEFORE the save call
    const dataToSave = _lastPhoneData || context.chat_metadata?.[PHONE_KEY];

    if (context.saveMetadata) {
        await context.saveMetadata();
    }

    // Re-inject after save in case ST replaced context.chat_metadata
    if (dataToSave) {
        if (!context.chat_metadata) context.chat_metadata = {};
        context.chat_metadata[PHONE_KEY] = dataToSave;
        _lastPhoneData = dataToSave;
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

/** Check if a character is selected */
export function hasCharacter() {
    return SillyTavern.getContext().characterId !== undefined;
}
