/**
 * TextMe — Vector World Info pipeline helper
 * License: AGPL-3.0
 *
 * Isolated module: imports only logger.js to avoid circular dependencies.
 *   prompt-engine.js → schedule.js (getScheduleContext)
 *   schedule.js      → prompt-engine.js (was runVectorWIPipeline — now broken out here)
 *
 * Background:
 *   SillyTavern's vector WI activation runs as a generation interceptor
 *   (vectors_rearrangeChat) BEFORE checkWorldInfo. When TextMe calls
 *   getWorldInfoPrompt() directly it bypasses that interceptor, so
 *   vector-flagged lorebook entries are never activated.
 *
 *   Fix: call globalThis.vectors_rearrangeChat() immediately before
 *   getWorldInfoPrompt(). This emits WORLDINFO_FORCE_ACTIVATE which populates
 *   WorldInfoBuffer.externalActivations, which checkWorldInfo then picks up.
 *   The buffer is cleared after every checkWorldInfo run, so the calls must
 *   be sequential without any other WI scan in between.
 *
 * FIX (T-07): After vectors_rearrangeChat() runs, it calls setExtensionPrompt()
 *   internally and writes the vector-retrieved chat messages into the ST
 *   extension prompt slot '3_vectors'. For a TextMe generation that slot is
 *   irrelevant (we build our own prompt), but it stays dirty until the next
 *   normal RP generation overwrites it. We clear it immediately after the
 *   pipeline so a rapid switch to the RP chat does not see stale SMS context.
 *
 * FIX (T-09): Guard is now a warn-level log (not debug) when
 *   enabled_world_info=true but vectors_rearrangeChat is unavailable —
 *   previously this was a silent debug-level no-op that gave no feedback.
 */

import { log } from './logger.js';

/**
 * Pre-activate vector WI entries so that the subsequent getWorldInfoPrompt()
 * call picks them up via WorldInfoBuffer.externalActivations.
 *
 * Must be called immediately before getWorldInfoPrompt() — the buffer is
 * cleared at the end of every checkWorldInfo run.
 *
 * Guards (silent no-op if either fails):
 *   - globalThis.vectors_rearrangeChat must exist (Vectors extension active)
 *   - extensionSettings.vectors.enabled_world_info must be true
 *
 * @param {object[]|null} chatArray  — context.chat or equivalent (will NOT be mutated)
 * @returns {Promise<void>}
 */
export async function runVectorWIPipeline(chatArray) {
    const context = SillyTavern.getContext();
    const vectorSettings = context.extensionSettings?.vectors;

    // FIX (T-09): if Vectors WI is configured but the function is missing,
    // emit a warn-level message instead of silently doing nothing.
    // This surfaces misconfiguration to the user (e.g. Vectors extension disabled).
    if (typeof globalThis.vectors_rearrangeChat !== 'function') {
        if (vectorSettings?.enabled_world_info) {
            log.warn(
                '[VectorWI] ⚠ enabled_world_info=true but vectors_rearrangeChat is unavailable. ' +
                'Is the Vector Storage extension enabled?',
            );
        } else {
            log.debug('[VectorWI] vectors_rearrangeChat not available — skipping vector activation.');
        }
        return;
    }

    if (!vectorSettings?.enabled_world_info) {
        log.debug('[VectorWI] Vectors WI not enabled in Vectors settings — skipping.');
        return;
    }

    // Shallow copy — rearrangeChat mutates the passed array (removes messages
    // it injects into the extension prompt). We must not touch context.chat.
    const chatCopy = (chatArray || context.chat || [])
        .filter(m => !m.is_system)
        .map(m => ({ ...m }));

    const maxContext = context.max_context ?? 4096;

    try {
        // type='normal' — any value except 'quiet' runs the full pipeline.
        // null abort signal — we are not in a cancellable generation here.
        await globalThis.vectors_rearrangeChat(chatCopy, maxContext, null, 'normal');
        log.debug('[VectorWI] Vector WI pipeline completed — externalActivations populated.');

        // FIX (T-07): vectors_rearrangeChat() calls setExtensionPrompt('3_vectors', ...)
        // internally, injecting SMS-context chunks into a slot meant for RP chat.
        // We only needed the WORLDINFO_FORCE_ACTIVATE side-effect; the injected text
        // is irrelevant for TextMe and would pollute the next RP generation if the
        // user switches quickly. Clear it immediately while externalActivations is
        // still populated (getWorldInfoPrompt hasn't run yet).
        if (typeof context.setExtensionPrompt === 'function') {
            // Arguments: tag, content, position, depth, scan_wi, role
            // Pass empty string with the same defaults vectors uses so we overwrite cleanly.
            context.setExtensionPrompt('3_vectors', '', 0, 0, false, 0);
            log.debug('[VectorWI] Extension prompt slot "3_vectors" cleared after pipeline.');
        }
    } catch (e) {
        // Non-fatal: if vectors fail, keyword scan still works normally.
        log.warn('[VectorWI] vectors_rearrangeChat threw — falling back to keyword-only scan:', e);
    }
}
