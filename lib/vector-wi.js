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
    if (typeof globalThis.vectors_rearrangeChat !== 'function') {
        log.debug('[VectorWI] vectors_rearrangeChat not available — skipping vector activation.');
        return;
    }

    const context = SillyTavern.getContext();
    const vectorSettings = context.extensionSettings?.vectors;

    if (!vectorSettings?.enabled_world_info) {
        log.debug('[VectorWI] Vectors WI not enabled in Vectors settings — skipping.');
        return;
    }

    // Shallow copy — rearrangeChat mutates the passed array (removes messages
    // it injects into the extension prompt). We must not touch context.chat.
    const chatCopy = (chatArray || context.chat || [])
        .filter(m => !m.is_system)
        .map(m => ({ ...m }));

    const maxContext = context.max_context ?? 12000;

    try {
        // type='normal' — any value except 'quiet' runs the full pipeline.
        // null abort signal — we are not in a cancellable generation here.
        await globalThis.vectors_rearrangeChat(chatCopy, maxContext, null, 'normal');
        log.debug('[VectorWI] Vector WI pipeline completed — externalActivations populated.');
    } catch (e) {
        // Non-fatal: if vectors fail, keyword scan still works normally.
        log.warn('[VectorWI] vectors_rearrangeChat threw — falling back to keyword-only scan:', e);
    }
}
