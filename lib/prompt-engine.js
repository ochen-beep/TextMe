/**
 * TextMe — Prompt assembly & generation engine
 * License: AGPL-3.0
 *
 * FIX: buildConversationText() no longer takes a userMessage parameter.
 * The user message is always already in phoneData.messages by the
 * time this function is called, so passing it again caused every
 * user message to appear twice in the prompt.
 *
 * FIX: World Info now receives chat.map(m => m.mes || '') instead of the
 * raw context.chat array of objects — ST's getWorldInfoPrompt()
 * expects strings, not message objects.
 *
 * FIX: stripSpeakerPrefix() now also matches the first token of charName
 * (e.g. "CRISPIN™") so short model-generated prefixes are stripped
 * even when charName is a long display string.
 *
 * FIX: splitResponseIntoMessages() Step 2 (single-\n expansion) is now
 * applied to EVERY part produced by Step 1, not only when Step 1
 * returned exactly one part.
 *
 * FIX: generatePhoneResponse() and generateAutonomousMessage() now accept
 * an optional AbortSignal and forward it to generateRaw() so that
 * TextMe's own generation can be cancelled independently from the
 * ST main-chat Stop button.
 *
 * v1.3.0: Prompt restructured into explicit XML blocks for cleaner model parsing:
 *   — smsPrompt (rules, persona, texting style)
 *   — char description / personality / scenario + user persona
 *   — World Info / lorebook + story summary / memories
 *   — recent RP events + current time + schedule/status
 *   — autonomous-only: autonomousPrompt (appended last)
 *
 * For autonomous generation, the autonomousPrompt is injected as a
 * block after <context>. Placing it last gives it maximum recency weight
 * in the model's attention.
 *
 * v1.4.0: Connection profile support (issue #13).
 * When settings.connectionProfileId is set, generation goes through
 * ConnectionManagerRequestService.sendRequest() instead of generateRaw().
 * Falls back to generateRaw() if Connection Manager is unavailable or
 * the profile is not found.
 *
 * FIX (v1.4.1): runGeneration() now calls
 * ConnectionManagerRequestService.constructPrompt() BEFORE sendRequest().
 * This converts the messages[] array into an instruct-formatted string
 * for Text Completion profiles (textgenerationwebui), while leaving Chat
 * Completion profiles (openai) unchanged. Previously Text Completion
 * profiles received an array instead of a string and silently returned
 * an empty response.
 *
 * FIX (v1.4.2): runGeneration() now correctly extracts the reply text from
 * the object returned by ConnectionManagerRequestService.sendRequest().
 * ChatCompletionService.sendRequest() with extractData=true returns
 * { content: string, reasoning: string } — NOT a plain string.
 * The previous code only checked result?.choices?.[0]?.message?.content
 * (raw API shape), which is absent on the already-extracted object, so
 * runGeneration() always returned '' → "Empty response from API" even
 * when the API call succeeded and the response was visible in the Node
 * console. Fix: extractTextFromResult() checks result?.content first
 * (extracted shape), then the raw-API path as a secondary fallback.
 *
 * v0.0.3-alpha: Removed autonomousTaskPrompt fallback from generateAutonomousMessage().
 * The two-field split (autonomousPrompt + autonomousTaskPrompt) has been
 * collapsed into a single autonomousPrompt field. mergeDefaults() in state.js
 * handles migration of existing saves transparently.
 *
 * v0.0.4-alpha: runVectorWIPipeline() — pre-activates vector WI entries before
 * getWorldInfoPrompt() is called. SillyTavern's vector pipeline runs as a
 * generation interceptor (vectors_rearrangeChat) BEFORE checkWorldInfo, so it
 * never fires when TextMe calls getWorldInfoPrompt() directly. Fix: call
 * globalThis.vectors_rearrangeChat() with a shallow chat copy, which emits
 * WORLDINFO_FORCE_ACTIVATE and populates WorldInfoBuffer.externalActivations,
 * then immediately call getWorldInfoPrompt() to pick them up. Guarded by:
 * - typeof globalThis.vectors_rearrangeChat === 'function'
 * - vectors settings.enabled_world_info === true
 * Falls back silently to keyword-only scan if vectors are unavailable.
 *
 * v1.5.0 logging improvements:
 *   — assembleSystemPrompt: [WARN] when total prompt chars >= 90% of maxContext
 *   — WI block: [DEBUG] names of activated entries (from result arrays when available)
 *
 * FIX (parseReplyQuote): two-pass matching — user messages preferred over char messages.
 * Previously a single newest-first loop over ALL messages could match a char's own
 * earlier bubble when the user's silent-send contained the same text. New strategy:
 *   Pass 1 — user messages only (char is replying TO the user — the common case)
 *   Pass 2 — fallback: any message (char replying to its own earlier bubble)
 *
 * FIX (T-08): runVectorWIPipeline now receives chatForWI (merged SMS+RP string[],
 * newest-first, per wiScanSource) instead of context.chat (RP-only object[]).
 *
 * Root cause of vectorized WI entries not activating:
 *   vectors_rearrangeChat builds its semantic query from the first N items of
 *   the array it receives (N = vectorSettings.query_messages, default 2).
 *   When context.chat was passed, the query contained only RP text — SMS
 *   messages were invisible to the vector search. Vectorized lorebook entries
 *   matched by SMS content (e.g. "тестирование") scored below the threshold
 *   and were never activated.
 *
 *   Fix: pass chatForWI so both the keyword scan (getWorldInfoPrompt) and the
 *   vector scan (vectors_rearrangeChat) operate on the same merged buffer.
 *   With wiScanSource='both', the most recent SMS message is chatForWI[0],
 *   so it lands in the vector query automatically.
 */
import { getSettings, getPhoneData, savePhoneData, getCharName, getUserName, sliceMessageHistory } from './state.js';
import { getScheduleContext } from './schedule.js';
import { runVectorWIPipeline } from './vector-wi.js';
import { applyRpOutputRegex } from './regex-util.js';
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
 *   task — if provided, appended as a <task> block after </context>.
 *          Used for autonomous messages.
 * @returns {Promise<string>}
 */
async function assembleSystemPrompt({ task } = {}) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    const sub = context.substituteParams || ((s) => s);

    const blocks = [];

    // ── Block 1: <role> ────────────────────────────────────────────────────
    // smsPrompt: texting rules, persona, cultural context, format rules.
    blocks.push(block('role', sub(settings.smsPrompt)));
    log.debug('[Prompt] Block <role>: ' + (settings.smsPrompt?.trim() ? `${settings.smsPrompt.length} chars` : 'EMPTY'));

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
            log.debug(`[Prompt] Block <character>: description=${!!fields.description}, personality=${!!fields.personality}, scenario=${!!fields.scenario}, examples=${!!fields.mes_example}`);
        } else {
            const char = context.characters?.[context.characterId];
            if (char) {
                if (char.description) parts.push(`Description: ${char.description}`);
                if (char.personality) parts.push(`Personality: ${char.personality}`);
                if (char.scenario)    parts.push(`Scenario: ${char.scenario}`);
                log.debug(`[Prompt] Block <character> (fallback): description=${!!char.description}, personality=${!!char.personality}, scenario=${!!char.scenario}`);
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
            const wiSource = settings.wiScanSource || 'sms';
            const wiDepth  = settings.wiScanDepth ?? 50;
            const charName = getCharName();
            const userName = getUserName();

            // Build scan buffer.
            // For 'both': merge SMS and RP messages by timestamp so depth indices
            // reflect true recency (not source-order). Each source is sliced to
            // wiDepth independently; the merged set is then sorted chronologically
            // and reversed (newest-first) before passing to getWorldInfoPrompt.
            const smsScanLines = [];
            if (wiSource === 'sms' || wiSource === 'both') {
                const smsMessages = phoneData?.messages ?? [];
                const sliced = wiDepth > 0 ? smsMessages.slice(-wiDepth) : smsMessages;
                for (const m of sliced) {
                    if (m.type === 'image' || !m.text) continue;
                    smsScanLines.push({ ts: m.time ?? 0, line: `${m.isUser ? userName : charName}: ${m.text}` });
                }
            }

            const rpScanLines = [];
            if (wiSource === 'rp' || wiSource === 'both') {
                const rpChat = context.chat ?? [];
                const sliced = wiDepth > 0 ? rpChat.slice(-wiDepth) : rpChat;
                const total = sliced.length;
                for (let i = 0; i < total; i++) {
                    const m = sliced[i];
                    if (m.is_system || !m.mes) continue;
                    const depth = total - 1 - i; // 0 = newest
                    const text = await applyRpOutputRegex(m.mes, depth);
                    // send_date may be a unix timestamp (s) or ISO string
                    const ts = m.send_date
                        ? (typeof m.send_date === 'number' ? m.send_date * 1000 : new Date(m.send_date).getTime())
                        : 0;
                    rpScanLines.push({ ts, line: `${m.name}: ${text}` });
                }
            }

            // Merge and sort chronologically (oldest first), then reverse to newest-first
            // for ST's depth-based WI scan. When source is single, no-op sort is fine.
            const merged = [...smsScanLines, ...rpScanLines].sort((a, b) => a.ts - b.ts);
            const chatForWI = merged.map(e => e.line).reverse();

            log.info(`[WI] Scanning: source=${wiSource}, depth=${wiDepth || 'all'}, bufLen=${chatForWI.length} (sms=${smsScanLines.length}, rp=${rpScanLines.length})`);

            if (chatForWI.length === 0 && wiSource !== 'both') {
                log.debug(`[WI] Scan buffer is empty (source=${wiSource})`);
            }

            // WI budget = world_info_budget% * maxContext (default 25%).
            // ST natively passes getMaxPromptTokens() = model_ctx - response_reserve.
            // TextMe bypasses the main pipeline, so we approximate:
            //   modelCtx - settings.maxTokens (our response reserve)
            // This prevents the WI budget from being artificially capped at 4096
            // when the model has a larger context window.
            const modelCtx   = context.max_context ?? 4096;
            const maxContext = Math.max(modelCtx - (settings.maxTokens || 300), Math.floor(modelCtx * 0.75));
            log.debug(`[WI] Budget: modelCtx=${modelCtx}, maxContext=${maxContext}`);

            // FIX (T-08): Pre-activate vector WI entries before the keyword scan.
            // Pass chatForWI (merged SMS+RP string[], newest-first) — NOT context.chat.
            //
            // vectors_rearrangeChat builds its semantic query from the first N items
            // of the array (N = vectorSettings.query_messages, default 2). Passing
            // context.chat (RP-only object[]) meant SMS messages were never part of
            // the query, so vectorized lorebook entries matched by SMS content scored
            // below the threshold and were silently skipped.
            //
            // chatForWI already contains the merged + sorted buffer built above.
            // vector-wi.js accepts string[] and wraps each line into { mes, is_system: false }.
            //
            // Must be called immediately before getWorldInfoPrompt — the
            // externalActivations buffer is cleared at the end of every checkWorldInfo run.
            await runVectorWIPipeline(chatForWI);

            const result = await context.getWorldInfoPrompt(chatForWI, maxContext, true);
            let wiText = result?.worldInfoString || (typeof result === 'string' ? result : '');

            // Note: activatedWorldInfo fallback intentionally removed.
            // getWorldInfoPrompt() already covers constant + keyword entries.
            // The fallback was unreliable — it could inject stale entries activated
            // by a previous main-chat generation, unrelated to the current SMS context.

            if (wiText?.trim()) {
                worldParts.push(wiText.trim());
                log.info(`[WI] Activated — injecting ${wiText.length} chars into <world> block.`);

                // Log names of activated entries when result exposes them.
                // ST's getWorldInfoPrompt() returns { worldInfoString, ... }.
                // The activated entry objects are in result.worldInfoBefore /
                // result.worldInfoAfter arrays (each entry has a .title or .comment field).
                // When these arrays are absent (older ST version), fall back to char count only.
                try {
                    const entryArrays = [
                        ...(Array.isArray(result?.worldInfoBefore) ? result.worldInfoBefore : []),
                        ...(Array.isArray(result?.worldInfoAfter)  ? result.worldInfoAfter  : []),
                    ];
                    if (entryArrays.length > 0) {
                        const names = entryArrays
                            .map(e => e?.title || e?.comment || e?.key?.[0] || '?')
                            .join(', ');
                        log.debug(`[WI] Activated entries (${entryArrays.length}): ${names}`);
                    }
                } catch (_) { /* ignore — entry shape varies by ST version */ }
            } else {
                log.info(`[WI] No entries activated (source=${wiSource}, bufLen=${chatForWI.length}).`);
            }
        } else {
            log.debug('[WI] getWorldInfoPrompt not available in this ST version — skipping.');
        }

        // 3b. Story summary from Summarize extension (read-only passive)
        const chat = context.chat;
        if (chat?.length > 0) {
            for (let i = chat.length - 1; i >= 0; i--) {
                if (chat[i].extra?.memory) {
                    worldParts.push(`[Story Summary]\n${chat[i].extra.memory}`);
                    log.debug('[Prompt] Story summary injected from Summarize extension.');
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
            const filtered = chat.filter(m => !m.is_system);
            const sliced   = filtered.slice(-limit);
            const total    = sliced.length;
            const lines    = [];
            for (let i = 0; i < total; i++) {
                const m     = sliced[i];
                const depth = total - 1 - i; // 0 = newest
                const text  = await applyRpOutputRegex(m.mes, depth);
                lines.push(`${m.name}: ${text}`);
            }
            const recent = lines.join('\n');
            if (recent) {
                ctxParts.push(`[Recent RP Events — for context only, do NOT continue the roleplay]\n${recent}`);
                log.debug(`[Prompt] Block <context>: injected ${sliced.length} RP messages.`);
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
        log.debug('[Prompt] Block <task> appended (autonomous mode).');
    }

    const assembled = blocks.filter(Boolean).join('\n\n');
    log.debug(`[Prompt] System prompt assembled: ${assembled.length} chars, ${blocks.filter(Boolean).length} blocks.`);

    // ── Context budget warning ─────────────────────────────────────────────
    // Warn when the system prompt alone consumes >= 90% of the model's context.
    // This is chars vs tokens — approximate, but useful to catch obvious overruns.
    // (1 token ≈ 4 chars for English/Russian mixed text)
    try {
        const ctx = SillyTavern.getContext();
        const modelCtx   = ctx.max_context ?? 4096;
        const maxTokens  = getSettings().maxTokens || 300;
        const budgetTokens = modelCtx - maxTokens;
        // rough estimate: 1 token ≈ 4 chars
        const estimatedTokens = Math.round(assembled.length / 4);
        const usagePct = budgetTokens > 0 ? Math.round((estimatedTokens / budgetTokens) * 100) : 0;
        if (usagePct >= 90) {
            log.warn(`[Prompt] Context tight: system prompt ~${estimatedTokens}t / ${budgetTokens}t budget (${usagePct}%) — conversation history may be heavily truncated.`);
        }
    } catch (_) { /* ignore */ }

    return assembled;
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
        const msgs = sliceMessageHistory(
            phoneData.messages,
            settings.smsHistory ?? 50,
            settings.smsHistoryDays ?? 0,
            getCurrentTime,
        );

        log.debug(`[Prompt] buildConversationText: ${msgs.length} messages sliced (limit=${settings.smsHistory ?? 50}, days=${settings.smsHistoryDays ?? 0}).`);

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

                // If this message is a reply, prepend a > quote line so the model
                // sees the cited text in-context — like Telegram's markdown export.
                let replyPrefix = '';
                if (msg.replyTo?.text) {
                    const snippet = msg.replyTo.text.trim().substring(0, 120);
                    replyPrefix = `> ${snippet}\n`;
                }
                lines.push(`[${ts}] ${sender}: ${replyPrefix}${msg.text}`);
            } else {
                const sender = msg.isUser ? userName : charName;
                let replyPrefix = '';
                if (msg.replyTo?.text) {
                    const snippet = msg.replyTo.text.trim().substring(0, 120);
                    replyPrefix = `> ${snippet}\n`;
                }
                lines.push(`${sender}: ${replyPrefix}${msg.text}`);
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
    const fullEscaped = escapeRe(charName);
    const firstWordMatch = charName.match(/^[\w™®©]+/);
    const firstToken     = firstWordMatch ? firstWordMatch[0] : null;
    const firstEscaped   = firstToken ? escapeRe(firstToken) : null;

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

    // Step 1b: re-join any quote-only part (all lines start with ">") with the
    // following part. Handles models that separate "> quote" from the reply body
    // with a blank line instead of a single newline.
    const rejoined = [];
    for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const isQuoteOnly = p.length > 0 && p.split('\n').every(l => l.startsWith('>'));
        if (isQuoteOnly && i + 1 < parts.length) {
            rejoined.push(p + '\n' + parts[i + 1]);
            i++; // skip the next part — we just merged it
        } else {
            rejoined.push(p);
        }
    }
    parts = rejoined;

    // Step 2: for EVERY part, expand single-\n lines into separate bubbles.
    // Exception: if the part starts with "> " it contains a reply quote block —
    // keep it intact so parseReplyQuote() can extract the quote and body together.
    const expanded = [];
    for (const part of parts) {
        if (part.includes('\n') && !part.startsWith('> ') && !part.startsWith('>')) {
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

    log.debug(`[Prompt] splitResponseIntoMessages: ${parts.length} bubble(s) parsed from response.`);
    return parts.length > 0 ? parts : (cleaned ? [cleaned] : []);
}

// ─────────────────────────────────────────────────────────
// Reply quote parsing
// ─────────────────────────────────────────────────────────

/**
 * Parse a `> quote` line from the start of a bot response part.
 *
 * If the text begins with one or more `> ` lines, extract them as the quoted
 * text and attempt to match the quote against existing messages to build a
 * proper replyTo reference.
 *
 * Matching strategy — two passes, newest-first within each pass:
 *   Pass 1 (preferred): user messages only.
 *     The character is most likely replying TO the user, so we search
 *     user messages first. This prevents a false match when the quoted
 *     text also appears inside an earlier char bubble (e.g. after the
 *     char echoed the same words back).
 *   Pass 2 (fallback): any message.
 *     Covers the rare case where the char is explicitly replying to one
 *     of its own earlier messages.
 *   Images and empty messages are skipped in both passes.
 *
 * @param {string} text The raw bot response part.
 * @param {Array}  messages phoneData.messages array.
 * @returns {{ text: string, replyTo: object|null }}
 *   text    — the response with the quote block stripped
 *   replyTo — { index, isUser, text } or null if no quote / no match found
 */
export function parseReplyQuote(text, messages) {
    if (!text || !text.startsWith('>')) {
        return { text, replyTo: null };
    }

    // Collect all leading > lines
    const lines = text.split('\n');
    const quoteLines = [];
    let bodyStart = 0;
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (l.startsWith('> ') || l === '>') {
            quoteLines.push(l.replace(/^>\s?/, '').trim());
            bodyStart = i + 1;
        } else {
            break;
        }
    }

    if (quoteLines.length === 0) {
        return { text, replyTo: null };
    }

    const quotedText = quoteLines.join(' ').trim();
    const bodyText   = lines.slice(bodyStart).join('\n').trim();

    // If stripping the quote leaves nothing — keep original text, skip replyTo
    if (!bodyText) {
        return { text, replyTo: null };
    }

    // Try to match quoted text against history.
    // Pass 1 (preferred): look for a USER message — char is most likely replying TO the user.
    // Pass 2 (fallback):  match any message — handles char replying to its own earlier bubble.
    // Searching newest-first so we always match the most recent occurrence.
    let replyTo = null;
    if (messages?.length && quotedText) {
        const needle = quotedText.toLowerCase();
        const prefix = needle.substring(0, 30);

        // Pass 1 — user messages only
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m.type === 'image' || !m.text || !m.isUser) continue;
            const haystack = m.text.toLowerCase();
            if (haystack.includes(needle) || haystack.startsWith(prefix)) {
                replyTo = { index: i, isUser: true, text: m.text };
                log.debug(`[Prompt] parseReplyQuote: matched "${quotedText.substring(0, 40)}" → msg[${i}] isUser=true (user-priority pass)`);
                break;
            }
        }

        // Pass 2 — fallback: any message (char replying to own earlier text)
        if (!replyTo) {
            for (let i = messages.length - 1; i >= 0; i--) {
                const m = messages[i];
                if (m.type === 'image' || !m.text) continue;
                const haystack = m.text.toLowerCase();
                if (haystack.includes(needle) || haystack.startsWith(prefix)) {
                    replyTo = { index: i, isUser: m.isUser, text: m.text };
                    log.debug(`[Prompt] parseReplyQuote: matched "${quotedText.substring(0, 40)}" → msg[${i}] isUser=${m.isUser} (fallback pass)`);
                    break;
                }
            }
        }

        if (!replyTo) {
            log.debug(`[Prompt] parseReplyQuote: no match found for quoted text "${quotedText.substring(0, 40)}"`);
        }
    }

    return { text: bodyText, replyTo };
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
    const settings   = getSettings();
    const profileId  = settings.connectionProfileId;
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
 * Extract a plain text string from whatever sendRequest() returns.
 *
 * ConnectionManagerRequestService.sendRequest() with extractData=true
 * returns the result of ChatCompletionService / TextCompletionService
 * .processRequest(), which in turn returns the result of their own
 * .sendRequest(). The actual shape depends on the API type:
 *
 *   Chat Completion (openai)              → { content: string, reasoning: string }
 *   Text Completion (textgenerationwebui) → { content: string, reasoning: string }
 *
 * Neither returns a plain string, and neither returns the raw API JSON
 * shape { choices: [...] }. We check in order:
 *   1. already a string (defensive — unlikely but safe)
 *   2. result.content (extracted shape — the normal case)
 *   3. result.choices[0].message.content (raw API shape — legacy fallback)
 *
 * @param {string | { content?: string, reasoning?: string } | any} result
 * @returns {string}
 */
function extractTextFromResult(result) {
    if (typeof result === 'string') {
        log.debug('[Profile] extractTextFromResult: plain string result.');
        return result;
    }
    if (typeof result?.content === 'string') {
        log.debug('[Profile] extractTextFromResult: extracted {content} shape.');
        return result.content;
    }
    // Raw API shape fallback (shouldn't happen with extractData=true, kept for safety)
    const legacy = result?.choices?.[0]?.message?.content;
    if (typeof legacy === 'string') {
        log.debug('[Profile] extractTextFromResult: raw API shape fallback used.');
        return legacy;
    }
    // Log the shape so future debugging is easier
    log.warn('[Profile] extractTextFromResult: unexpected result shape — returning empty string. Type:', typeof result,
        result !== null && typeof result === 'object' ? 'keys=' + Object.keys(result).join(',') : String(result));
    return '';
}

/**
 * Isolation guard: listener registered on CHAT_COMPLETION_PROMPT_READY that
 * sets dryRun=true for the duration of a TextMe generation.
 *
 * Some third-party extensions (e.g. st-memory-enhancement) listen to this
 * event and inject their own prompts unless dryRun is true. generateRaw()
 * fires the event with dryRun=false, so without this guard their content
 * bleeds into the TextMe SMS prompt.
 *
 * We register the listener BEFORE calling generateRaw(), let it flip the flag,
 * then remove it immediately in a finally block.
 */
function _makeDryRunGuard(eventSource, event_types) {
    const handler = (eventData) => { eventData.dryRun = true; };
    // makeFirst ensures our handler runs before any third-party listener
    if (typeof eventSource.makeFirst === 'function') {
        eventSource.makeFirst(event_types.CHAT_COMPLETION_PROMPT_READY, handler);
    } else {
        eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, handler);
    }
    return handler;
}

/**
 * Run generation — either via Connection Manager profile or the default generateRaw().
 *
 * FIX: For Connection Manager profiles, we now call constructPrompt() before
 * sendRequest(). This is required because Text Completion profiles expect a
 * formatted string prompt, not an array of message objects. constructPrompt()
 * handles the distinction automatically:
 *   - Chat Completion → returns the messages[] array unchanged
 *   - Text Completion → returns an instruct-formatted string
 *
 * FIX (v1.4.2): extractTextFromResult() is now used to unwrap the response.
 * sendRequest() with extractData=true returns { content, reasoning },
 * not a plain string — the previous code checked for the raw API shape
 * and always got '' back.
 *
 * Isolation: registers a CHAT_COMPLETION_PROMPT_READY listener that sets
 * dryRun=true before any third-party extensions can inject their prompts.
 * The listener is removed in a finally block after generation completes.
 *
 * @param {{ systemPrompt: string, conversationText: string, maxTokens: number, signal?: AbortSignal }} params
 * @returns {Promise<string>}
 */
async function runGeneration({ systemPrompt, conversationText, maxTokens, signal }) {
    const context = SillyTavern.getContext();
    const profile = resolveConnectionProfile();

    // Register isolation guard before any generation path fires CHAT_COMPLETION_PROMPT_READY.
    // This prevents third-party extensions from injecting their prompts into TextMe calls.
    const { eventSource, event_types } = context;
    const _dryRunGuard = _makeDryRunGuard(eventSource, event_types);

    try {
        if (profile) {
            // ── Connection Manager path ────────────────────────────────────────
            log.info(`[Profile] Sending via connection profile: "${profile.name}" (${profile.id})`);
            const { ConnectionManagerRequestService } = await import('/scripts/extensions/shared.js');

            // Build canonical messages array (system + user turn)
            const messages = [
                { role: 'system', content: systemPrompt },
                { role: 'user',   content: conversationText },
            ];

            // FIX: constructPrompt() converts messages[] to the correct format:
            //   - Chat Completion profiles (openai) → messages[] returned as-is
            //   - Text Completion profiles (textgenerationwebui) → instruct-formatted string
            // Without this call, Text Completion profiles received a raw JS array instead
            // of a string, causing the backend to return an empty response silently.
            let prompt;
            try {
                prompt = ConnectionManagerRequestService.constructPrompt(messages, profile.id);
                log.debug(`[Profile] constructPrompt returned: ${Array.isArray(prompt) ? 'messages[] (chat completion)' : 'string (text completion)'}`);
            } catch (e) {
                // constructPrompt can throw if profile is misconfigured — fall back to messages[]
                log.warn('[Profile] constructPrompt failed, falling back to messages[]:', e);
                prompt = messages;
            }

            const result = await ConnectionManagerRequestService.sendRequest(
                profile.id,
                prompt,
                maxTokens,
                { stream: false, signal, extractData: true, includePreset: true, includeInstruct: true },
            );

            // FIX (v1.4.2): sendRequest() with extractData=true returns
            // { content: string, reasoning: string }, NOT a plain string.
            const text = extractTextFromResult(result);
            log.info(`[Profile] Response received — ${text.length} chars.`);
            return text;
        }

        // ── Default generateRaw() path ───────────────────────────────────────
        const { generateRaw } = context;
        if (!generateRaw) {
            throw new Error('generateRaw not available. Update SillyTavern to the latest version.');
        }

        log.info('[Profile] Sending via default ST connection (no profile selected).');
        const result = await generateRaw({
            prompt: conversationText,
            systemPrompt: systemPrompt,
            max_new_tokens: maxTokens,
            ...(signal ? { signal } : {}),
        });
        const text = typeof result === 'string' ? result : '';
        log.info(`[Profile] generateRaw response received — ${text.length} chars.`);
        return text;
    } finally {
        // Always remove the isolation guard, even if generation throws or is aborted
        eventSource.removeListener(event_types.CHAT_COMPLETION_PROMPT_READY, _dryRunGuard);
    }
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
    const settings         = getSettings();
    const systemPrompt     = await assembleSystemPrompt();
    const conversationText = buildConversationText();
    const maxTokens        = settings.maxTokens || 300;

    log.info(`[Generation] generatePhoneResponse — systemPrompt=${systemPrompt.length}c, conversation=${conversationText.length}c, maxTokens=${maxTokens}`);

    // Log which profile is being used
    const profile = resolveConnectionProfile();
    if (profile) {
        log.info(`[Profile] Using: "${profile.name}" (id: ${profile.id})`);
    } else {
        log.info('[Profile] Using default ST connection (no profile configured).');
    }

    const replyText = (await runGeneration({ systemPrompt, conversationText, maxTokens, signal })).trim();
    if (!replyText) {
        throw new Error('Empty response from API');
    }

    log.debug('[Generation] Raw response (first 300):', replyText.substring(0, 300));
    const parts = splitResponseIntoMessages(replyText);
    log.info(`[Generation] Response split into ${parts.length} bubble(s).`);
    return parts;
}

/**
 * Generate an autonomous (unprompted) message.
 *
 * autonomousPrompt is injected as the final block in the system prompt,
 * giving it maximum recency weight. The conversation history remains in the
 * conversation prompt (user turn) as usual.
 *
 * v0.0.3-alpha: Removed the autonomousTaskPrompt fallback chain. There is now
 * a single settings.autonomousPrompt field. mergeDefaults() in state.js handles
 * migration of any existing autonomousTaskPrompt values transparently.
 *
 * @param {AbortSignal} [signal]
 * @returns {Promise<string[]>}
 */
export async function generateAutonomousMessage(signal) {
    const context  = SillyTavern.getContext();
    const settings = getSettings();
    const sub      = context.substituteParams || ((s) => s);

    // Single autonomous prompt — no fallback chain needed after v0.0.3-alpha.
    // migration from autonomousTaskPrompt is handled in mergeDefaults() (state.js).
    const taskPrompt       = sub(settings.autonomousPrompt || '');
    const systemPrompt     = await assembleSystemPrompt({ task: taskPrompt });
    const conversationText = buildConversationText();
    const maxTokens        = settings.maxTokens || 300;

    log.info(`[Generation] generateAutonomousMessage — systemPrompt=${systemPrompt.length}c, conversation=${conversationText.length}c, maxTokens=${maxTokens}`);

    // Log which profile is being used
    const profile = resolveConnectionProfile();
    if (profile) {
        log.info(`[Profile] Autonomous: using "${profile.name}" (id: ${profile.id})`);
    } else {
        log.info('[Profile] Autonomous: using default ST connection.');
    }

    const replyText = (await runGeneration({ systemPrompt, conversationText, maxTokens, signal })).trim();
    if (!replyText) throw new Error('Empty autonomous response');

    log.debug('[Generation] Autonomous raw response (first 300):', replyText.substring(0, 300));
    const parts = splitResponseIntoMessages(replyText);
    log.info(`[Generation] Autonomous response split into ${parts.length} bubble(s).`);
    return parts;
}
