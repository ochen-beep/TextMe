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
 *
 * v0.0.3-alpha: Merged autonomousTaskPrompt into autonomousPrompt (Variant A).
 *   The two-field split (Autonomous Prompt + Autonomous Task Prompt) created a
 *   confusing UX where both fields did the same thing via a priority/fallback
 *   chain. Now there is a single "Autonomous Prompt" that is injected as the
 *   <task> block. mergeDefaults() migrates existing saves transparently:
 *   if autonomousTaskPrompt was set (it was the active one per priority rules),
 *   it becomes the new autonomousPrompt, then the old key is deleted.
 */

export const EXTENSION_NAME = 'TextMe';
export const VERSION = '0.0.3-alpha';

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
- Sometimes a message in the conversation history will be preceded by a "> quoted text" line. This means that message is a reply to that quoted text. Use this to understand what the person is specifically reacting to. When YOU want to reply to a specific earlier message (not just the last one), start your response with "> " followed by a short excerpt of the message you're replying to (up to ~10 words), then your actual reply on the next line. Only do this when it genuinely adds clarity — not for every message.
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

    schedule: `Generate a realistic weekly schedule for {{char}}.

IMPORTANT — context priority:
1. If lorebook entries or recent RP events are provided below, treat them as ground truth. Extract concrete facts: what does {{char}} do for work, what are their routines, what happened recently, what mood or situation are they in. Build the schedule around these facts.
2. If no context is provided, fall back to inferring from {{char}}'s personality, occupation, and lifestyle from the character card.
Do NOT invent details that contradict the provided context. Do NOT produce a generic schedule.

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
    { "from": "00:00", "to": "07:00", "status": "offline", "activity": "Sleeping" },
    { "from": "07:00", "to": "09:30", "status": "idle", "activity": "Morning coffee and doomscrolling" },
    { "from": "09:30", "to": "13:00", "status": "dnd", "activity": "Deep work — do not disturb" },
    { "from": "13:00", "to": "14:00", "status": "online", "activity": "Lunch break" },
    { "from": "14:00", "to": "18:00", "status": "dnd", "activity": "Back to work" },
    { "from": "18:00", "to": "21:30", "status": "online", "activity": "Chilling, available to chat" },
    { "from": "21:30", "to": "24:00", "status": "idle", "activity": "Winding down, maybe a drink" }
  ],
  "tuesday": [ ... ],
  ...
}

Field rules:
- from / to: time strings in "HH:MM" format, 00:00–24:00 (24:00 means midnight / end of day)
- Minutes are supported: "09:30", "13:45", "21:15" etc.
- status: "online" = active & chatty | "idle" = distracted/half-present | "dnd" = busy, short replies only | "offline" = unreachable
- activity: a vivid, character-specific description (1 short sentence)
- Blocks must not overlap. Gaps are allowed (missing time = character is online by default)
- Aim for 5–9 blocks per day — realistic, not over-granular

Output ONLY the raw JSON object. No markdown, no code fences, no explanation.`,

    // Single autonomous prompt — injected as <task> block (last = highest model attention).
    // Merged from the old autonomousPrompt + autonomousTaskPrompt split (v0.0.3-alpha).
    // The two-field design was confusing: both fields ended up in the same <task> slot
    // via a priority/fallback chain, so having two UI fields was misleading.
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
    contextMessages: 10,   // recent RP chat messages injected into system prompt (0 = disabled)
    smsHistory: 50,        // recent SMS messages in conversation prompt (0 = all)
    sendOnEnter: true,     // send message on Enter key (Shift+Enter = newline always)

    // Connection profile (issue #13)
    // null = use ST's currently active connection; string = profile ID from connection-manager
    connectionProfileId: null,

    // Prompts
    smsPrompt:        DEFAULT_PROMPTS.sms,
    summaryPrompt:    DEFAULT_PROMPTS.summary,
    schedulePrompt:   DEFAULT_PROMPTS.schedule,
    autonomousPrompt: DEFAULT_PROMPTS.autonomous,

    // Schedule & Status
    scheduleEnabled:        false,
    // Optional context injection for schedule generation
    scheduleIncludeContext: false,  // inject recent RP chat messages into schedule generation prompt
    scheduleIncludeWI:      false,  // inject active lorebook entries into schedule generation prompt

    // Autonomous
    autonomousEnabled:    false,
    // Per-status inactivity thresholds (minutes before first unprompted message)
    autonomousThresholds: {
        online: 5,
        idle:   15,
        dnd:    30,
    },
    maxFollowups:       3,
    cooldownEscalation: true,
    cooldownCap:        120,   // max effective threshold in minutes (prevents infinite escalation)

    // Prompt presets
    promptPresets: {},      // { [name]: { smsPrompt, summaryPrompt, schedulePrompt, autonomousPrompt } }
    activePreset:  null,    // string | null

    // World Info scan
    wiScanSource: 'sms',   // 'sms' | 'rp' | 'both'
    wiScanDepth:  50,       // how many messages to scan (0 = all)

    // Response delay by status (seconds; max=0 means same as min)
    responseDelay: {
        online:  { min: 0,  max: 3  },
        idle:    { min: 30, max: 120 },
        dnd:     { min: 5,  max: 20  },
        // offline never replies — no delay needed
    },

    // RP Injection — inject SMS history into the roleplay chat prompt
    rpInjectEnabled:  false,
    rpInjectMessages: 20,     // how many recent SMS messages to include (0 = all)
    rpInjectDepth:    0,      // injection depth (0 = after last message)
    rpInjectPosition: 1,      // 0 = IN_PROMPT, 1 = IN_CHAT, 2 = BEFORE_PROMPT
    rpInjectRole:     0,      // 0 = SYSTEM, 1 = USER, 2 = ASSISTANT
    // Header injected before the SMS block. Supports {{char}} and {{user}} macros.
    // Empty string = no header, just the raw messages.
    rpInjectHeader: 'The following is a record of recent text messages (SMS) exchanged between {{char}} and {{user}} outside of the current roleplay scene.',

    // Read receipts
    readReceipts: true,     // show "Delivered" / "Read" checkmarks

    // Appearance
    theme:          'dark',
    colorScheme:    'default',
    phoneSize:      'normal',
    phonePosition:  'right',
    soundEffects:   true,
    soundVolume:    70,
    browserNotifications: false,
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
    // Ensure prompt preset fields exist (added in v1.1.0)
    if (!Object.hasOwn(saved, 'promptPresets')) saved.promptPresets = {};
    if (!Object.hasOwn(saved, 'activePreset'))  saved.activePreset  = null;

    // Ensure World Info scan fields exist (added in v1.2.0)
    if (!Object.hasOwn(saved, 'wiScanSource')) saved.wiScanSource = 'sms';
    if (!Object.hasOwn(saved, 'wiScanDepth'))  saved.wiScanDepth  = 50;

    // Ensure schedule context injection fields exist (added in v0.0.4-alpha)
    if (!Object.hasOwn(saved, 'scheduleIncludeContext')) saved.scheduleIncludeContext = false;
    if (!Object.hasOwn(saved, 'scheduleIncludeWI'))      saved.scheduleIncludeWI      = false;

    // Ensure response delay / read receipts fields exist (added in v1.2.0)
    if (!Object.hasOwn(saved, 'responseDelay')) {
        saved.responseDelay = structuredClone(DEFAULT_SETTINGS.responseDelay);
    } else {
        // Patch missing per-status keys without blowing away user values
        for (const st of ['online', 'idle', 'dnd']) {
            if (!saved.responseDelay[st]) {
                saved.responseDelay[st] = structuredClone(DEFAULT_SETTINGS.responseDelay[st]);
            }
        }
    }
    if (!Object.hasOwn(saved, 'readReceipts'))      saved.readReceipts = true;
    // readReceiptsDelay removed in v1.2.1 — clean up if present from older saves
    if (Object.hasOwn(saved, 'readReceiptsDelay'))  delete saved.readReceiptsDelay;

    // Ensure autonomous threshold fields exist (added in v1.3.0)
    if (!Object.hasOwn(saved, 'autonomousThresholds') || typeof saved.autonomousThresholds !== 'object') {
        saved.autonomousThresholds = structuredClone(DEFAULT_SETTINGS.autonomousThresholds);
    } else {
        // Patch missing per-status keys
        for (const st of ['online', 'idle', 'dnd']) {
            if (saved.autonomousThresholds[st] == null) {
                saved.autonomousThresholds[st] = DEFAULT_SETTINGS.autonomousThresholds[st];
            }
        }
        // Migrate old inactivityThreshold → online threshold
        if (Object.hasOwn(saved, 'inactivityThreshold') && typeof saved.inactivityThreshold === 'number') {
            saved.autonomousThresholds.online = saved.inactivityThreshold;
        }
    }
    if (!Object.hasOwn(saved, 'cooldownCap')) saved.cooldownCap = DEFAULT_SETTINGS.cooldownCap;

    // Ensure connectionProfileId exists (added in v1.4.0)
    if (!Object.hasOwn(saved, 'connectionProfileId')) saved.connectionProfileId = null;

    // Ensure RP injection fields exist
    if (!Object.hasOwn(saved, 'rpInjectEnabled'))  saved.rpInjectEnabled  = false;
    if (!Object.hasOwn(saved, 'rpInjectMessages')) saved.rpInjectMessages = 20;
    if (!Object.hasOwn(saved, 'rpInjectDepth'))    saved.rpInjectDepth    = 0;
    if (!Object.hasOwn(saved, 'rpInjectPosition')) saved.rpInjectPosition = 1;
    if (!Object.hasOwn(saved, 'rpInjectRole'))     saved.rpInjectRole     = 0;
    if (!Object.hasOwn(saved, 'rpInjectHeader'))   saved.rpInjectHeader   = DEFAULT_SETTINGS.rpInjectHeader;

    // ── v0.0.3-alpha migration: merge autonomousTaskPrompt → autonomousPrompt ──
    // The old two-field design had autonomousTaskPrompt take PRIORITY over autonomousPrompt
    // when both were set. So if the user had a non-empty autonomousTaskPrompt, that was
    // the actual active prompt — we must keep it, not discard it.
    if (Object.hasOwn(saved, 'autonomousTaskPrompt')) {
        const task = saved.autonomousTaskPrompt;
        if (task && task.trim()) {
            // autonomousTaskPrompt was the active one — promote it
            saved.autonomousPrompt = task;
        }
        // Whether it was empty or not, delete the now-obsolete key
        delete saved.autonomousTaskPrompt;
    }

    // Also migrate autonomousTaskPrompt out of any saved presets
    if (saved.promptPresets && typeof saved.promptPresets === 'object') {
        for (const preset of Object.values(saved.promptPresets)) {
            if (preset && typeof preset === 'object' && Object.hasOwn(preset, 'autonomousTaskPrompt')) {
                const task = preset.autonomousTaskPrompt;
                if (task && task.trim()) {
                    preset.autonomousPrompt = task;
                }
                delete preset.autonomousTaskPrompt;
            }
        }
    }

    // Clean up removed keys
    const obsoleteKeys = [
        'selfieEnabled', 'selfieTrigger', 'imageApiUrl', 'imageApiKey',
        'imageModel', 'referenceImageBase64', 'selfiePrompt',
        'temperature', 'inactivityThreshold',
        'autonomousTaskPrompt', // merged into autonomousPrompt in v0.0.3-alpha
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
    // Autonomous wait snapshot (v1.3.0)
    autonomousWaitThreshold: null,  // ms — threshold locked in at start of current wait
    autonomousWaitSince:     null,  // timestamp when wait snapshot was recorded
    autonomousErrorBackoff:  null,  // timestamp until which retries are suppressed after error
    scenes:          [],
    activeScene:     null,
});

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

    // Migrate old data: ensure new fields exist
    if (!Object.hasOwn(data, 'scheduleBlocks'))          data.scheduleBlocks          = null;
    if (!Object.hasOwn(data, 'manualStatus'))            data.manualStatus            = null;
    if (!Object.hasOwn(data, 'autonomousWaitThreshold')) data.autonomousWaitThreshold = null;
    if (!Object.hasOwn(data, 'autonomousWaitSince'))     data.autonomousWaitSince     = null;
    if (!Object.hasOwn(data, 'autonomousErrorBackoff'))  data.autonomousErrorBackoff  = null;

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

    // Migrate old data: ensure new fields exist
    if (!Object.hasOwn(data, 'scheduleBlocks'))          data.scheduleBlocks          = null;
    if (!Object.hasOwn(data, 'manualStatus'))            data.manualStatus            = null;
    if (!Object.hasOwn(data, 'autonomousWaitThreshold')) data.autonomousWaitThreshold = null;
    if (!Object.hasOwn(data, 'autonomousWaitSince'))     data.autonomousWaitSince     = null;
    if (!Object.hasOwn(data, 'autonomousErrorBackoff'))  data.autonomousErrorBackoff  = null;

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
