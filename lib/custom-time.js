/**
 * TextMe — Custom Game Time
 * License: AGPL-3.0
 *
 * Allows per-chat game time that differs from wall clock:
 *   manual       — only changed explicitly
 *   per-message  — auto-advances random range on each user message
 *   realtime     — 1:1 with real clock (updates in memory every second)
 *   accelerated  — faster than real time (×N)
 *
 * Stored in chatMetadata.textmeTime (separate from textme key to avoid
 * polluting the main phoneData object).
 *
 * Integration points:
 *   - prompt-engine.js: call getCurrentTime() instead of new Date()
 *   - phone-ui.js updateStatusBarTime(): call getFormattedGameTime()
 *   - events.js onChatChanged(): call initCustomTime() / stopCustomTime()
 *   - settings-ui.js: call openTimeEditor() from a button
 */

import { log } from './logger.js';

const TIME_KEY          = 'textmeTime';
const UNLOAD_CACHE_KEY  = 'textme_time_unload_cache';

// For realtime/accelerated: anchor points stored at start of interval.
// currentDate is derived on-the-fly from these — never mutated in chatMetadata
// while the interval is running (avoids stale-read bug).
let _rtStartReal = null;   // Date.now() when interval started
let _rtStartGame = null;   // game timestamp (ms) when interval started
let _rtFactor    = 1;      // acceleration factor (1 = realtime)
let realtimeInterval = null;

// Flush live time synchronously into localStorage on page unload.
// initCustomTime() picks it up on next load if chatMetadata hasn't been saved yet.
window.addEventListener('beforeunload', () => {
    if (realtimeInterval === null) return;
    try {
        const liveTime = getCurrentTime().toISOString();
        // Also flush into chatMetadata synchronously (best-effort — ST may ignore async save)
        const context = SillyTavern.getContext();
        const tc = context.chatMetadata?.[TIME_KEY];
        if (tc?.enabled) {
            tc.currentDate = liveTime;
            context.chatMetadata[TIME_KEY] = tc;
        }
        // localStorage as fallback: keyed by chat id so it survives a reload
        const chatId = context.getCurrentChatId?.() ?? 'default';
        localStorage.setItem(UNLOAD_CACHE_KEY, JSON.stringify({ chatId, time: liveTime }));
    } catch { /* ignore */ }
});

// ─── Default config ──────────────────────────────────────────────────────────

export function getDefaultTimeConfig() {
    return {
        enabled:              false,
        baseDate:             new Date().toISOString(),
        currentDate:          new Date().toISOString(),
        flowMode:             'per-message', // 'manual'|'per-message'|'realtime'|'accelerated'
        autoAdvanceOnMessage: true,
        autoAdvanceRange:     { min: 1, max: 30 }, // minutes
        accelerationFactor:   10,
    };
}

// ─── Storage helpers ──────────────────────────────────────────────────────────

function getTimeConfig() {
    const context = SillyTavern.getContext();
    return context.chatMetadata?.[TIME_KEY] || null;
}

function setTimeConfig(config) {
    const context = SillyTavern.getContext();
    if (!context.chatMetadata) return;
    context.chatMetadata[TIME_KEY] = config;
    if (context.saveMetadataDebounced) {
        context.saveMetadataDebounced();
    } else {
        context.saveMetadata?.().catch(() => {});
    }
}

/**
 * Like setTimeConfig but forces an immediate (non-debounced) save.
 * Use for explicit user actions (editor save) to survive page reload.
 */
function setTimeConfigImmediate(config) {
    const context = SillyTavern.getContext();
    if (!context.chatMetadata) return;
    context.chatMetadata[TIME_KEY] = config;
    context.saveMetadata?.().catch(() => {});
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get the current game time as a Date object.
 * For realtime/accelerated: computed live from anchor points (not from stored currentDate).
 * Falls back to real wall clock if custom time is disabled.
 * @returns {Date}
 */
export function getCurrentTime() {
    const tc = getTimeConfig();
    if (!tc?.enabled) return new Date();

    // If an interval is running, compute live from anchors
    if (realtimeInterval !== null && _rtStartReal !== null) {
        const elapsed = Date.now() - _rtStartReal;
        return new Date(_rtStartGame + elapsed * _rtFactor);
    }

    // manual / per-message — read stored value
    if (tc.currentDate) return new Date(tc.currentDate);
    return new Date();
}

/**
 * Format the current game time for the status bar (HH:MM).
 * @returns {string}
 */
export function getFormattedGameTime() {
    return getCurrentTime().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Initialize / restart the custom time system for the current chat.
 * Call on CHAT_CHANGED.
 */
export function initCustomTime() {
    // Stop without flushing — we're about to read fresh config anyway
    _clearInterval();

    const tc = getTimeConfig();
    if (!tc?.enabled) return;

    if (!tc.currentDate) {
        tc.currentDate = tc.baseDate || new Date().toISOString();
        setTimeConfig(tc);
    }

    // On page reload, chatMetadata may not have been saved with the latest live time.
    // Check the localStorage unload cache — if it's for this chat and newer, apply it.
    if (tc.flowMode === 'realtime' || tc.flowMode === 'accelerated') {
        try {
            const raw = localStorage.getItem(UNLOAD_CACHE_KEY);
            if (raw) {
                const { chatId, time } = JSON.parse(raw);
                const context = SillyTavern.getContext();
                const currentChatId = context.getCurrentChatId?.() ?? 'default';
                if (chatId === currentChatId) {
                    const cachedMs  = new Date(time).getTime();
                    const storedMs  = new Date(tc.currentDate).getTime();
                    if (cachedMs > storedMs) {
                        tc.currentDate = time;
                        log.info(`Custom time: restored from unload cache (${time})`);
                    }
                }
                localStorage.removeItem(UNLOAD_CACHE_KEY);
            }
        } catch { /* ignore */ }

        _startLiveUpdates(tc);
    }

    log.info(`Custom time initialized: ${tc.flowMode}, current=${tc.currentDate}`);
}

/**
 * Stop realtime/accelerated updates.
 * Flushes the current live time into chatMetadata before stopping.
 */
export function stopCustomTime() {
    if (realtimeInterval === null) return;

    // Compute current live time and persist it
    const liveTime = getCurrentTime();
    const tc = getTimeConfig();
    if (tc?.enabled) {
        tc.currentDate = liveTime.toISOString();
        setTimeConfigImmediate(tc);
    }

    _clearInterval();
}

/**
 * Enable custom time for the current chat.
 * @param {object} [overrides]
 */
export function enableCustomTime(overrides = {}) {
    const existing = getTimeConfig() || getDefaultTimeConfig();
    const config   = { ...existing, ...overrides, enabled: true };
    setTimeConfig(config);
    initCustomTime();
}

/**
 * Disable custom time.
 */
export function disableCustomTime() {
    const tc = getTimeConfig();
    if (!tc) return;
    _clearInterval();
    tc.enabled = false;
    setTimeConfig(tc);
}

/**
 * Advance game time by a random amount in the configured range.
 * Call on each user message when flowMode === 'per-message'.
 */
export function advanceTimeOnMessage() {
    const tc = getTimeConfig();
    if (!tc?.enabled) return;
    if (tc.flowMode !== 'per-message' || !tc.autoAdvanceOnMessage) return;

    const { min, max } = tc.autoAdvanceRange || { min: 1, max: 30 };
    const advanceMin = Math.floor(Math.random() * (max - min + 1)) + min;
    const current = new Date(tc.currentDate || tc.baseDate);
    current.setMinutes(current.getMinutes() + advanceMin);
    tc.currentDate = current.toISOString();
    setTimeConfig(tc);

    log.debug(`Game time advanced by ${advanceMin} min → ${tc.currentDate}`);
}

/**
 * Jump game time forward by N minutes.
 * @param {number} minutes
 */
export function jumpTimeForward(minutes) {
    const tc = getTimeConfig();
    if (!tc?.enabled) return;
    const current = new Date(tc.currentDate || tc.baseDate);
    current.setMinutes(current.getMinutes() + minutes);
    tc.currentDate = current.toISOString();
    setTimeConfig(tc);
}

/**
 * Check if custom time is enabled for the current chat.
 * @returns {boolean}
 */
export function isCustomTimeEnabled() {
    return !!getTimeConfig()?.enabled;
}

/**
 * Open a popup UI for editing game time settings.
 * Uses ST Popup API.
 */
export async function openTimeEditor() {
    const context = SillyTavern.getContext();
    const { Popup, POPUP_TYPE } = context;
    if (!Popup) {
        toastr.error('ST Popup API not available.');
        return;
    }

    const tc = getTimeConfig() || getDefaultTimeConfig();
    // Show the live current time (not stale stored value)
    const displayTime = tc.enabled ? getCurrentTime() : new Date(tc.currentDate || tc.baseDate);

    const html = `
    <div id="textme-time-editor" style="font-size:13px;">
        <h3 style="margin:0 0 12px;">Game Time Settings</h3>

        <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
            <input id="textme-time-enabled" type="checkbox" ${tc.enabled ? 'checked' : ''} />
            <label for="textme-time-enabled" style="font-weight:600;cursor:pointer;">
                Enable custom game time
            </label>
        </div>

        <div class="flex-container flexFlowColumn gap10">
            <label>Current game time:</label>
            <input id="textme-time-current" type="datetime-local" class="text_pole"
                   value="${_toLocalInputValue(displayTime.toISOString())}" />

            <label>Time flow mode:</label>
            <select id="textme-time-flow" class="text_pole">
                <option value="manual"      ${tc.flowMode === 'manual'      ? 'selected' : ''}>Manual only</option>
                <option value="per-message" ${tc.flowMode === 'per-message' ? 'selected' : ''}>Advance per message</option>
                <option value="realtime"    ${tc.flowMode === 'realtime'    ? 'selected' : ''}>Real-time (1:1)</option>
                <option value="accelerated" ${tc.flowMode === 'accelerated' ? 'selected' : ''}>Accelerated</option>
            </select>

            <div id="textme-time-advance-opts" style="${tc.flowMode === 'per-message' ? '' : 'display:none'}">
                <label>Random advance range (minutes):</label>
                <div style="display:flex;align-items:center;gap:8px;margin-top:4px;">
                    <input id="textme-time-adv-min" type="number" class="text_pole"
                           min="0" max="1440" value="${tc.autoAdvanceRange?.min ?? 1}" style="width:80px;" />
                    <span>to</span>
                    <input id="textme-time-adv-max" type="number" class="text_pole"
                           min="0" max="1440" value="${tc.autoAdvanceRange?.max ?? 30}" style="width:80px;" />
                    <span>min</span>
                </div>
            </div>

            <div id="textme-time-accel-opts" style="${tc.flowMode === 'accelerated' ? '' : 'display:none'}">
                <label>Acceleration: <b id="textme-time-accel-val">${tc.accelerationFactor || 10}</b>x</label>
                <input id="textme-time-accel" type="range" min="2" max="100" step="1"
                       value="${tc.accelerationFactor || 10}" />
            </div>

            <hr style="margin:8px 0;" />

            <div style="display:flex;gap:8px;flex-wrap:wrap;">
                <button id="textme-time-jump-1h"  class="menu_button">+1 Hour</button>
                <button id="textme-time-jump-6h"  class="menu_button">+6 Hours</button>
                <button id="textme-time-jump-1d"  class="menu_button">+1 Day</button>
                <button id="textme-time-jump-now" class="menu_button">Set to Now</button>
            </div>
        </div>
    </div>`;

    const popup = new Popup(html, POPUP_TYPE.TEXT, '', {
        okButton:     'Save',
        cancelButton: 'Cancel',
        wide:         false,
    });

    // popup.content is the live DOM container — available immediately after construction,
    // before and after show() resolves. Safer than document.getElementById which relies
    // on global DOM and breaks when the popup is removed.
    const root = popup.content ?? document;
    const $ = (id) => root.querySelector ? root.querySelector(`#${id}`) : document.getElementById(id);

    // Wire up interactivity after the popup is in the DOM
    const wireUp = () => {
        const elFlow    = $('textme-time-flow');
        const advOpts   = $('textme-time-advance-opts');
        const accelOpts = $('textme-time-accel-opts');
        const accelVal  = $('textme-time-accel-val');
        const elAccel   = $('textme-time-accel');
        const elCurrent = $('textme-time-current');

        elFlow?.addEventListener('change', () => {
            if (advOpts)   advOpts.style.display   = elFlow.value === 'per-message' ? '' : 'none';
            if (accelOpts) accelOpts.style.display = elFlow.value === 'accelerated' ? '' : 'none';
        });

        elAccel?.addEventListener('input', () => {
            if (accelVal) accelVal.textContent = elAccel.value;
        });

        const jumpBy = (min) => {
            if (!elCurrent) return;
            const d = new Date(elCurrent.value);
            if (isNaN(d)) return;
            d.setMinutes(d.getMinutes() + min);
            elCurrent.value = _toLocalInputValue(d.toISOString());
        };
        $('textme-time-jump-1h')?.addEventListener('click',  () => jumpBy(60));
        $('textme-time-jump-6h')?.addEventListener('click',  () => jumpBy(360));
        $('textme-time-jump-1d')?.addEventListener('click',  () => jumpBy(1440));
        $('textme-time-jump-now')?.addEventListener('click', () => {
            if (elCurrent) elCurrent.value = _toLocalInputValue(new Date().toISOString());
        });
    };

    // Try popup.content first; fall back to rAF for older ST versions
    if (popup.content) {
        // content is already in DOM by the time Popup constructor returns
        wireUp();
    } else {
        requestAnimationFrame(wireUp);
    }

    const result = await popup.show();

    if (result) {
        // Read from popup.content (still accessible after show() resolves)
        const enabled     = $('textme-time-enabled')?.checked ?? false;
        const currentStr  = $('textme-time-current')?.value;
        const flowMode    = $('textme-time-flow')?.value || 'per-message';
        const advMin      = parseInt($('textme-time-adv-min')?.value, 10) || 1;
        const advMax      = parseInt($('textme-time-adv-max')?.value, 10) || 30;
        const accelFactor = parseInt($('textme-time-accel')?.value,   10) || 10;

        const currentDate = currentStr ? new Date(currentStr).toISOString() : new Date().toISOString();

        // Stop live interval BEFORE building newConfig so getCurrentTime()
        // doesn't keep returning old anchored values
        _clearInterval();

        const newConfig = {
            ...(getTimeConfig() || getDefaultTimeConfig()),
            enabled,
            currentDate,
            baseDate:             tc.baseDate || currentDate,
            flowMode,
            autoAdvanceOnMessage: flowMode === 'per-message',
            autoAdvanceRange:     { min: advMin, max: advMax },
            accelerationFactor:   accelFactor,
        };

        setTimeConfigImmediate(newConfig);
        // Restart interval with the new config
        if (enabled) initCustomTime();

        const modeLabel = { manual: 'manual', 'per-message': 'per-message', realtime: 'real-time sync', accelerated: `accelerated ×${accelFactor}` };
        toastr.success(enabled
            ? `Game time enabled — ${modeLabel[flowMode] || flowMode} mode.`
            : 'Game time disabled — using system clock.');
        log.info('Time config saved:', newConfig);
    }
}

// ─── Internal clock drivers ───────────────────────────────────────────────────

/**
 * Start live time updates (realtime or accelerated).
 * Stores anchor points in module-level vars; getCurrentTime() derives the
 * current value on demand.
 * Persists the live time to chatMetadata every 30 s so a page reload
 * resumes from the correct point instead of reverting to the initial value.
 */
function _startLiveUpdates(tc) {
    _rtStartReal = Date.now();
    _rtStartGame = new Date(tc.currentDate || tc.baseDate).getTime();
    _rtFactor    = tc.flowMode === 'accelerated' ? (tc.accelerationFactor || 10) : 1;

    // Persist live time every 30 s (debounced save) so reloads don't revert.
    realtimeInterval = setInterval(() => {
        const cfg = getTimeConfig();
        if (!cfg?.enabled) return;
        cfg.currentDate = getCurrentTime().toISOString();
        setTimeConfig(cfg);   // debounced — cheap
    }, 30_000);
}

function _clearInterval() {
    if (realtimeInterval !== null) {
        clearInterval(realtimeInterval);
        realtimeInterval = null;
    }
    _rtStartReal = null;
    _rtStartGame = null;
    _rtFactor    = 1;
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function _toLocalInputValue(iso) {
    if (!iso) return '';
    const d   = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
