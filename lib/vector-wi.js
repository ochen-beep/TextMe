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
 * FIX (T-08 / T-09):
 *   Previously this function received context.chat (RP-only) and the vector
 *   query was built from the last N RP messages — completely ignoring SMS.
 *   Keyword WI scan already used the merged SMS+RP chatForWI buffer (per
 *   wiScanSource), but vector scan was blind to SMS content. Fixed by:
 *     - accepting string[] (lines from chatForWI) OR object[] (legacy/fallback)
 *     - prompt-engine.js now passes chatForWI instead of context.chat
 *   Both scans now query the same source buffer.
 *
 *   T-09: Guard is now a warn-level log (not debug) when
 *   enabled_world_info=true but vectors_rearrangeChat is unavailable.
 *
 *   Diagnostic: a one-shot WORLDINFO_FORCE_ACTIVATE listener counts how many
 *   entries the vector search actually activated, so the log now shows
 *   "N entries activated" instead of the opaque "pipeline completed".
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
 * @param {string[]|object[]|null} chatInput
 *   The scan buffer to build the vector query from.
 *   Accepts TWO formats (auto-detected):
 *     string[]  — lines from chatForWI, e.g. "Виктория: тестирование"
 *                 Each string is wrapped into { mes, is_system: false }.
 *                 rearrangeChat/getQueryText only reads .mes, so this is sufficient.
 *     object[]  — raw chat message objects (legacy; must have .mes field).
 *                 Shallow-copied and filtered by is_system as before.
 *   Pass chatForWI (the merged SMS+RP buffer) so that vector search queries
 *   the same content as the keyword WI scan — NOT context.chat (RP-only).
 * @returns {Promise<void>}
 */
export async function runVectorWIPipeline(chatInput) {
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

    // FIX (T-08): accept string[] OR object[].
    //
    // string[]  — lines produced by the chatForWI builder in prompt-engine.js
    //             ("Name: text", newest-first). Wrapped into minimal objects
    //             { mes, is_system: false } — that is all rearrangeChat needs;
    //             getQueryText() only reads m.mes and rearrangeChat filters !m.is_system.
    //
    // object[]  — raw ST chat objects (shallow-copied, filtered by is_system).
    //             Kept for safety / forward-compat if the call-site ever passes
    //             a context.chat-shaped array directly.
    //
    // rearrangeChat mutates the array it receives (splices out injected messages).
    // We always work on a copy so the caller's buffer is never touched.
    const input = chatInput || [];
    const chatCopy = input
        .filter(Boolean)
        .map(item =>
            typeof item === 'string'
                ? { mes: item.trim(), is_system: false }
                : { ...item },
        )
        .filter(m => !m.is_system && m.mes);

    if (chatCopy.length === 0) {
        log.debug('[VectorWI] Scan buffer is empty — skipping vector activation.');
        return;
    }

    const maxContext = context.max_context ?? 4096;

    // Diagnostic: subscribe to WORLDINFO_FORCE_ACTIVATE before calling
    // rearrangeChat so we can count how many entries were actually activated.
    // The listener is one-shot (removeListener after rearrangeChat returns
    // regardless of whether the event fired).
    const { eventSource, event_types } = context;
    const wiForceActivateEvent =
        event_types?.WORLDINFO_FORCE_ACTIVATE ?? 'worldInfoForceActivate';
    let activatedCount = 0;
    const _countActivated = (entries) => {
        activatedCount = Array.isArray(entries) ? entries.length : 0;
    };
    if (eventSource && typeof eventSource.once === 'function') {
        eventSource.once(wiForceActivateEvent, _countActivated);
    }

    try {
        // type='normal' — any value except 'quiet' runs the full pipeline.
        // null abort signal — we are not in a cancellable generation here.
        await globalThis.vectors_rearrangeChat(chatCopy, maxContext, null, 'normal');

        // Remove the diagnostic listener in case rearrangeChat found nothing
        // and WORLDINFO_FORCE_ACTIVATE was never emitted (once() is auto-removed
        // on fire, but we must clean up the non-fired case too).
        if (eventSource && typeof eventSource.removeListener === 'function') {
            eventSource.removeListener(wiForceActivateEvent, _countActivated);
        }

        log.debug(
            `[VectorWI] Vector WI pipeline completed — ` +
            `${activatedCount} entr${activatedCount === 1 ? 'y' : 'ies'} activated via vector search.`,
        );

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
        // Clean up diagnostic listener on error path too
        if (eventSource && typeof eventSource.removeListener === 'function') {
            eventSource.removeListener(wiForceActivateEvent, _countActivated);
        }
        // Non-fatal: if vectors fail, keyword scan still works normally.
        log.warn('[VectorWI] vectors_rearrangeChat threw — falling back to keyword-only scan:', e);
    }
}
