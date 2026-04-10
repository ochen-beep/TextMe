/**
 * TextMe — Prompt assembly & generation engine
 * License: AGPL-3.0
 *
 * FIX: buildConversationText() no longer takes a userMessage parameter.
 *      The user message is always already in phoneData.messages by the
 *      time this function is called, so passing it again caused every
 *      user message to appear twice in the prompt.
 *
 * FIX: World Info now receives chat.map(m => m.mes || '') instead of the
 *      raw context.chat array of objects — ST's getWorldInfoPrompt()
 *      expects strings, not message objects.
 *
 * FIX: stripSpeakerPrefix() now also matches the first token of charName
 *      (e.g. "CRISPIN™") so short model-generated prefixes are stripped
 *      even when charName is a long display string.
 *
 * FIX: splitResponseIntoMessages() Step 2 (single-\n expansion) is now
 *      applied to EVERY part produced by Step 1, not only when Step 1
 *      returned exactly one part.
 *
 * FIX: generatePhoneResponse() and generateAutonomousMessage() now accept
 *      an optional AbortSignal and forward it to generateRaw() so that
 *      TextMe's own generation can be cancelled independently from the
 *      ST main-chat Stop button.
 *
 * v1.3.0: Prompt restructured into explicit XML blocks for cleaner model parsing:
 *   <role>        — smsPrompt (rules, persona, texting style)
 *   <character>   — char description / personality / scenario + user persona
 *   <world>       — World Info / lorebook + story summary / memories
 *   <context>     — recent RP events + current time + schedule/status
 *   <task>        — autonomous-only: autonomousTaskPrompt (appended last)
 *
 *   For autonomous generation, a <task> block is appended after <context>
 *   using a dedicated autonomousTaskPrompt setting. This replaces the old
 *   flat string concatenation (systemPrompt + '\n\n' + autonomousPrompt).
 *
 * v1.4.0: Connection profile support (issue #13).
 *   When settings.connectionProfileId is set, generation goes through
 *   ConnectionManagerRequestService.sendRequest() instead of generateRaw().
 *   Falls back to generateRaw() if Connection Manager is unavailable or
 *   the profile is not found.
 */

import { getSettings, getPhoneData, savePhoneData, getCharName, getUserName } from './state.js';
import { getScheduleContext } from './schedule.js';
import { getCurrentTime } from './custom-time.js';
import { log } from './logger.js';

// ─────────────────────────────────────────────────────────
// Prompt assembly helpers
// ─────────────────────────────────────────────────────────

/** Wrap content in an XML block, trimming whitespace. Returns '' if content is empty. */
function block(tag, content) {
    const trimmed = (content || '').trim();
    if (!trimmed) return '';
    return `<${tag}>\n${trimmed}\n</${tag}>`;
}

// ─────────────────────────────────────────────────────────
// assembleSystemPrompt
// ─────────────────────────────────────────────────────────

/**
 * Assemble the system prompt from ST context (read-only).
 *
 * @param {{ task?: string }} [opts]
 *   task — if provided, appended as a <task> block after <context>.
 *          Used for autonomous messages.
 * @returns {Promise<string>}
 */
async function assembleSystemPrompt({ task } = {}) {
    const context  = SillyTavern.getContext();
    const settings = getSettings();
    const sub      = context.substituteParams || ((s) => s);

    const blocks = [];

    // ── Block 1: <role> ────────────────────────────────────────────────────
    // smsPrompt: texting rules, persona, cultural context, format rules.
    blocks.push(block('role', sub(settings.smsPrompt)));

    // ── Block 2: <character> ──────────────────────────────────────────────
    // Char card fields + user persona.
    try {
        const parts = [];

        // Character card
        if (typeof context.getCharacterCardFields === 'function') {
            const fields = context.getCharacterCardFields();
            if (fields.description)  parts.push(`Description: ${fields.description}`);
            if (fields.personality)  parts.push(`Personality: ${fields.personality}`);
            if (fields.scenario)     parts.push(`Scenario: ${fields.scenario}`);
            if (fields.mes_example)  parts.push(`Example dialogue:\n${fields.mes_example}`);
        } else {
            const char = context.characters?.[context.characterId];
            if (char) {
                if (char.description) parts.push(`Description: ${char.description}`);
                if (char.personality) parts.push(`Personality: ${char.personality}`);
                if (char.scenario)    parts.push(`Scenario: ${char.scenario}`);
            }
        }

        // User persona
        const userName = context.name1 || '';
        const userDesc = context.powerUserSettings?.persona_description || '';
        if (userName || userDesc) {
            parts.push(`[User]\nName: ${userName}${userDesc ? `\nDescription: ${userDesc}` : ''}`);
        }

        blocks.push(block('character', parts.join('\n\n')));
    } catch (e) {
        log.warn('Could not get character card:', e);
    }

    // ── Block 3: <world> ──────────────────────────────────────────────────
    // World Info / lorebook entries + story summary from Summarize extension.
    try {
        const worldParts = [];

        // 3a. World Info / Lorebooks (async)
        if (typeof context.getWorldInfoPrompt === 'function') {
            const phoneData = getPhoneData();
            const wiSource  = settings.wiScanSource || 'sms';
            const wiDepth   = settings.wiScanDepth  ?? 50;
            const charName  = getCharName();
            const userName  = getUserName();

            // Build scan buffer
            const smsScanLines = [];
            if (wiSource === 'sms' || wiSource === 'both') {
                const smsMessages = phoneData?.messages ?? [];
                const sliced = wiDepth > 0 ? smsMessages.slice(-wiDepth) : smsMessages;
                for (const m of sliced) {
                    if (m.type === 'image' || !m.text) continue;
                    smsScanLines.push(`${m.isUser ? userName : charName}: ${m.text}`);
                }
            }

            const rpScanLines = [];
            if (wiSource === 'rp' || wiSource === 'both') {
                const rpChat = context.chat ?? [];
                const sliced = wiDepth > 0 ? rpChat.slice(-wiDepth) : rpChat;
                for (const m of sliced) {
                    if (m.is_system || !m.mes) continue;
                    rpScanLines.push(`${m.name}: ${m.mes}`);
                }
            }

            const chatForWI = [...smsScanLines, ...rpScanLines].reverse();

            if (chatForWI.length === 0 && wiSource !== 'both') {
                log.debug(`World Info: scan buffer empty (source=${wiSource})`);
            }

            const maxContext = context.max_context || 4096;
            const result     = await context.getWorldInfoPrompt(chatForWI, maxContext, true);
            let wiText = result?.worldInfoString || (typeof result === 'string' ? result : '');

            // Fallback: activated entries from the session
            if (!wiText && context.activatedWorldInfo?.length > 0) {
                wiText = context.activatedWorldInfo
                    .filter(e => e?.content)
                    .map(e => e.content)
                    .join('\n\n');
                log.debug('World Info: using activatedWorldInfo fallback, entries:', context.activatedWorldInfo.length);
            }

            if (wiText?.trim()) {
                worldParts.push(wiText.trim());
                log.debug(`World Info injected (source=${wiSource}, depth=${wiDepth || 'all'}, bufLen=${chatForWI.length}), textLen:`, wiText.length);
            }
        }

        // 3b. Story summary from Summarize extension (read-only passive)
        const chat = context.chat;
        if (chat?.length > 0) {
            for (let i = chat.length - 1; i >= 0; i--) {
                if (chat[i].extra?.memory) {
                    worldParts.push(`[Story Summary]\n${chat[i].extra.memory}`);
                    break;
                }
            }
        }

        blocks.push(block('world', worldParts.join('\n\n')));
    } catch (e) {
        log.warn('Could not assemble world block:', e);
    }

    // ── Block 4: <context> ────────────────────────────────────────────────
    // Current time, schedule/status, recent RP events.
    try {
        const ctxParts = [];

        // 4a. Current time
        const now     = getCurrentTime();
        const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const dateStr = now.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
        const dayStr  = now.toLocaleDateString([], { weekday: 'long' });
        ctxParts.push(`Current time: [${timeStr}], ${dayStr}, ${dateStr}.`);

        // 4b. Schedule / Status context
        const schedCtx = getScheduleContext();
        if (schedCtx?.trim()) ctxParts.push(schedCtx.trim());

        // 4c. Recent RP events
        const chat  = context.chat;
        const limit = settings.contextMessages || 10;
        if (chat?.length > 0 && limit > 0) {
            const recent = chat
                .filter(m => !m.is_system)
                .slice(-limit)
                .map(m => `${m.name}: ${m.mes}`)
                .join('\n');
            if (recent) {
                ctxParts.push(`[Recent RP Events — for context only, do NOT continue the roleplay]\n${recent}`);
            }
        }

        blocks.push(block('context', ctxParts.join('\n\n')));
    } catch (e) {
        log.warn('Could not assemble context block:', e);
    }

    // ── Block 5: <task> (optional) ────────────────────────────────────────
    // Appended last — for autonomous messages only.
    // Placing it last gives it highest recency weight in the model's attention.
    if (task?.trim()) {
        blocks.push(block('task', task.trim()));
    }

    return blocks.filter(Boolean).join('\n\n');
}

// ─────────────────────────────────────────────────────────
// Conversation text
// ─────────────────────────────────────────────────────────

/**
 * Build the conversation text from phone history.
 * This is the "user turn" / prompt sent to generateRaw().
 * @returns {string}
 */
function buildConversationText() {
    const phoneData = getPhoneData();
    const settings  = getSettings();
    const charName  = getCharName();
    const userName  = getUserName();

    const lines = [];

    if (phoneData && phoneData.messages.length > 0) {
        const limit = settings.smsHistory ?? 50;
        const msgs  = limit > 0 ? phoneData.messages.slice(-limit) : phoneData.messages.slice();
        let lastDay = '';

        for (const msg of msgs) {
            if (msg.type === 'image') continue;

            if (msg.time) {
                const d   = new Date(msg.time);
                const day = d.toDateString();

                // Insert a date separator when the day changes
                if (day !== lastDay) {
                    const dateLabel = d.toLocaleDateString('ru-RU', {
                        day: '2-digit', month: '2-digit', year: 'numeric',
                    });
                    lines.push(`--- ${dateLabel} ---`);
                    lastDay = day;
                }

                const ts     = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                const sender = msg.isUser ? userName : charName;
                lines.push(`[${ts}] ${sender}: ${msg.text}`);
            } else {
                const sender = msg.isUser ? userName : charName;
                lines.push(`${sender}: ${msg.text}`);
            }
        }
    }

    // End with character name to prime the response
    lines.push(`${charName}:`);

    return lines.join('\n');
}

// ─────────────────────────────────────────────────────────
// Response parsing
// ─────────────────────────────────────────────────────────

/**
 * Strip a "Speaker: " prefix from a single text part.
 */
function stripSpeakerPrefix(part, charName) {
    const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const fullEscaped  = escapeRe(charName);
    const firstWordMatch = charName.match(/^[\w™®©]+/);
    const firstToken   = firstWordMatch ? firstWordMatch[0] : null;
    const firstEscaped = firstToken ? escapeRe(firstToken) : null;

    const alts = [fullEscaped];
    if (firstEscaped && firstEscaped !== fullEscaped) {
        alts.push(firstEscaped + '™?');
    }
    alts.push('\\{\\{char\\}\\}');

    const pattern = new RegExp(
        `^(?:${alts.join('|')})\\s*[:—–-]\\s*`,
        'i'
    );
    return part.replace(pattern, '').trim();
}

/**
 * Split a response into individual messages.
 */
export function splitResponseIntoMessages(text) {
    if (!text) return [];

    const charName = getCharName();
    let cleaned = text.trim();

    // Strip timestamp prefixes the model might have added
    cleaned = cleaned.replace(/^\[\d{1,2}:\d{2}\]\s*/gm, '');

    // Step 1: split by double newline
    let parts = cleaned.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0);

    // Step 2: for EVERY part, expand single-\n lines into separate bubbles
    const expanded = [];
    for (const part of parts) {
        if (part.includes('\n')) {
            const lines = part.split('\n').map(l => l.trim()).filter(l => l.length > 0);
            if (lines.length > 1 && lines.every(l => l.length <= 180)) {
                expanded.push(...lines);
                continue;
            }
        }
        expanded.push(part);
    }
    parts = expanded;

    // Step 3: strip "CharName:" prefix from EVERY part
    parts = parts
        .map(p => stripSpeakerPrefix(p, charName))
        .filter(p => p.length > 0);

    return parts.length > 0 ? parts : (cleaned ? [cleaned] : []);
}

// ─────────────────────────────────────────────────────────
// Generation helpers
// ─────────────────────────────────────────────────────────

/**
 * Resolve which connection profile to use and return its ID + display name.
 * Returns null if no profile is configured or Connection Manager is unavailable.
 *
 * @returns {{ id: string, name: string } | null}
 */
function resolveConnectionProfile() {
    const settings = getSettings();
    const profileId = settings.connectionProfileId;
    if (!profileId) return null;

    try {
        const context = SillyTavern.getContext();
        // Connection Manager stores profiles in extensionSettings.connectionManager
        if (context.extensionSettings?.disabledExtensions?.includes('connection-manager')) {
            log.warn('Connection profile selected but Connection Manager is disabled — falling back to default API.');
            return null;
        }
        const profiles = context.extensionSettings?.connectionManager?.profiles;
        if (!Array.isArray(profiles)) {
            log.warn('Connection Manager profiles not available — falling back to default API.');
            return null;
        }
        const profile = profiles.find(p => p.id === profileId);
        if (!profile) {
            log.warn(`Connection profile ID "${profileId}" not found — falling back to default API.`);
            return null;
        }
        return { id: profile.id, name: profile.name };
    } catch (e) {
        log.warn('Could not resolve connection profile:', e);
        return null;
    }
}

/**
 * Run generation — either via Connection Manager profile or the default generateRaw().
 *
 * @param {{ systemPrompt: string, conversationText: string, maxTokens: number, signal?: AbortSignal }} params
 * @returns {Promise<string>}
 */
async function runGeneration({ systemPrompt, conversationText, maxTokens, signal }) {
    const context = SillyTavern.getContext();
    const profile = resolveConnectionProfile();

    if (profile) {
        // ── Connection Manager path ────────────────────────────────────────
        log.info(`Sending prompt via connection profile: "${profile.name}" (${profile.id})`);

        // ConnectionManagerRequestService is exported from ST's shared.js.
        // It is available on the page as part of ST's global module system.
        // We access it via the dynamic import path that ST itself uses.
        const { ConnectionManagerRequestService } = await import('/scripts/extensions/shared.js');

        // Build a messages array: system + user turn (chat completion style)
        const messages = [
            { role: 'system',    content: systemPrompt    },
            { role: 'user',      content: conversationText },
        ];

        const result = await ConnectionManagerRequestService.sendRequest(
            profile.id,
            messages,
            maxTokens,
            { stream: false, signal, extractData: true, includePreset: true, includeInstruct: false },
        );

        // sendRequest returns the extracted text string when extractData=true
        return typeof result === 'string' ? result : (result?.choices?.[0]?.message?.content ?? '');
    }

    // ── Default generateRaw() path ─────────────────────────────────────────
    const { generateRaw } = context;
    if (!generateRaw) {
        throw new Error('generateRaw not available. Update SillyTavern to the latest version.');
    }

    log.info('Sending prompt via default ST connection (no profile selected).');

    const result = await generateRaw({
        prompt:         conversationText,
        systemPrompt:   systemPrompt,
        max_new_tokens: maxTokens,
        ...(signal ? { signal } : {}),
    });

    return typeof result === 'string' ? result : '';
}

// ─────────────────────────────────────────────────────────
// Generation entry points
// ─────────────────────────────────────────────────────────

/**
 * Generate a phone response from the character.
 *
 * @param {AbortSignal} [signal]
 * @returns {Promise<string[]>}
 */
export async function generatePhoneResponse(signal) {
    const settings = getSettings();

    const systemPrompt     = await assembleSystemPrompt();
    const conversationText = buildConversationText();
    const maxTokens        = settings.maxTokens || 300;

    log.info('Generating phone response...');
    log.debug('System prompt length:', systemPrompt.length);
    log.debug('Conversation text length:', conversationText.length);
    log.debug('System prompt (first 500):', systemPrompt.substring(0, 500));
    log.debug('Conversation prompt (first 500):', conversationText.substring(0, 500));

    // Log which profile is being used
    const profile = resolveConnectionProfile();
    if (profile) {
        log.info(`[Profile] Using connection profile: "${profile.name}" (id: ${profile.id})`);
    } else {
        log.info('[Profile] Using default ST connection (no profile configured).');
    }

    const replyText = (await runGeneration({ systemPrompt, conversationText, maxTokens, signal })).trim();

    if (!replyText) {
        throw new Error('Empty response from API');
    }

    log.debug('Raw API response (first 500):', replyText.substring(0, 500));
    log.info('Response received, length:', replyText.length);
    return splitResponseIntoMessages(replyText);
}

/**
 * Generate an autonomous (unprompted) message.
 *
 * The autonomousTaskPrompt is injected as the final <task> block in the system
 * prompt, giving it maximum recency weight. The conversation history remains in
 * the conversation prompt (user turn) as usual.
 *
 * @param {AbortSignal} [signal]
 * @returns {Promise<string[]>}
 */
export async function generateAutonomousMessage(signal) {
    const context  = SillyTavern.getContext();
    const settings = getSettings();
    const sub      = context.substituteParams || ((s) => s);

    // Use autonomousTaskPrompt as the <task> block.
    // Fall back to the old autonomousPrompt if the new key isn't set yet.
    const taskPrompt = sub(settings.autonomousTaskPrompt || settings.autonomousPrompt || '');

    const systemPrompt     = await assembleSystemPrompt({ task: taskPrompt });
    const conversationText = buildConversationText();
    const maxTokens        = settings.maxTokens || 300;

    log.info('Generating autonomous message...');
    log.debug('Autonomous system prompt length:', systemPrompt.length);
    log.debug('Autonomous system prompt (first 500):', systemPrompt.substring(0, 500));
    log.debug('Autonomous conversation (first 300):', conversationText.substring(0, 300));

    // Log which profile is being used
    const profile = resolveConnectionProfile();
    if (profile) {
        log.info(`[Profile] Autonomous: using connection profile: "${profile.name}" (id: ${profile.id})`);
    } else {
        log.info('[Profile] Autonomous: using default ST connection.');
    }

    const replyText = (await runGeneration({ systemPrompt, conversationText, maxTokens, signal })).trim();

    if (!replyText) throw new Error('Empty autonomous response');

    log.debug('Autonomous raw response (first 500):', replyText.substring(0, 500));

    return splitResponseIntoMessages(replyText);
}
