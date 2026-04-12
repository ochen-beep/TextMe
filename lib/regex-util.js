/**
 * TextMe — Regex utility: apply ST regex scripts to RP chat messages
 * License: AGPL-3.0
 *
 * Problem: RP chat messages injected into TextMe's system prompt contain raw
 * unprocessed text — decorative markup, formatting blocks, etc. — that the
 * user has set up regex scripts to strip. ST applies regex scripts to messages
 * during display/storage, but TextMe reads m.mes directly from context.chat
 * (which is the stored, pre-display value).
 *
 * How ST regex flags work:
 *   - persistent (no flags):  applied to m.mes at storage time → already in m.mes, skip here
 *   - markdownOnly:           applied at render time for display → NOT in m.mes, but also
 *                             should NOT go into the AI prompt (it's CSS/HTML for the UI)
 *   - promptOnly:             applied when sending to AI → exactly what we want here
 *
 * Therefore we run only isPrompt: true.
 * Running isMarkdown: true would inject display-only CSS/HTML transformations into
 * the prompt, which is wrong — those scripts are for visual rendering, not AI context.
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
 * Runs only the promptOnly pass (isPrompt: true) — scripts explicitly marked
 * for AI prompt injection. markdownOnly scripts are intentionally skipped
 * because they perform display transformations (CSS, HTML) that must not enter
 * the AI prompt. Persistent scripts (no flags) are skipped because they have
 * already been applied to m.mes at storage time.
 *
 * Falls back to the original string if the regex engine is unavailable or throws.
 *
 * @param {string} text      — raw m.mes value from context.chat
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
        // promptOnly scripts only — these are explicitly meant to modify AI prompt content.
        // markdownOnly scripts are for visual rendering (CSS, HTML) and must NOT go into prompts.
        // persistent scripts (no flags) are already applied to m.mes at storage time — skip to avoid double-apply.
        const result = _getRegexedString(text, placement, { isPrompt: true, depth });
        return result;
    } catch (e) {
        log.warn('[Regex] applyRpOutputRegex threw — returning original text:', e);
        return text;
    }
}
