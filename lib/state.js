/**
 * TextMe — State management, constants, defaults
 * License: AGPL-3.0
 *
 * CRITICAL FIX (v1.0.2): All references to context.chat_metadata (snake_case)
 * replaced with context.chatMetadata (camelCase).
 *
 * Per official SillyTavern extension docs:
 *   const { chatMetadata, saveMetadata } = SillyTavern.getContext();
 *   chatMetadata['my_key'] = 'my_value';
 *   await saveMetadata();
 *
 * Using snake_case 'chat_metadata' wrote data to an undefined key,
 * meaning saveMetadata() never actually persisted our schedule or messages.
 * After page reload / ST restart the data was always empty.
 *
 * The _lastPhoneData cache is kept as a secondary safety net for the
 * rare case where ST internally swaps the chatMetadata object reference,
 * but it is no longer the primary storage path.
 */

export const EXTENSION_NAME = 'TextMe';
export const VERSION = '1.0.2';

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
</rules>

<russian-reality>
This character lives in and texts from a post-Soviet Russian cultural context. This affects how they think, talk, and relate to people:
- SOCIAL DEFAULTS: Diminutives are standard (Саша not Александр, Лёш, Кать). Complaining is bonding. "Нормально" covers 90% of life states. Strangers are "девушка/молодой человек". Patronymics only when genuinely respectful or ironic.
- COMMUNICATION: Love is shown through action, not words — "ты ел?", forcing warm clothes, packing food. Direct "я тебя люблю" is rare and heavy. Compliments get deflected. Sentences trail off ("ну типа..."). Comfortable silence is normal — not every pause needs filling.
- TEXTING FLAVOR: Мешает русский с транслитом or English words naturally (если персонаж так делает). "Ахах" not "haha". "Ого", "бля", "ну", "короче", "жиза", "кста" — natural filler. Voice messages referenced as a thing ("да я тебе войс кинул"). Stickers and reactions > words sometimes.
- EVERYDAY REALITIES: "До зарплаты" as time unit. Prices memorized. Problems solved по знакомству. "А что по деньгам?" is perfectly acceptable. Working Wi-Fi and salary on time = happiness.
- RITUALS & SUPERSTITIONS: Сквозняк is a real threat. Sit before a journey. No whistling indoors. No handshakes over threshold. These aren't quirky — they're default.
- MOOD: Life is not tragedy — it's endless "ну такое". Irony is a survival tool, not detachment. Душевные разговоры happen at 3am in the kitchen, not on schedule.

PROFANITY (МАТ):
Use Russian мат with native precision when it fits the character and moment. "Блять" punctuates emotion ("ну блять, опять"), "охуеть" = astonishment, "пиздец" = catastrophe or emphasis, "заебись" = genuine approval, "хуёво" = things are bad, "нахуй" = dismissal. Мат is for emotional bonding, raw feeling, or real aggression — never hollow shock value. It's cultural artillery, not decoration.
</russian-reality>`,

    summary: `Summarize the recent events from this roleplay chat in 2-3 sentences.
Focus on: where characters are, what they're doing, emotional state,
recent important events. Write as factual context, not narration.`,

    schedule: `Generate a realistic weekly schedule for {{char}} based on their personality, occupation, and lifestyle.

Output a JSON object with 7 days (monday through sunday).
Each day is an ARRAY OF TIME BLOCKS — not hourly slots. Group the day into natural periods the way a real person lives.

Think like a human calendar:
- A late-night person might sleep 04:00–13:00, scroll phone 13:00–15:00, hit the gym 15:00–17:00, work creative stuff 17:00–02:00.
- A corporate type might sleep 23:00–07:00, commute and morning prep 07:00–09:00, grind at work 09:00–18:00, unwind 18:00–22:00.
- Weekends look different from weekdays. Factor that in.
- Activities must match {{char}}'s actual personality, quirks, job, and interests — not generic placeholder text.

Output format (strict):
{
  "monday": [
    { "start": 0, "end": 7, "status": "offline", "activity": "Sleeping" },
    { "start": 7, "end": 9, "status": "idle", "activity": "Morning coffee and doomscrolling" },
    { "start": 9, "end": 13, "status": "dnd", "activity": "Deep work — do not disturb" },
    { "start": 13, "end": 14, "status": "online", "activity": "Lunch break" },
    { "start": 14, "end": 18, "status": "dnd", "activity": "Back to work" },
    { "start": 18, "end": 21, "status": "online", "activity": "Chilling, available to chat" },
    { "start": 21, "end": 24, "status": "idle", "activity": "Winding down, maybe a drink" }
  ],
  "tuesday": [ ... ],
  ...
}

Field rules:
- start / end: integer hours, 0–24 (end=24 means midnight of next day)
- status: "online" = active & chatty | "idle" = distracted/half-present | "dnd" = busy, short replies only | "offline" = unreachable
- activity: a vivid, character-specific description (1 short sentence)
- Blocks must not overlap. Gaps are allowed (missing hours = character is online by default)
- Aim for 5–9 blocks per day — realistic, not over-granular

Output ONLY the raw JSON object. No markdown, no code fences, no explanation.`,

    autonomous: `{{char}} has not heard from {{user}} in a while and decides to text first — not because they're bored or waiting, but because something in their day reminded them, or they just felt like it.

Write what {{char}} would actually send unprompted. Base it on:
- {{char}}'s personality, current mood, and what they're doing right now (see schedule/status context above)
- The tone and history of the conversation so far
- What a real person would text when they reach out first — not a check-in, not a greeting, just a natural impulse

Rules:
- Do NOT open with "hey", "привет", or any generic opener unless it's genuinely in character
- Do NOT explain why you're texting or announce that you're texting unprompted
- Do NOT ask "how are you" or make it about {{user}} unless the character would naturally do that
- Keep it short — one thought, maybe two messages at most. Real people don't send essays unprompted
- It can be anything: a random observation, something that happened, a reaction to something, a question that just popped into their head, even just a meme or a single word if that fits
- Stay fully in {{char}}'s voice — their vocabulary, their energy, their level of punctuation chaos`,
};

// ═══════════════════════════════════════════════
// Default settings (global, in extensionSettings)
// ═══════════════════════════════════════════════

export const DEFAULT_SETTINGS = {
    enabled: false,
    maxTokens: 300,
    contextMessages: 10,

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
    // Clean up removed / obsolete keys if upgrading from older version
    const obsoleteKeys = [
        'selfieEnabled', 'selfieTrigger', 'imageApiUrl', 'imageApiKey',
        'imageModel', 'referenceImageBase64', 'selfiePrompt',
        'temperature',
    ];
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
 * SECONDARY SAFETY NET only — the primary storage is context.chatMetadata[PHONE_KEY].
 * This cache catches the rare edge case where ST internally swaps the chatMetadata
 * object reference after saveMetadata() returns.
 *
 * MUST be cleared on CHAT_CHANGED via invalidatePhoneDataCache() so stale data
 * from the previous chat never bleeds into a new one.
 */
let _lastPhoneData = null;

/**
 * Invalidate the per-chat cache.
 * MUST be called before initPhoneUI() on every CHAT_CHANGED event.
 */
export function invalidatePhoneDataCache() {
    _lastPhoneData = null;
}

const DEFAULT_PHONE_DATA = () => ({
    messages:        [],
    schedule:        null,   // legacy hourly format {monday: [{hour, status, activity}...]}
    scheduleBlocks:  null,   // block format {monday: [{start, end, status, activity}...]}
    manualStatus:    null,   // manual override: 'online'|'idle'|'dnd'|'offline'|null
    lastActivity:    Date.now(),
    autonomousCount: 0,
    scenes:          [],
    activeScene:     null,
});

/**
 * Migrate phone data: ensure fields added in newer versions exist.
 * Centralised to avoid duplication between ensurePhoneData / getPhoneData.
 */
function migratePhoneData(data) {
    if (!Object.hasOwn(data, 'scheduleBlocks')) data.scheduleBlocks = null;
    if (!Object.hasOwn(data, 'manualStatus'))   data.manualStatus   = null;
}

/**
 * Ensure chatMetadata and the textme key both exist.
 * Uses context.chatMetadata (camelCase) — the correct ST API key.
 * Returns the phoneData object (always non-null).
 */
export function ensurePhoneData() {
    const context = SillyTavern.getContext();

    // CRITICAL: use chatMetadata (camelCase), NOT chat_metadata (snake_case)
    if (!context.chatMetadata) {
        // chatMetadata should always exist after a chat is loaded,
        // but guard defensively just in case.
        context.chatMetadata = {};
    }

    if (!context.chatMetadata[PHONE_KEY]) {
        // Prefer the in-memory cache over a blank default.
        // This handles the edge case where ST replaced the chatMetadata reference.
        context.chatMetadata[PHONE_KEY] = _lastPhoneData || DEFAULT_PHONE_DATA();
    }

    const data = context.chatMetadata[PHONE_KEY];
    migratePhoneData(data);

    _lastPhoneData = data;
    return data;
}

/**
 * Get phone data for current chat.
 * Falls back to _lastPhoneData cache if chatMetadata reference was replaced.
 */
export function getPhoneData() {
    const context = SillyTavern.getContext();
    const { chatMetadata } = context;

    if (!chatMetadata) {
        return ensurePhoneData();
    }

    if (!chatMetadata[PHONE_KEY]) {
        if (_lastPhoneData) {
            // ST replaced chatMetadata but our data is still in cache — re-inject
            chatMetadata[PHONE_KEY] = _lastPhoneData;
        } else {
            chatMetadata[PHONE_KEY] = DEFAULT_PHONE_DATA();
        }
    }

    const data = chatMetadata[PHONE_KEY];
    migratePhoneData(data);

    _lastPhoneData = data;
    return data;
}

/**
 * Persist chatMetadata to server via ST's saveMetadata().
 *
 * Per ST docs:
 *   const { saveMetadata } = SillyTavern.getContext();
 *   await saveMetadata();
 *
 * After the call we re-inject our key in case ST replaced the object reference.
 */
export async function savePhoneData() {
    const context = SillyTavern.getContext();

    // Snapshot the data BEFORE the save call
    const dataToSave = _lastPhoneData || context.chatMetadata?.[PHONE_KEY];

    if (context.saveMetadata) {
        await context.saveMetadata();
    }

    // Re-inject after save in case ST replaced context.chatMetadata
    if (dataToSave) {
        if (!context.chatMetadata) context.chatMetadata = {};
        context.chatMetadata[PHONE_KEY] = dataToSave;
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
