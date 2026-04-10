/**
 * TextMe — Regex utility: apply ST regex scripts to RP chat messages
 * License: AGPL-3.0
 *
 * Problem: RP chat messages injected into TextMe's system prompt contain raw
 * unprocessed text — decorative markup, formatting blocks, etc. — that the
 * user has set up regex scripts to strip. ST applies regex scripts to messages
 * during display/storage, but TextMe reads m.mes directly from context.chat
 * (which is the stored, pre-display value). Display-only (markdownOnly) scripts
 * have already been applied at render time and are NOT in m.mes. But
 * "persistent" scripts that fire on AI_OUTPUT DO alter m.mes — meaning the
 * stored value should already be clean for those.
 *
 * The issue is markdownOnly + promptOnly scripts. To catch all scripts the user
 * intends to affect the content, we run getRegexedString with BOTH passes:
 *   1. isPrompt:   true  — catches promptOnly scripts
 *   2. isMarkdown: true  — catches markdownOnly scripts
 *
 * Persistent scripts (neither flag) have already been applied to m.mes at
 * storage time, so we skip them to avoid double-application.
 *
 * Isolated module — imports only logger.js to avoid circular dependencies.
 */

import { log } from './logger.js';

/** @type {Function|null} */
let _getRegexedString = null;
/** @type {object|null} */
let _regex_placement  = null;
/** @type {boolean} */
let _importAttempted  = false;

/**
 * Lazy-load getRegexedString + regex_placement from ST's regex engine.
 * Returns true if available, false if the extension is absent/disabled.
 */
async function _ensureRegexEngine() {
    if (_importAttempted) return _getRegexedString !== null;
    _importAttempted = true;

    try {
        const mod = await import('/scripts/extensions/regex/engine.js');
        _getRegexedString = mod.getRegexedString;
        _regex_placement  = mod.regex_placement;
        log.debug('[Regex] engine.js loaded successfully.');
        return true;
    } catch (e) {
        log.debug('[Regex] regex engine not available (extension absent?) — skipping regex processing:', e?.message);
        return false;
    }
}

/**
 * Apply active ST regex scripts to a single RP chat message text.
 *
 * Runs two ephemeral passes (promptOnly + markdownOnly) to catch scripts that
 * are meant to clean up display/prompt text without touching stored chat data.
 * Persistent scripts (neither flag) are intentionally skipped here because
 * they have already been applied to m.mes at storage time.
 *
 * Falls back to the original string if the regex engine is unavailable or
 * throws.
 *
 * @param {string} text   — raw m.mes value from context.chat
 * @param {number} [depth=0] — chat depth of this message (0 = newest), used for
 *                             minDepth/maxDepth filtering. Pass (totalMessages - index - 1).
 * @returns {Promise<string>}
 */
export async function applyRpOutputRegex(text, depth = 0) {
    if (!text) return text;

    const available = await _ensureRegexEngine();
    if (!available) return text;

    const placement = _regex_placement.AI_OUTPUT; // 2

    try {
        // Pass 1: promptOnly scripts — fire when isPrompt=true
        let result = _getRegexedString(text, placement, { isPrompt: true, depth });
        // Pass 2: markdownOnly scripts — fire when isMarkdown=true
        result     = _getRegexedString(result, placement, { isMarkdown: true, depth });
        return result;
    } catch (e) {
        log.warn('[Regex] applyRpOutputRegex threw — returning original text:', e);
        return text;
    }
}
