/**
 * TextMe — Custom Game Time
 * License: AGPL-3.0
 *
 * Adapted from stc/src/features/custom-time.js and stc/src/utils/time-helpers.js.
 *
 * Allows per-chat game time that differs from wall clock:
 *   manual       — only changed explicitly
 *   per-message  — auto-advances random range on each user message
 *   realtime     — 1:1 with real clock (updates status bar every second)
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

import { getPhoneData, savePhoneData } from './state.js';
import { log } from './logger.js';

const TIME_KEY = 'textmeTime';

let realtimeInterval = null;

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
    // Use debounced save — time updates happen frequently
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
 * Falls back to real wall clock if custom time is disabled.
 * @returns {Date}
 */
export function getCurrentTime() {
    const tc = getTimeConfig();
    if (tc?.enabled && tc.currentDate) {
        return new Date(tc.currentDate);
    }
    return new Date();
}

/**
 * Format the current game time for the status bar (HH:MM AM/PM or locale).
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
    stopCustomTime();

    const tc = getTimeConfig();
    if (!tc?.enabled) return;

    if (!tc.currentDate) {
        tc.currentDate = tc.baseDate || new Date().toISOString();
    }

    if (tc.flowMode === 'realtime') {
        _startRealtimeUpdates(tc);
    } else if (tc.flowMode === 'accelerated') {
        _startAcceleratedUpdates(tc);
    }

    log.info(`Custom time initialized: ${tc.flowMode}, current=${tc.currentDate}`);
}

/**
 * Stop realtime/accelerated updates.
 * Persists the current in-memory time to disk before stopping so that
 * realtime/accelerated modes survive page reload or chat switches.
 */
export function stopCustomTime() {
    if (realtimeInterval) {
        // Flush in-memory currentDate to disk before stopping
        const context = SillyTavern.getContext();
        const tc = context.chatMetadata?.[TIME_KEY];
        if (tc?.enabled && tc.currentDate) {
            setTimeConfigImmediate(tc);
        }
        clearInterval(realtimeInterval);
        realtimeInterval = null;
    }
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
    tc.enabled = false;
    setTimeConfig(tc);
    stopCustomTime();
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
                   value="${_toLocalInputValue(tc.currentDate || tc.baseDate)}" />

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

    requestAnimationFrame(() => {
        const flowEl  = document.getElementById('textme-time-flow');
        const advOpts = document.getElementById('textme-time-advance-opts');
        const accelOpts = document.getElementById('textme-time-accel-opts');
        const accelSlider = document.getElementById('textme-time-accel');
        const accelVal    = document.getElementById('textme-time-accel-val');
        const currentInput = document.getElementById('textme-time-current');

        flowEl?.addEventListener('change', () => {
            if (advOpts)   advOpts.style.display   = flowEl.value === 'per-message' ? '' : 'none';
            if (accelOpts) accelOpts.style.display = flowEl.value === 'accelerated' ? '' : 'none';
        });

        accelSlider?.addEventListener('input', () => {
            if (accelVal) accelVal.textContent = accelSlider.value;
        });

        const jumpBy = (min) => {
            if (!currentInput) return;
            const d = new Date(currentInput.value);
            if (isNaN(d)) return;
            d.setMinutes(d.getMinutes() + min);
            currentInput.value = _toLocalInputValue(d.toISOString());
        };
        document.getElementById('textme-time-jump-1h')?.addEventListener('click',  () => jumpBy(60));
        document.getElementById('textme-time-jump-6h')?.addEventListener('click',  () => jumpBy(360));
        document.getElementById('textme-time-jump-1d')?.addEventListener('click',  () => jumpBy(1440));
        document.getElementById('textme-time-jump-now')?.addEventListener('click', () => {
            if (currentInput) currentInput.value = _toLocalInputValue(new Date().toISOString());
        });
    });

    const result = await popup.show();

    if (result) {
        const enabled      = document.getElementById('textme-time-enabled')?.checked ?? false;
        const currentStr   = document.getElementById('textme-time-current')?.value;
        const flowMode     = document.getElementById('textme-time-flow')?.value || 'per-message';
        const advMin       = parseInt(document.getElementById('textme-time-adv-min')?.value, 10) || 1;
        const advMax       = parseInt(document.getElementById('textme-time-adv-max')?.value, 10) || 30;
        const accelFactor  = parseInt(document.getElementById('textme-time-accel')?.value, 10) || 10;

        const currentDate = currentStr ? new Date(currentStr).toISOString() : new Date().toISOString();

        const newConfig = {
            ...(getTimeConfig() || getDefaultTimeConfig()),
            enabled,
            currentDate,
            baseDate:            tc.baseDate || currentDate,
            flowMode,
            autoAdvanceOnMessage: flowMode === 'per-message',
            autoAdvanceRange:    { min: advMin, max: advMax },
            accelerationFactor:  accelFactor,
        };

        setTimeConfigImmediate(newConfig);
        initCustomTime();

        toastr.success(enabled
            ? `Game time ${flowMode} mode enabled.`
            : 'Game time disabled — using real clock.');
        log.info('Time config saved:', newConfig);
    }
}

// ─── Internal clock drivers ───────────────────────────────────────────────────

function _startRealtimeUpdates(tc) {
    const startReal = Date.now();
    const startGame = new Date(tc.currentDate || tc.baseDate).getTime();

    realtimeInterval = setInterval(() => {
        const elapsed = Date.now() - startReal;
        tc.currentDate = new Date(startGame + elapsed).toISOString();
        // don't persist on every tick — just update in-memory
    }, 1000);
}

function _startAcceleratedUpdates(tc) {
    const factor    = tc.accelerationFactor || 10;
    const startReal = Date.now();
    const startGame = new Date(tc.currentDate || tc.baseDate).getTime();

    realtimeInterval = setInterval(() => {
        const elapsed = Date.now() - startReal;
        tc.currentDate = new Date(startGame + elapsed * factor).toISOString();
    }, 1000);
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function _toLocalInputValue(iso) {
    if (!iso) return '';
    const d   = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
