/**
 * TextMe — Phone UI
 * License: AGPL-3.0
 *
 * FIX: renderMessages() and appendMessage() now convert \n → <br> so that
 *      messages saved with internal line-breaks are rendered correctly.
 * FIX: Status dot reflects real schedule on init.
 * FIX: Regenerate deletes the full char-message group and archives cycles.
 * FEAT: Avatar click cycles manual status override.
 * FIX: Initial reply delay reduced to 100 ms.
 *
 * FIX: Generation isolation from ST Stop button.
 *   - Each TextMe generation (send / regenerate) owns its own AbortController
 *     stored in phoneAbortController.
 *   - The signal is forwarded to generatePhoneResponse() → generateRaw().
 *   - While generating, the send button becomes a Cancel button that aborts
 *     ONLY the TextMe request (phoneAbortController.abort()), leaving the
 *     ST main-chat generation untouched.
 *   - If ST's global Stop aborts our request anyway (older ST versions that
 *     don't honour a custom signal), the error is caught and shown as a
 *     neutral 'Cancelled' info toast instead of a red error.
 *
 * FIX: document-level click listener for context-menu dismissal is now stored
 *      as a named reference and removed in destroyPhoneUI() to prevent
 *      memory leaks on repeated chat switches.
 *
 * FIX: destroyPhoneUI() now calls cleanupDragListeners() to remove the
 *      window resize handler from drag.js, preventing listener accumulation.
 *
 * FIX (mobile): Visual Viewport API integration.
 *   Chrome 108+ on Android changed viewport-resize behavior: only the
 *   Visual Viewport shrinks when the virtual keyboard opens; the Layout
 *   Viewport stays the same size. Because `position: fixed` elements anchor
 *   to the Layout Viewport, the input bar was hidden under the keyboard and
 *   under the browser's own chrome (address bar).
 *
 *   setupVisualViewport() subscribes to window.visualViewport "resize" and
 *   "scroll" events on mobile (innerWidth ≤ 500) and writes two CSS custom
 *   properties onto :root:
 *     --textme-vvh     = visualViewport.height   (px)
 *     --textme-vvh-top = visualViewport.offsetTop (px)
 *   The CSS media-query in style.css consumes these vars so the phone element
 *   always fits the truly visible area regardless of keyboard state.
 *   cleanupVisualViewport() removes the listeners in destroyPhoneUI().
 */

import { EXTENSION_NAME, getSettings, getPhoneData, ensurePhoneData, savePhoneData, getCharName, getUserName, hasCharacter, updateSetting } from './state.js';
import { generatePhoneResponse } from './prompt-engine.js';
import { getCurrentStatus, getStatusInfo, cycleManualStatus } from './schedule.js';
import { makeBubbleDraggable, makePhoneDraggable, makePhoneResizable, cleanupDragListeners } from './drag.js';
import { startAutonomousTimer } from './autonomous.js';
import { getFormattedGameTime, getCurrentTime } from './custom-time.js';
import { log } from './logger.js';

let phoneOpen = false;
let isGenerating = false;
let statusTimeInterval = null;

/**
 * AbortController for the currently-running TextMe generation.
 * Replaced on every new send / regenerate call.
 * Calling .abort() cancels TextMe's request without touching ST's chat.
 */
let phoneAbortController = null;

/**
 * Named reference to the document-level click handler used to dismiss the
 * context menu.  Stored here so destroyPhoneUI() can remove it and prevent
 * listener accumulation across chat switches.
 */
let _docClickHandler = null;

// ═══════════════════════════════════════════════
// Visual Viewport API — mobile keyboard fix
// ═══════════════════════════════════════════════

/**
 * Stored handler refs for visualViewport "resize" and "scroll" events.
 * Kept module-level so cleanupVisualViewport() can remove the exact same
 * function references that were registered by setupVisualViewport().
 */
let _vvResizeHandler = null;
let _vvScrollHandler = null;

/**
 * rAF token for the debounce loop — prevents redundant layout recalculations
 * while the keyboard open/close animation is running.
 */
let _vvRAF = null;

/**
 * Write --textme-vvh / --textme-vvh-top CSS variables onto :root so that
 * the mobile media-query in style.css can consume them.
 *
 * Called by setupVisualViewport() on every visualViewport resize/scroll event
 * and also once immediately when the phone UI is initialised.
 *
 * @param {VisualViewport} vv - window.visualViewport reference
 */
function applyVisualViewport(vv) {
    // Round to the nearest integer to avoid sub-pixel jitter.
    const h   = Math.round(vv.height);
    const top = Math.round(vv.offsetTop);
    const root = document.documentElement;
    root.style.setProperty('--textme-vvh',     `${h}px`);
    root.style.setProperty('--textme-vvh-top', `${top}px`);
}

/**
 * Attach Visual Viewport API listeners on mobile.
 *
 * DESKTOP SAFETY: bails immediately when window.innerWidth > 500, so the
 * custom properties are never written and the desktop layout is untouched.
 *
 * BROWSER SUPPORT: visualViewport is available in Chrome 61+, Firefox 91+,
 * Safari 13+. Yandex Browser (Chromium-based) and Termux browsers qualify.
 * When the API is absent, the CSS dvh fallback in style.css is used instead.
 *
 * CLEANUP: listeners are removed by cleanupVisualViewport() which is called
 * inside destroyPhoneUI() on every chat switch / phone disable.
 */
function setupVisualViewport() {
    // Not a mobile viewport or API unavailable — nothing to do.
    if (window.innerWidth > 500 || !window.visualViewport) return;

    const vv = window.visualViewport;

    // Shared handler used for both "resize" and "scroll" events.
    // rAF-debounced: coalesces rapid calls during keyboard animation into
    // one layout update per frame.
    const handler = () => {
        if (_vvRAF) cancelAnimationFrame(_vvRAF);
        _vvRAF = requestAnimationFrame(() => {
            _vvRAF = null;
            // Re-check width inside rAF in case of orientation change.
            if (window.innerWidth > 500) return;
            applyVisualViewport(vv);
        });
    };

    _vvResizeHandler = handler;
    _vvScrollHandler = handler;

    vv.addEventListener('resize', _vvResizeHandler);
    vv.addEventListener('scroll', _vvScrollHandler);

    // Apply immediately so the phone is sized correctly before the first paint.
    applyVisualViewport(vv);

    log.debug('[Mobile] Visual Viewport API attached. Initial vvh:', Math.round(vv.height));
}

/**
 * Remove Visual Viewport API listeners registered by setupVisualViewport().
 * Must be called from destroyPhoneUI() to prevent listener accumulation.
 */
function cleanupVisualViewport() {
    if (!window.visualViewport) return;
    const vv = window.visualViewport;

    if (_vvResizeHandler) {
        vv.removeEventListener('resize', _vvResizeHandler);
        _vvResizeHandler = null;
    }
    if (_vvScrollHandler) {
        vv.removeEventListener('scroll', _vvScrollHandler);
        _vvScrollHandler = null;
    }
    if (_vvRAF) {
        cancelAnimationFrame(_vvRAF);
        _vvRAF = null;
    }

    // Clear the CSS variables so they don't linger after phone is destroyed.
    const root = document.documentElement;
    root.style.removeProperty('--textme-vvh');
    root.style.removeProperty('--textme-vvh-top');
}

// ═══════════════════════════════════════════════
// DOM Creation
// ═══════════════════════════════════════════════

function getCharAvatar() {
    const ctx = SillyTavern.getContext();
    if (ctx.characterId === undefined) return '';
    const char = ctx.characters[ctx.characterId];
    if (!char || !char.avatar) return '';
    return `/characters/${encodeURIComponent(char.avatar)}`;
}

function createPhoneHTML() {
    const charName = getCharName();
    const avatar   = getCharAvatar();
    const settings = getSettings();
    const theme    = settings.theme || 'dark';
    const scheme   = settings.colorScheme || 'default';

    return `
    <div id="textme-phone" class="textme-phone textme-theme-${theme} textme-scheme-${scheme}" style="display:none;">
        <!-- Status Bar -->
        <div class="textme-statusbar">
            <span class="textme-time-display"></span>
            <span class="textme-statusbar-icons">
                <i class="fa-solid fa-signal fa-xs"></i>
                <i class="fa-solid fa-wifi fa-xs"></i>
                <i class="fa-solid fa-battery-full fa-xs"></i>
            </span>
        </div>

        <!-- Header (draggable handle) -->
        <div class="textme-header" id="textme-header">
            <div class="textme-header-back" title="Minimize">
                <i class="fa-solid fa-chevron-left"></i>
            </div>
            <div class="textme-header-avatar" id="textme-header-avatar"
                 title="Click to change status" style="cursor:pointer;">
                ${avatar
                    ? `<img src="${avatar}" alt="" />`
                    : `<div class="textme-avatar-placeholder"><i class="fa-solid fa-user"></i></div>`}
                <span class="textme-status-dot" id="textme-status-dot" title="Status"></span>
            </div>
            <div class="textme-header-info">
                <div class="textme-header-name">${charName}</div>
                <div class="textme-header-status" id="textme-header-status">...</div>
            </div>
            <div class="textme-header-actions">
                <button class="textme-btn-icon textme-btn-clear" title="Clear chat">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
            </div>
        </div>

        <!-- Messages Area -->
        <div class="textme-messages" id="textme-messages">
            <div class="textme-empty-state">
                <i class="fa-regular fa-comment-dots"></i>
                <p>Start a conversation!</p>
            </div>
        </div>

        <!-- Typing Indicator -->
        <div class="textme-typing" id="textme-typing" style="display:none;">
            <div class="textme-typing-bubble">
                <span class="textme-typing-dot"></span>
                <span class="textme-typing-dot"></span>
                <span class="textme-typing-dot"></span>
            </div>
            <span class="textme-typing-text">${charName} is typing...</span>
        </div>

        <!-- Input Bar -->
        <div class="textme-input-bar">
            <textarea id="textme-input" class="textme-input" placeholder="Type a message..." rows="1"></textarea>
            <button id="textme-send" class="textme-btn-send" title="Send (right-click / long-press = silent send)">
                <i class="fa-solid fa-paper-plane"></i>
            </button>
        </div>
    </div>

    <!-- Floating Bubble -->
    <div id="textme-bubble" class="textme-bubble" title="Open TextMe">
        <i class="fa-solid fa-comment-sms"></i>
        <span class="textme-badge" id="textme-badge" style="display:none;">0</span>
    </div>

    <!-- Context Menu -->
    <div id="textme-context-menu" class="textme-context-menu" style="display:none;">
        <div class="textme-ctx-item" data-action="copy"><i class="fa-regular fa-copy"></i> Copy</div>
        <div class="textme-ctx-item" data-action="regenerate"><i class="fa-solid fa-rotate"></i> Regenerate</div>
        <div class="textme-ctx-item" data-action="edit"><i class="fa-solid fa-pen"></i> Edit</div>
        <div class="textme-ctx-item textme-ctx-danger" data-action="delete"><i class="fa-solid fa-trash"></i> Delete</div>
    </div>
    `;
}

// ═══════════════════════════════════════════════
// Message Rendering
// ═══════════════════════════════════════════════

function formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDaySeparator(timestamp) {
    const date      = new Date(timestamp);
    const today     = getCurrentTime();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (date.toDateString() === today.toDateString())     return 'Today';
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return date.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

const GROUP_THRESHOLD_MS = 120_000; // 2 minutes

/**
 * Returns true if msg[i] is the LAST message in its visual group —
 * i.e. the next message is from a different sender or the gap is too large.
 * Time is shown only on the last message of a group.
 */
function isLastInGroup(messages, i) {
    if (i >= messages.length - 1) return true;
    const next = messages[i + 1];
    const cur  = messages[i];
    if (next.isUser !== cur.isUser) return true;
    if ((next.time - cur.time) >= GROUP_THRESHOLD_MS) return true;
    return false;
}

/**
 * Returns true if msg[i] is the FIRST message in its visual group —
 * i.e. the previous message is from a different sender or the gap is too large.
 * Used for border-radius styling (grouped = not first).
 */
function isFirstInGroup(messages, i) {
    if (i === 0) return true;
    const prev = messages[i - 1];
    const cur  = messages[i];
    if (prev.isUser !== cur.isUser) return true;
    if ((cur.time - prev.time) >= GROUP_THRESHOLD_MS) return true;
    return false;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function textToHtml(text) {
    return escapeHtml(text).replace(/\n/g, '<br>');
}

export function renderMessages() {
    const container = document.getElementById('textme-messages');
    if (!container) return;

    const phoneData = getPhoneData();
    const settings  = getSettings();

    if (!phoneData || phoneData.messages.length === 0) {
        container.innerHTML = `
            <div class="textme-empty-state">
                <i class="fa-regular fa-comment-dots"></i>
                <p>Start a conversation!</p>
            </div>`;
        return;
    }

    const msgs = phoneData.messages;
    let html    = '';
    let lastDay = '';

    for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i];
        const day = new Date(msg.time).toDateString();

        if (day !== lastDay) {
            html += `<div class="textme-day-sep">${formatDaySeparator(msg.time)}</div>`;
            lastDay = day;
        }

        const first   = isFirstInGroup(msgs, i);
        const last    = isLastInGroup(msgs, i);
        const side    = msg.isUser ? 'user' : 'char';
        const grouped = first ? '' : 'textme-grouped';

        // Time shown only on the last message of a group
        const timeHtml = settings.showTimestamps && last
            ? `<span class="textme-msg-time">${formatTime(msg.time)}</span>`
            : '';

        const cyclesHtml = msg._prevCycles?.length
            ? `<span class="textme-cycles-indicator" data-idx="${i}" title="${msg._prevCycles.length} previous version(s)">↻${msg._prevCycles.length}</span>`
            : '';

        const receiptHtml = readReceiptHtml(msgs, i, settings);

        const bubbleContent = msg.type === 'image'
            ? `<img src="${escapeHtml(msg.src)}" class="textme-msg-image" alt="image" />`
            : textToHtml(msg.text);

        html += `
            <div class="textme-msg textme-msg-${side} ${grouped}" data-idx="${i}">
                <div class="textme-bubble-wrap">
                    <div class="textme-bubble-content">${bubbleContent}</div>
                    ${timeHtml}${cyclesHtml}${receiptHtml}
                </div>
            </div>`;
    }

    container.innerHTML = html;
    scrollToBottom();
}

function scrollToBottom() {
    const container = document.getElementById('textme-messages');
    if (container) {
        requestAnimationFrame(() => {
            container.scrollTop = container.scrollHeight;
        });
    }
}

function appendMessage(msg, index) {
    const container = document.getElementById('textme-messages');
    if (!container) return;

    const empty = container.querySelector('.textme-empty-state');
    if (empty) empty.remove();

    const settings  = getSettings();
    const phoneData = getPhoneData();
    const msgs      = phoneData.messages;
    const side      = msg.isUser ? 'user' : 'char';

    const first    = isFirstInGroup(msgs, index);
    const last     = isLastInGroup(msgs, index);  // always true for a freshly appended msg

    // If prev message is from same sender and now becomes non-last, hide its timestamp
    if (!first) {
        const prevIdx = index - 1;
        const prevEl  = container.querySelector(`.textme-msg[data-idx="${prevIdx}"]`);
        if (prevEl) {
            const prevTime = prevEl.querySelector('.textme-msg-time');
            if (prevTime) prevTime.remove();
        }
    }

    // If a char message just arrived, strip the Delivered receipt from the last user bubble
    if (!msg.isUser) {
        const prevUserIdx = lastUserMsgIndex(msgs.slice(0, index));
        if (prevUserIdx >= 0) {
            const prevUserEl = container.querySelector(`.textme-msg[data-idx="${prevUserIdx}"] .textme-read-receipt`);
            if (prevUserEl) prevUserEl.remove();
        }
    }

    const timeHtml    = settings.showTimestamps && last
        ? `<span class="textme-msg-time">${formatTime(msg.time)}</span>`
        : '';
    const receiptHtml = readReceiptHtml(msgs, index, settings);

    const div = document.createElement('div');
    div.className   = `textme-msg textme-msg-${side}${first ? '' : ' textme-grouped'}`;
    div.dataset.idx = index;

    const bubbleContent = msg.type === 'image'
        ? `<img src="${escapeHtml(msg.src)}" class="textme-msg-image" alt="image" />`
        : textToHtml(msg.text);

    div.innerHTML = `
        <div class="textme-bubble-wrap">
            <div class="textme-bubble-content">${bubbleContent}</div>
            ${timeHtml}${receiptHtml}
        </div>`;

    container.appendChild(div);
    scrollToBottom();
}

// ═══════════════════════════════════════════════
// Typing Indicator
// ═══════════════════════════════════════════════

function showTyping() {
    const el = document.getElementById('textme-typing');
    if (el) el.style.display = 'flex';
    scrollToBottom();
}

function hideTyping() {
    const el = document.getElementById('textme-typing');
    if (el) el.style.display = 'none';
}

// ═══════════════════════════════════════════════
// Streaming Messages
// ═══════════════════════════════════════════════

async function streamMessages(messageParts, phoneData) {
    for (let i = 0; i < messageParts.length; i++) {
        const text = messageParts[i];

        if (i > 0) {
            showTyping();
            const delay = Math.min(600 + text.length * 20, 2000) + Math.random() * 500;
            await sleep(delay);
        }

        hideTyping();

        const charMsg = { isUser: false, text, time: getCurrentTime().getTime() };
        phoneData.messages.push(charMsg);
        appendMessage(charMsg, phoneData.messages.length - 1);

        if (i < messageParts.length - 1) {
            await sleep(200);
        }
    }

    phoneData.lastActivity   = Date.now();
    phoneData.autonomousCount = 0;
    await savePhoneData();
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════════
// Abort helper
// ═══════════════════════════════════════════════

/**
 * Returns true when an error came from a cancellation/abort —
 * either our own phoneAbortController or ST's global stop event.
 */
function isCancelError(err) {
    if (!err) return false;
    if (err.name === 'AbortError') return true;
    const msg = (err.message || '').toLowerCase();
    return msg.includes('cancel') || msg.includes('abort') || msg.includes('stop');
}

// ═══════════════════════════════════════════════
// Send Message
// ═══════════════════════════════════════════════

/**
 * Returns true if the last user message has no character reply after it.
 * Used to decide whether to show read receipts.
 */
function isLastUserMsgUnanswered(messages) {
    if (!messages?.length) return false;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (!messages[i].isUser) return false; // char replied after
        if (messages[i].isUser) return true;   // user msg is last
    }
    return false;
}

/**
 * Returns the index of the last user message, or -1.
 */
function lastUserMsgIndex(messages) {
    if (!messages?.length) return -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].isUser) return i;
    }
    return -1;
}

/**
 * Build read receipt HTML for a user message at index i.
 * Shows only on the last user message when no char reply follows.
 * State: 'delivered' while generating, 'read' after char replies.
 */
function readReceiptHtml(messages, index, settings) {
    if (!settings.readReceipts) return '';
    if (!messages[index]?.isUser) return '';

    // Only the last user message gets a receipt
    if (index !== lastUserMsgIndex(messages)) return '';

    // Hide if a char message exists after this user message
    for (let j = index + 1; j < messages.length; j++) {
        if (!messages[j].isUser) return '';
    }

    // Still waiting for reply — show "Delivered"
    return `<div class="textme-read-receipt textme-receipt-delivered">
        <span class="textme-receipt-ticks"></span>
        <span class="textme-receipt-label">Delivered</span>
    </div>`;
}

async function handleSend() {
    // While generating, the button acts as Cancel for TextMe only
    if (isGenerating) {
        if (phoneAbortController) {
            phoneAbortController.abort();
            log.info('TextMe generation cancelled by user.');
        }
        return;
    }

    const input = document.getElementById('textme-input');
    if (!input) {
        log.error('Input element not found!');
        return;
    }

    const text = input.value.trim();
    if (!text) return;

    try {
        const { status } = getCurrentStatus();
        if (status === 'offline') {
            const statusEl = document.getElementById('textme-header-status');
            if (statusEl) statusEl.textContent = 'Offline — not available';
            toastr.warning(`${getCharName()} is offline and can't respond right now.`);
            return;
        }
    } catch (e) {
        log.warn('Could not check schedule status:', e);
    }

    log.info('Sending message:', text.substring(0, 50) + (text.length > 50 ? '...' : ''));

    input.value = '';
    autoResizeInput();

    const phoneData = ensurePhoneData();

    const userMsg = { isUser: true, text, time: getCurrentTime().getTime() };
    phoneData.messages.push(userMsg);
    phoneData.lastActivity   = Date.now();
    phoneData.autonomousCount = 0;
    appendMessage(userMsg, phoneData.messages.length - 1);
    await savePhoneData();

    // Create a fresh AbortController for this TextMe request.
    // Aborting it cancels only our generateRaw call, not ST's main chat.
    phoneAbortController = new AbortController();

    isGenerating = true;
    showTyping();
    updateSendButton();

    try {
        const parts = await generatePhoneResponse(phoneAbortController.signal);
        log.info('Got response parts:', parts.length);

        await sleep(100);

        hideTyping();
        await streamMessages(parts, phoneData);

    } catch (err) {
        hideTyping();
        if (isCancelError(err)) {
            log.info('TextMe generation cancelled.');
            toastr.info('TextMe: Cancelled', '', { timeOut: 1500 });
        } else {
            log.error('Generation error:', err);
            toastr.error(`TextMe: ${err.message || 'Generation failed'}`);
        }
    } finally {
        isGenerating = false;
        phoneAbortController = null;
        hideTyping();
        updateSendButton();
    }
}

/**
 * Silent send — saves user message and shows it in UI, but does NOT trigger
 * character generation. Activated via right-click or long-press on the send button.
 */
async function handleSilentSend() {
    if (isGenerating) return;

    const input = document.getElementById('textme-input');
    if (!input) return;

    const text = input.value.trim();
    if (!text) return;

    log.info('Silent send:', text.substring(0, 50) + (text.length > 50 ? '...' : ''));

    input.value = '';
    autoResizeInput();

    const phoneData = ensurePhoneData();
    const userMsg = { isUser: true, text, time: getCurrentTime().getTime(), silent: true };
    phoneData.messages.push(userMsg);
    phoneData.lastActivity   = Date.now();
    phoneData.autonomousCount = 0;
    appendMessage(userMsg, phoneData.messages.length - 1);
    await savePhoneData();

    toastr.info('Sent silently', '', { timeOut: 1200 });
}

function updateSendButton() {
    const btn = document.getElementById('textme-send');
    if (!btn) return;
    if (isGenerating) {
        // Show stop icon — clicking will abort TextMe generation only
        btn.disabled = false;
        btn.title = 'Cancel TextMe generation';
        btn.innerHTML = '<i class="fa-solid fa-stop"></i>';
    } else {
        btn.disabled = false;
        btn.title = 'Send';
        btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i>';
    }
}

// ═══════════════════════════════════════════════
// Input Auto-resize
// ═══════════════════════════════════════════════

function autoResizeInput() {
    const input = document.getElementById('textme-input');
    if (!input) return;
    input.style.height = 'auto';
    const newH = Math.min(input.scrollHeight, 100);
    input.style.height = newH + 'px';
    input.style.overflowY = newH >= 100 ? 'auto' : 'hidden';
}

// ═══════════════════════════════════════════════
// Context Menu
// ═══════════════════════════════════════════════

let contextMenuTarget = null;

function showContextMenu(e, msgEl) {
    e.preventDefault();
    const menu = document.getElementById('textme-context-menu');
    if (!menu) return;

    contextMenuTarget = msgEl;
    const idx       = parseInt(msgEl.dataset.idx, 10);
    const phoneData  = getPhoneData();
    const msg        = phoneData?.messages[idx];

    const regenItem = menu.querySelector('[data-action="regenerate"]');
    if (regenItem) {
        regenItem.style.display = msg && !msg.isUser ? '' : 'none';
    }

    menu.style.display = 'block';
    menu.style.left    = e.clientX + 'px';
    menu.style.top     = e.clientY + 'px';

    const rect = menu.getBoundingClientRect();
    if (rect.right  > window.innerWidth)  menu.style.left = (window.innerWidth  - rect.width  - 5) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top  = (window.innerHeight - rect.height - 5) + 'px';
}

function hideContextMenu() {
    const menu = document.getElementById('textme-context-menu');
    if (menu) menu.style.display = 'none';
    contextMenuTarget = null;
}

async function handleContextAction(action) {
    if (!contextMenuTarget) return;

    const idx       = parseInt(contextMenuTarget.dataset.idx, 10);
    const phoneData  = getPhoneData();
    if (!phoneData || idx < 0 || idx >= phoneData.messages.length) return;

    const msg = phoneData.messages[idx];

    switch (action) {
        case 'copy':
            try {
                await navigator.clipboard.writeText(msg.text || '');
                toastr.success('Copied to clipboard');
            } catch {
                toastr.error('Failed to copy');
            }
            break;

        case 'delete':
            phoneData.messages.splice(idx, 1);
            await savePhoneData();
            renderMessages();
            break;

        case 'edit': {
            const newText = prompt('Edit message:', msg.text);
            if (newText !== null && newText.trim() !== '') {
                phoneData.messages[idx].text = newText.trim();
                await savePhoneData();
                renderMessages();
            }
            break;
        }

        case 'regenerate':
            if (msg.isUser) break;
            {
                let lastUserIdx = -1;
                for (let i = idx - 1; i >= 0; i--) {
                    if (phoneData.messages[i]?.isUser) {
                        lastUserIdx = i;
                        break;
                    }
                }

                const lastUserMsg = lastUserIdx >= 0 ? phoneData.messages[lastUserIdx].text : '';

                const groupStart = lastUserIdx + 1;
                const charGroup  = phoneData.messages.slice(groupStart);
                const prevTexts  = charGroup.filter(m => !m.isUser).map(m => m.text);

                phoneData.messages.splice(groupStart, phoneData.messages.length - groupStart);

                if (lastUserIdx >= 0 && prevTexts.length > 0) {
                    const userMsg = phoneData.messages[lastUserIdx];
                    if (!userMsg._prevCycles) userMsg._prevCycles = [];
                    userMsg._prevCycles.push({ texts: prevTexts, time: Date.now() });
                }

                await savePhoneData();
                renderMessages();

                if (lastUserMsg) {
                    phoneAbortController = new AbortController();
                    isGenerating = true;
                    showTyping();
                    updateSendButton();
                    try {
                        const parts = await generatePhoneResponse(phoneAbortController.signal);
                        hideTyping();
                        await streamMessages(parts, phoneData);
                    } catch (err) {
                        hideTyping();
                        if (isCancelError(err)) {
                            log.info('TextMe regeneration cancelled.');
                            toastr.info('TextMe: Cancelled', '', { timeOut: 1500 });
                        } else {
                            toastr.error(`Regeneration failed: ${err.message}`);
                        }
                    } finally {
                        isGenerating = false;
                        phoneAbortController = null;
                        hideTyping();
                        updateSendButton();
                    }
                }
            }
            break;
    }

    hideContextMenu();
}

// ═══════════════════════════════════════════════
// Phone Toggle
// ═══════════════════════════════════════════════

export function minimizePhone() {
    const phone  = document.getElementById('textme-phone');
    if (phone) phone.style.display = 'none';

    const bubble = document.getElementById('textme-bubble');
    if (bubble) bubble.style.display = 'flex';

    phoneOpen = false;
}

export function closePhone() {
    const phone  = document.getElementById('textme-phone');
    if (phone) phone.style.display = 'none';

    const bubble = document.getElementById('textme-bubble');
    if (bubble) bubble.style.display = 'none';

    phoneOpen = false;
    log.info('Phone closed (bubble hidden). Use /phone or settings to reopen.');
}

export function togglePhone() {
    const phone  = document.getElementById('textme-phone');
    const bubble = document.getElementById('textme-bubble');

    if (!phone) return;

    if (bubble && bubble.style.display === 'none') {
        bubble.style.display = 'flex';
    }

    phoneOpen = !phoneOpen;
    phone.style.display = phoneOpen ? 'flex' : 'none';

    if (phoneOpen) {
        renderMessages();
        updatePhoneHeader();
        updateStatusBarTime();
        clearBadge();

        setTimeout(() => {
            const input = document.getElementById('textme-input');
            if (input) input.focus();
        }, 100);
    }
}

export function openPhone() {
    if (!phoneOpen) togglePhone();
}

function updatePhoneHeader() {
    const nameEl = document.querySelector('.textme-header-name');
    if (nameEl) nameEl.textContent = getCharName();

    const avatar    = getCharAvatar();
    const avatarEl  = document.querySelector('.textme-header-avatar');
    if (avatarEl && avatar) {
        const img = avatarEl.querySelector('img');
        if (img) {
            img.src = avatar;
        } else {
            const dot = avatarEl.querySelector('.textme-status-dot');
            const dotHtml = dot ? dot.outerHTML : '<span class="textme-status-dot" id="textme-status-dot"></span>';
            avatarEl.innerHTML = `<img src="${avatar}" alt="" />${dotHtml}`;
        }
    }

    const typingText = document.querySelector('.textme-typing-text');
    if (typingText) typingText.textContent = `${getCharName()} is typing...`;

    updateStatusDisplay();
}

export function updateStatusDisplay() {
    try {
        const { status, activity, isManual } = getCurrentStatus();
        const { label, cssClass }  = getStatusInfo(status);

        const dot = document.getElementById('textme-status-dot');
        if (dot) {
            dot.className = `textme-status-dot ${cssClass}`;
            dot.title     = isManual ? `${label} (manual — click avatar to change)` : label;
        }

        const statusText = document.getElementById('textme-header-status');
        if (statusText) {
            let text = activity ? `${label} — ${activity}` : label;
            if (isManual) text += ' ✱';
            statusText.textContent = text;
        }
    } catch (e) {
        log.warn('Could not update status display:', e);
    }
}

function updateStatusBarTime() {
    const el = document.querySelector('.textme-time-display');
    if (el) {
        el.textContent = getFormattedGameTime();
    }
}

// ═══════════════════════════════════════════════
// Clear Chat
// ═══════════════════════════════════════════════

export async function clearPhoneChat() {
    const phoneData = getPhoneData();
    if (!phoneData) return;

    if (!confirm('Clear all phone messages?')) return;

    phoneData.messages       = [];
    phoneData.lastActivity   = null;
    phoneData.autonomousCount = 0;
    await savePhoneData();
    renderMessages();
    toastr.success('Phone chat cleared');
}

// ═══════════════════════════════════════════════
// Init / Destroy
// ═══════════════════════════════════════════════

export function initPhoneUI() {
    destroyPhoneUI();

    if (!hasCharacter()) {
        log.warn('No character selected, skipping phone UI init.');
        return;
    }

    log.info('Initializing Phone UI for', getCharName());

    ensurePhoneData();

    const wrapper = document.createElement('div');
    wrapper.id    = 'textme-container';
    wrapper.innerHTML = createPhoneHTML();
    document.body.appendChild(wrapper);

    applyPhonePosition();

    updatePhoneHeader();
    updateStatusBarTime();

    const phone  = document.getElementById('textme-phone');
    const header = document.getElementById('textme-header');
    const bubble = document.getElementById('textme-bubble');

    makePhoneDraggable(phone, header);
    makePhoneResizable(phone);
    makeBubbleDraggable(bubble);

    // ── Visual Viewport API (mobile keyboard fix) ──────────────────────
    // Must be called AFTER the phone element is in the DOM so the initial
    // applyVisualViewport() call can target the correct element via CSS vars.
    setupVisualViewport();

    bubble?.addEventListener('click', togglePhone);

    document.querySelector('.textme-header-back')?.addEventListener('click', minimizePhone);

    document.getElementById('textme-header-avatar')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        const newStatus = await cycleManualStatus();
        updateStatusDisplay();
        const { label } = getStatusInfo(newStatus || 'online');
        const msg = newStatus
            ? `Status overridden: ${label} ✱`
            : 'Status back to schedule';
        toastr.info(msg, '', { timeOut: 1500 });
    });

    document.querySelector('.textme-btn-clear')?.addEventListener('click', clearPhoneChat);

    // Left-click / tap → normal send (with generation)
    document.getElementById('textme-send')?.addEventListener('click', handleSend);

    // Right-click → silent send (no generation)
    document.getElementById('textme-send')?.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        handleSilentSend();
    });

    // Long-press (mobile) → silent send
    let _longPressTimer = null;
    const sendBtn = document.getElementById('textme-send');
    if (sendBtn) {
        sendBtn.addEventListener('touchstart', (e) => {
            _longPressTimer = setTimeout(() => {
                _longPressTimer = null;
                e.preventDefault();
                handleSilentSend();
            }, 500);
        }, { passive: false });
        sendBtn.addEventListener('touchend', () => {
            if (_longPressTimer) {
                clearTimeout(_longPressTimer);
                _longPressTimer = null;
            }
        });
        sendBtn.addEventListener('touchmove', () => {
            if (_longPressTimer) {
                clearTimeout(_longPressTimer);
                _longPressTimer = null;
            }
        });
    }

    const input = document.getElementById('textme-input');
    if (input) {
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
            }
        });
        input.addEventListener('input', autoResizeInput);

        // Mobile: hint browser to keep the textarea visible when keyboard opens.
        // scrollIntoView with 'nearest' avoids aggressive scroll-jumps on desktop.
        input.addEventListener('focus', () => {
            if (window.innerWidth <= 500) {
                // Small delay so the keyboard is already animating when we scroll.
                setTimeout(() => {
                    input.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                }, 150);
            }
        });
    }

    document.getElementById('textme-messages')?.addEventListener('contextmenu', (e) => {
        const msgEl = e.target.closest('.textme-msg');
        if (msgEl) showContextMenu(e, msgEl);
    });

    let longPressTimer = null;
    document.getElementById('textme-messages')?.addEventListener('touchstart', (e) => {
        const msgEl = e.target.closest('.textme-msg');
        if (!msgEl) return;
        longPressTimer = setTimeout(() => {
            const touch = e.touches[0];
            showContextMenu(
                { preventDefault: () => {}, clientX: touch.clientX, clientY: touch.clientY },
                msgEl
            );
        }, 500);
    });
    document.getElementById('textme-messages')?.addEventListener('touchend', () => {
        if (longPressTimer) clearTimeout(longPressTimer);
    });

    document.getElementById('textme-context-menu')?.addEventListener('click', (e) => {
        const item = e.target.closest('.textme-ctx-item');
        if (item) handleContextAction(item.dataset.action);
    });

    // FIX: Use a named handler so we can remove it in destroyPhoneUI()
    _docClickHandler = (e) => {
        if (!e.target.closest('#textme-context-menu')) hideContextMenu();
    };
    document.addEventListener('click', _docClickHandler);

    updateStatusBarTime();
    statusTimeInterval = setInterval(updateStatusBarTime, 60000);

    const settings = getSettings();
    if (settings.enabled && settings.autonomousEnabled) {
        startAutonomousTimer();
    }

    phoneOpen = false;
}

function applyPhonePosition() {
    const phone    = document.getElementById('textme-phone');
    if (!phone) return;

    const settings = getSettings();
    phone.classList.remove('textme-pos-left', 'textme-pos-right', 'textme-pos-center', 'textme-pos-floating');
    phone.classList.add(`textme-pos-${settings.phonePosition || 'right'}`);

    phone.classList.remove('textme-size-normal', 'textme-size-large', 'textme-size-fullscreen');
    phone.classList.add(`textme-size-${settings.phoneSize || 'normal'}`);
}

export function destroyPhoneUI() {
    const container = document.getElementById('textme-container');
    if (container) container.remove();

    if (statusTimeInterval) {
        clearInterval(statusTimeInterval);
        statusTimeInterval = null;
    }

    // Abort any in-flight TextMe generation when the UI is destroyed
    if (phoneAbortController) {
        phoneAbortController.abort();
        phoneAbortController = null;
    }

    // FIX: Remove document-level click handler to prevent listener accumulation
    if (_docClickHandler) {
        document.removeEventListener('click', _docClickHandler);
        _docClickHandler = null;
    }

    // FIX: Remove window resize handler from drag.js
    cleanupDragListeners();

    // FIX: Remove Visual Viewport API listeners and clear CSS vars
    cleanupVisualViewport();

    phoneOpen    = false;
    isGenerating = false;
}

export function reloadPhoneData() {
    if (phoneOpen) {
        renderMessages();
        updatePhoneHeader();
    }
}

export function isPhoneOpen() {
    return phoneOpen;
}

export async function addExternalMessages(parts) {
    const phoneData = ensurePhoneData();

    showTyping();

    for (let i = 0; i < parts.length; i++) {
        const delay = 600 + Math.random() * 1200;
        await sleep(delay);

        hideTyping();

        const msg = { isUser: false, text: parts[i], time: getCurrentTime().getTime() };
        phoneData.messages.push(msg);
        appendMessage(msg, phoneData.messages.length - 1);

        if (i < parts.length - 1) {
            showTyping();
            await sleep(300);
        }
    }

    phoneData.lastActivity = Date.now();
    await savePhoneData();
    hideTyping();

    if (!phoneOpen) {
        updateBadge(parts.length);
    }
}

function updateBadge(count) {
    const badge = document.getElementById('textme-badge');
    if (!badge) return;

    const current  = parseInt(badge.textContent || '0', 10);
    const newCount = current + count;
    if (newCount > 0) {
        badge.textContent = newCount > 99 ? '99+' : String(newCount);
        badge.style.display = 'flex';
    } else {
        badge.style.display = 'none';
    }
}

export function clearBadge() {
    const badge = document.getElementById('textme-badge');
    if (badge) {
        badge.textContent    = '0';
        badge.style.display  = 'none';
    }
}
