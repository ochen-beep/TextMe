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

import { EXTENSION_NAME, getSettings, getPhoneData, ensurePhoneData, savePhoneData, getCharName, getUserName, hasCharacter, updateSetting, getContactData, setContactData } from './state.js';
import { generatePhoneResponse, parseReplyQuote } from './prompt-engine.js';
import { getCurrentStatus, getStatusInfo, cycleManualStatus } from './schedule.js';
import { makeBubbleDraggable, makePhoneDraggable, makePhoneResizable, cleanupDragListeners } from './drag.js';
import { startAutonomousTimer, stopAutonomousTimer, resetAutonomousWait } from './autonomous.js';
import { initNotifications, playNotificationSound } from './notifications.js';
import { getFormattedGameTime, getCurrentTime } from './custom-time.js';
import { updateRpInjection, clearRpInjection } from './rp-inject.js';
import { log } from './logger.js';

let phoneOpen = false;
let isGenerating = false;
let statusTimeInterval = null;

/**
 * Currently active reply-to reference. Set when user swipes or hovers a bubble.
 * { index: number, isUser: boolean, text: string } | null
 */
let pendingReply = null;

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

let _vvResizeHandler = null;
let _vvScrollHandler = null;
let _vvRAF = null;

function applyVisualViewport(vv) {
    const h   = Math.round(vv.height);
    const top = Math.round(vv.offsetTop);
    const root = document.documentElement;
    root.style.setProperty('--textme-vvh',     `${h}px`);
    root.style.setProperty('--textme-vvh-top', `${top}px`);
}

function setupVisualViewport() {
    if (window.innerWidth > 500 || !window.visualViewport) return;
    const vv = window.visualViewport;
    const handler = () => {
        if (_vvRAF) cancelAnimationFrame(_vvRAF);
        _vvRAF = requestAnimationFrame(() => {
            _vvRAF = null;
            if (window.innerWidth > 500) return;
            applyVisualViewport(vv);
        });
    };
    _vvResizeHandler = handler;
    _vvScrollHandler = handler;
    vv.addEventListener('resize', _vvResizeHandler);
    vv.addEventListener('scroll', _vvScrollHandler);
    applyVisualViewport(vv);
    log.debug('[Mobile] Visual Viewport API attached. Initial vvh:', Math.round(vv.height));
}

function cleanupVisualViewport() {
    if (!window.visualViewport) return;
    const vv = window.visualViewport;
    if (_vvResizeHandler) { vv.removeEventListener('resize', _vvResizeHandler); _vvResizeHandler = null; }
    if (_vvScrollHandler) { vv.removeEventListener('scroll', _vvScrollHandler); _vvScrollHandler = null; }
    if (_vvRAF) { cancelAnimationFrame(_vvRAF); _vvRAF = null; }
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
                <div class="textme-header-name-row">
                    <div class="textme-header-name">${charName}</div>
                    <button class="textme-btn-edit-contact" title="Edit contact" id="textme-btn-edit-contact">
                        <i class="fa-solid fa-pen"></i>
                    </button>
                </div>
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

        <!-- Reply Bar (shown when reply mode is active) -->
        <div id="textme-reply-bar" class="textme-reply-bar" style="display:none;"></div>

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

    <!-- Contact Edit Modal -->
    <div id="textme-contact-modal" class="textme-contact-modal" style="display:none;">
        <div class="textme-contact-modal-box">
            <div class="textme-contact-modal-title">Edit Contact</div>
            <div class="textme-contact-scope-row">
                <span class="textme-contact-scope-label">Save for</span>
                <div class="textme-contact-scope-toggle" id="textme-contact-scope-toggle">
                    <button class="textme-scope-btn" data-scope="chat">This chat</button>
                    <button class="textme-scope-btn" data-scope="character">All chats</button>
                </div>
            </div>
            <div class="textme-contact-modal-avatar-preview" id="textme-contact-preview-wrap">
                <div id="textme-contact-modal-avatar" class="textme-contact-modal-avatar-img"></div>
            </div>
            <div id="textme-contact-crop-wrap" class="textme-contact-crop-wrap" style="display:none;">
                <canvas id="textme-contact-crop-canvas" class="textme-contact-crop-canvas"></canvas>
                <div class="textme-contact-crop-hint">Drag to pan · Scroll to zoom</div>
            </div>
            <div class="textme-contact-modal-field">
                <label>Display name</label>
                <input id="textme-contact-name-input" type="text" placeholder="Leave empty to use character name" />
            </div>
            <div class="textme-contact-modal-field">
                <label>Avatar URL</label>
                <input id="textme-contact-url-input" type="text" placeholder="https://..." />
            </div>
            <div class="textme-contact-modal-field">
                <label>Upload image</label>
                <label class="textme-contact-file-label">
                    <i class="fa-solid fa-upload"></i> Choose image
                    <input id="textme-contact-file-input" type="file" accept="image/*" style="display:none;" />
                </label>
            </div>
            <div class="textme-contact-modal-actions">
                <button id="textme-contact-reset-btn" class="textme-contact-btn textme-contact-btn-danger">
                    <i class="fa-solid fa-rotate-left"></i> Reset
                </button>
                <div class="textme-contact-modal-actions-right">
                    <button id="textme-contact-cancel-btn" class="textme-contact-btn textme-contact-btn-ghost">Cancel</button>
                    <button id="textme-contact-save-btn" class="textme-contact-btn textme-contact-btn-primary">Save</button>
                </div>
            </div>
        </div>
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

const GROUP_THRESHOLD_MS = 120_000;

function isLastInGroup(messages, i) {
    if (i >= messages.length - 1) return true;
    const next = messages[i + 1];
    const cur  = messages[i];
    if (next.isUser !== cur.isUser) return true;
    if ((next.time - cur.time) >= GROUP_THRESHOLD_MS) return true;
    return false;
}

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

// ═══════════════════════════════════════════════
// Reply-to helpers
// ═══════════════════════════════════════════════

function replyQuoteHtml(replyTo, charName, userName) {
    if (!replyTo) return '';
    const MAX = 80;
    const snippet = (replyTo.text || '').trim();
    const preview = snippet.length > MAX ? snippet.substring(0, MAX) + '…' : snippet;
    const sender  = replyTo.isUser ? userName : charName;
    return `<div class="textme-reply-quote" data-reply-idx="${replyTo.index}">
        <span class="textme-reply-quote-name">${escapeHtml(sender)}</span>
        <span class="textme-reply-quote-text">${escapeHtml(preview)}</span>
    </div>`;
}

function setPendingReply(index) {
    const phoneData = getPhoneData();
    if (!phoneData) return;
    const msg = phoneData.messages[index];
    if (!msg) return;
    pendingReply = { index, isUser: msg.isUser, text: msg.text || '' };
    _updateReplyBar();
    document.getElementById('textme-input')?.focus();
}

function clearPendingReply() {
    pendingReply = null;
    _updateReplyBar();
}

function _updateReplyBar() {
    const bar = document.getElementById('textme-reply-bar');
    if (!bar) return;
    if (!pendingReply) {
        bar.style.display = 'none';
        bar.innerHTML = '';
        return;
    }
    const { name: _contactName } = getContactData();
    const charName = _contactName || getCharName();
    const userName = getUserName();
    const sender   = pendingReply.isUser ? userName : charName;
    const MAX      = 60;
    const preview  = (pendingReply.text || '').trim();
    const snippet  = preview.length > MAX ? preview.substring(0, MAX) + '…' : preview;
    bar.style.display = 'flex';
    bar.innerHTML = `
        <div class="textme-reply-bar-accent"></div>
        <div class="textme-reply-bar-body">
            <span class="textme-reply-bar-name">${escapeHtml(sender)}</span>
            <span class="textme-reply-bar-text">${escapeHtml(snippet)}</span>
        </div>
        <button class="textme-reply-bar-close" id="textme-reply-bar-close" title="Cancel reply">✕</button>`;
    document.getElementById('textme-reply-bar-close')?.addEventListener('click', clearPendingReply);
}

function scrollToMessage(index) {
    const container = document.getElementById('textme-messages');
    if (!container) return;
    const el = container.querySelector(`.textme-msg[data-idx="${index}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('textme-msg-flash');
    setTimeout(() => el.classList.remove('textme-msg-flash'), 1200);
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
    const msgs     = phoneData.messages;
    const { name: _contactName } = getContactData();
    const charName = _contactName || getCharName();
    const userName = getUserName();
    let html    = '';
    let lastDay = '';
    let pendingOrphanQuote = null;
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
        const timeHtml = settings.showTimestamps && last
            ? `<span class="textme-msg-time">${formatTime(msg.time)}</span>`
            : '';
        const cyclesHtml = msg._prevCycles?.length
            ? `<span class="textme-cycles-indicator" data-idx="${i}" title="${msg._prevCycles.length} previous version(s)">↻${msg._prevCycles.length}</span>`
            : '';
        const receiptHtml = readReceiptHtml(msgs, i, settings);
        let displayText = msg.text;
        let displayReplyTo = msg.replyTo;
        if (!msg.isUser && !msg.replyTo && msg.text?.startsWith('>')) {
            const parsed = parseReplyQuote(msg.text, msgs);
            if (parsed.text !== msg.text) {
                displayText    = parsed.text;
                displayReplyTo = parsed.replyTo;
            } else {
                const quoteSnippet = msg.text.replace(/^>\s?/gm, '').trim();
                const needle = quoteSnippet.toLowerCase();
                const prefix = needle.substring(0, 30);
                let found = null;
                for (let j = i - 1; j >= 0; j--) {
                    const m = msgs[j];
                    if (m.type === 'image' || !m.text || m.text.startsWith('>')) continue;
                    const hay = m.text.toLowerCase();
                    if (hay.includes(needle) || (prefix && hay.startsWith(prefix))) {
                        found = { index: j, isUser: m.isUser, text: m.text };
                        break;
                    }
                }
                pendingOrphanQuote = found || { index: -1, isUser: false, text: quoteSnippet };
                continue;
            }
        }
        if (!msg.isUser && !displayReplyTo && pendingOrphanQuote) {
            displayReplyTo     = pendingOrphanQuote;
            pendingOrphanQuote = null;
        } else if (!msg.isUser) {
            pendingOrphanQuote = null;
        }
        const quoteHtml = displayReplyTo ? replyQuoteHtml(displayReplyTo, charName, userName) : '';
        const bubbleContent = msg.type === 'image'
            ? `<img src="${escapeHtml(msg.src)}" class="textme-msg-image" alt="image" />`
            : textToHtml(displayText);
        const replyBtnHtml = `<button class="textme-reply-btn" data-idx="${i}" title="Reply">↩</button>`;
        html += `
            <div class="textme-msg textme-msg-${side} ${grouped}" data-idx="${i}">
                ${msg.isUser ? replyBtnHtml : ''}
                <div class="textme-bubble-wrap">
                    ${quoteHtml}
                    <div class="textme-bubble-content">${bubbleContent}</div>
                    ${timeHtml}${cyclesHtml}${receiptHtml}
                </div>
                ${!msg.isUser ? replyBtnHtml : ''}
            </div>`;
    }
    container.innerHTML = html;
    scrollToBottom();
}

function scrollToBottom() {
    const container = document.getElementById('textme-messages');
    if (container) {
        requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });
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
    const last     = isLastInGroup(msgs, index);
    if (!first) {
        const prevIdx = index - 1;
        const prevEl  = container.querySelector(`.textme-msg[data-idx="${prevIdx}"]`);
        if (prevEl) prevEl.querySelector('.textme-msg-time')?.remove();
    }
    if (msg.isUser === true) {
        container.querySelectorAll('.textme-msg-user .textme-read-receipt').forEach(el => el.remove());
    }
    if (msg.isUser !== true) {
        const prevUserIdx = lastUserMsgIndex(msgs.slice(0, index));
        if (prevUserIdx >= 0) {
            container.querySelector(`.textme-msg[data-idx="${prevUserIdx}"] .textme-read-receipt`)?.remove();
        }
    }
    const timeHtml    = settings.showTimestamps && last
        ? `<span class="textme-msg-time">${formatTime(msg.time)}</span>`
        : '';
    const receiptHtml = readReceiptHtml(msgs, index, settings);
    const { name: _contactName } = getContactData();
    const charName  = _contactName || getCharName();
    const userName  = getUserName();
    let displayText = msg.text;
    let displayReplyTo = msg.replyTo;
    if (!msg.isUser && !msg.replyTo && msg.text?.startsWith('>')) {
        const parsed = parseReplyQuote(msg.text, msgs);
        displayText    = parsed.text;
        displayReplyTo = parsed.replyTo;
    }
    const quoteHtml = displayReplyTo ? replyQuoteHtml(displayReplyTo, charName, userName) : '';
    const replyBtnHtml = `<button class="textme-reply-btn" data-idx="${index}" title="Reply">↩</button>`;
    const div = document.createElement('div');
    div.className   = `textme-msg textme-msg-${side}${first ? '' : ' textme-grouped'}`;
    div.dataset.idx = index;
    const bubbleContent = msg.type === 'image'
        ? `<img src="${escapeHtml(msg.src)}" class="textme-msg-image" alt="image" />`
        : textToHtml(displayText);
    div.innerHTML = `
        ${msg.isUser ? replyBtnHtml : ''}
        <div class="textme-bubble-wrap">
            ${quoteHtml}
            <div class="textme-bubble-content">${bubbleContent}</div>
            ${timeHtml}${receiptHtml}
        </div>
        ${!msg.isUser ? replyBtnHtml : ''}`;
    const prevMsg = index > 0 ? msgs[index - 1] : null;
    if (!prevMsg || new Date(msg.time).toDateString() !== new Date(prevMsg.time).toDateString()) {
        if (prevMsg) {
            const sep = document.createElement('div');
            sep.className   = 'textme-day-sep';
            sep.textContent = formatDaySeparator(msg.time);
            container.appendChild(sep);
        }
    }
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
        let finalText = text;
        let replyTo   = null;
        if (i === 0) {
            const parsed = parseReplyQuote(text, phoneData.messages);
            finalText = parsed.text;
            replyTo   = parsed.replyTo;
        }
        const charMsg = { isUser: false, text: finalText, time: getCurrentTime().getTime() };
        if (replyTo) charMsg.replyTo = replyTo;
        phoneData.messages.push(charMsg);
        appendMessage(charMsg, phoneData.messages.length - 1);
        playNotificationSound();
        if (i < messageParts.length - 1) await sleep(200);
    }
    phoneData.lastActivity   = Date.now();
    phoneData.autonomousCount = 0;
    resetAutonomousWait(phoneData);
    await savePhoneData();
    updateRpInjection();
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function sleepAbortable(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
    });
}

function pickResponseDelay(status) {
    const cfg = getSettings().responseDelay?.[status];
    if (!cfg) return 0;
    const min = (cfg.min ?? 0) * 1000;
    const max = (cfg.max ?? 0) * 1000;
    if (max <= min) return min;
    return min + Math.random() * (max - min);
}

function isCancelError(err) {
    if (!err) return false;
    if (err.name === 'AbortError') return true;
    const msg = (err.message || '').toLowerCase();
    return msg.includes('cancel') || msg.includes('abort') || msg.includes('stop');
}

// ═══════════════════════════════════════════════
// Send Message
// ═══════════════════════════════════════════════

function isLastUserMsgUnanswered(messages) {
    if (!messages?.length) return false;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (!messages[i].isUser) return false;
        if (messages[i].isUser) return true;
    }
    return false;
}

function lastUserMsgIndex(messages) {
    if (!messages?.length) return -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].isUser === true) return i;
    }
    return -1;
}

function readReceiptHtml(messages, index, settings) {
    if (!settings.readReceipts) return '';
    const msg = messages[index];
    if (msg?.isUser !== true) return '';
    const lastIdx = lastUserMsgIndex(messages);
    if (index !== lastIdx) return '';
    for (let j = index + 1; j < messages.length; j++) {
        if (messages[j].isUser !== true) return '';
    }
    return `<div class="textme-read-receipt textme-receipt-delivered">
        <span class="textme-receipt-ticks"></span>
        <span class="textme-receipt-label">Delivered</span>
    </div>`;
}

function markReceiptRead() {
    const container = document.getElementById('textme-messages');
    if (!container) return;
    const receipt = container.querySelector('.textme-msg-user .textme-read-receipt.textme-receipt-delivered');
    if (!receipt) return;
    receipt.classList.replace('textme-receipt-delivered', 'textme-receipt-read');
    const label = receipt.querySelector('.textme-receipt-label');
    if (label) label.textContent = 'Read';
}

async function handleSend() {
    if (isGenerating) {
        if (phoneAbortController) { phoneAbortController.abort(); log.info('TextMe generation cancelled by user.'); }
        return;
    }
    const input = document.getElementById('textme-input');
    if (!input) { log.error('Input element not found!'); return; }
    const text = input.value.trim();
    if (!text) return;
    let currentStatus = 'online';
    try {
        const { status } = getCurrentStatus();
        if (status === 'offline') {
            log.info('Character is offline — message queued, generation skipped.');
            input.value = '';
            autoResizeInput();
            const phoneData = ensurePhoneData();
            const userMsg = { isUser: true, text, time: getCurrentTime().getTime() };
            if (pendingReply) { userMsg.replyTo = { ...pendingReply }; clearPendingReply(); }
            phoneData.messages.push(userMsg);
            appendMessage(userMsg, phoneData.messages.length - 1);
            await savePhoneData();
            updateRpInjection();
            const statusEl = document.getElementById('textme-header-status');
            if (statusEl) statusEl.textContent = 'Offline — will reply later';
            toastr.info(`${getCharName()} is offline and will reply when available.`, '', { timeOut: 3000 });
            return;
        }
        currentStatus = status;
    } catch (e) { log.warn('Could not check schedule status:', e); }
    log.info('Sending message:', text.substring(0, 50) + (text.length > 50 ? '...' : ''));
    input.value = '';
    autoResizeInput();
    const phoneData = ensurePhoneData();
    const userMsg = { isUser: true, text, time: getCurrentTime().getTime() };
    if (pendingReply) { userMsg.replyTo = { ...pendingReply }; clearPendingReply(); }
    phoneData.messages.push(userMsg);
    phoneData.lastActivity   = Date.now();
    phoneData.autonomousCount = 0;
    resetAutonomousWait(phoneData);
    appendMessage(userMsg, phoneData.messages.length - 1);
    await savePhoneData();
    updateRpInjection();
    phoneAbortController = new AbortController();
    isGenerating = true;
    updateSendButton();
    try {
        const delayMs = pickResponseDelay(currentStatus);
        if (delayMs > 0) {
            log.info(`Response delay: ${Math.round(delayMs / 1000)}s (status: ${currentStatus})`);
            await sleepAbortable(delayMs, phoneAbortController.signal);
            markReceiptRead();
        }
        showTyping();
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
    if (pendingReply) { userMsg.replyTo = { ...pendingReply }; clearPendingReply(); }
    phoneData.messages.push(userMsg);
    phoneData.lastActivity   = Date.now();
    phoneData.autonomousCount = 0;
    resetAutonomousWait(phoneData);
    appendMessage(userMsg, phoneData.messages.length - 1);
    await savePhoneData();
    toastr.info('Sent silently', '', { timeOut: 1200 });
}

function updateSendButton() {
    const btn = document.getElementById('textme-send');
    if (!btn) return;
    if (isGenerating) {
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
    if (regenItem) regenItem.style.display = msg && !msg.isUser ? '' : 'none';
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
            try { await navigator.clipboard.writeText(msg.text || ''); toastr.success('Copied to clipboard'); }
            catch { toastr.error('Failed to copy'); }
            break;
        case 'delete': {
            const deleteIdx = idx;
            if (!confirm('Delete this message?')) break;
            phoneData.messages.splice(deleteIdx, 1);
            await savePhoneData();
            updateRpInjection();
            renderMessages();
            break;
        }
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
                    if (phoneData.messages[i]?.isUser) { lastUserIdx = i; break; }
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
                    updateSendButton();
                    try {
                        let regenStatus = 'online';
                        try { regenStatus = getCurrentStatus().status; } catch (_) {}
                        const regenDelay = pickResponseDelay(regenStatus);
                        if (regenDelay > 0) {
                            await sleepAbortable(regenDelay, phoneAbortController.signal);
                            markReceiptRead();
                        }
                        showTyping();
                        const parts = await generatePhoneResponse(phoneAbortController.signal);
                        hideTyping();
                        await streamMessages(parts, phoneData);
                    } catch (err) {
                        hideTyping();
                        if (isCancelError(err)) { log.info('TextMe regeneration cancelled.'); toastr.info('TextMe: Cancelled', '', { timeOut: 1500 }); }
                        else { toastr.error(`Regeneration failed: ${err.message}`); }
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
    if (bubble && bubble.style.display === 'none') bubble.style.display = 'flex';
    phoneOpen = !phoneOpen;
    phone.style.display = phoneOpen ? 'flex' : 'none';
    if (phoneOpen) {
        renderMessages();
        updatePhoneHeader();
        updateStatusBarTime();
        clearBadge();
        setTimeout(() => { const input = document.getElementById('textme-input'); if (input) input.focus(); }, 100);
    }
}

export function openPhone() { if (!phoneOpen) togglePhone(); }

function updatePhoneHeader() {
    const { name: customName, avatar: customAvatar } = getContactData();
    const displayName = customName || getCharName();
    const nameEl      = document.querySelector('.textme-header-name');
    if (nameEl) nameEl.textContent = displayName;
    const avatar   = customAvatar || getCharAvatar();
    const avatarEl = document.querySelector('.textme-header-avatar');
    if (avatarEl) {
        const img = avatarEl.querySelector('img');
        if (avatar) {
            if (img) { img.src = avatar; }
            else {
                const dot = avatarEl.querySelector('.textme-status-dot');
                const dotHtml = dot ? dot.outerHTML : '<span class="textme-status-dot" id="textme-status-dot"></span>';
                avatarEl.innerHTML = `<img src="${avatar}" alt="" />${dotHtml}`;
            }
        }
    }
    const typingText = document.querySelector('.textme-typing-text');
    if (typingText) typingText.textContent = `${displayName} is typing...`;
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
    } catch (e) { log.warn('Could not update status display:', e); }
}

function updateStatusBarTime() {
    const el = document.querySelector('.textme-time-display');
    if (el) el.textContent = getFormattedGameTime();
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
    updateRpInjection();
    renderMessages();
    toastr.success('Phone chat cleared');
}

// ═══════════════════════════════════════════════
// Contact Edit Modal
// ═══════════════════════════════════════════════

let _cropState = null;
const CROP_SIZE = 240;

function _drawCrop() {
    const s = _cropState;
    if (!s) return;
    const canvas = document.getElementById('textme-contact-crop-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const size = s.canvasSize;
    ctx.clearRect(0, 0, size, size);
    const w = s.img.naturalWidth  * s.scale;
    const h = s.img.naturalHeight * s.scale;
    ctx.drawImage(s.img, s.offsetX, s.offsetY, w, h);
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.rect(0, 0, size, size);
    ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2, true);
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
}

function _clampCropOffset(s) {
    const w = s.img.naturalWidth  * s.scale;
    const h = s.img.naturalHeight * s.scale;
    const size = s.canvasSize;
    s.offsetX = Math.min(0, s.offsetX);
    s.offsetY = Math.min(0, s.offsetY);
    s.offsetX = Math.max(size - w, s.offsetX);
    s.offsetY = Math.max(size - h, s.offsetY);
}

function _initCropper(src) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
        const canvas = document.getElementById('textme-contact-crop-canvas');
        if (!canvas) return;
        const size = CROP_SIZE;
        canvas.width  = size;
        canvas.height = size;
        const scaleX = size / img.naturalWidth;
        const scaleY = size / img.naturalHeight;
        const scale  = Math.max(scaleX, scaleY);
        const w = img.naturalWidth  * scale;
        const h = img.naturalHeight * scale;
        _cropState = { img, offsetX: (size - w) / 2, offsetY: (size - h) / 2, scale, minScale: scale, canvasSize: size };
        _drawCrop();
        const cropWrap    = document.getElementById('textme-contact-crop-wrap');
        const previewWrap = document.getElementById('textme-contact-preview-wrap');
        if (cropWrap)    cropWrap.style.display    = 'block';
        if (previewWrap) previewWrap.style.display = 'none';
    };
    img.onerror = () => toastr.error('Could not load image');
    img.src = src;
}

function _exportCrop() {
    const s = _cropState;
    if (!s) return null;
    const out = document.createElement('canvas');
    out.width  = CROP_SIZE;
    out.height = CROP_SIZE;
    const ctx = out.getContext('2d');
    ctx.beginPath();
    ctx.arc(CROP_SIZE / 2, CROP_SIZE / 2, CROP_SIZE / 2, 0, Math.PI * 2);
    ctx.clip();
    const w = s.img.naturalWidth  * s.scale;
    const h = s.img.naturalHeight * s.scale;
    ctx.drawImage(s.img, s.offsetX, s.offsetY, w, h);
    return out.toDataURL('image/jpeg', 0.92);
}

let _cropDragActive = false;
let _cropDragLastX  = 0;
let _cropDragLastY  = 0;
let _cropTouches    = [];

function _cropOnPointerDown(e) {
    if (e.button !== 0) return;
    _cropDragActive = true;
    _cropDragLastX  = e.clientX;
    _cropDragLastY  = e.clientY;
    e.currentTarget.setPointerCapture(e.pointerId);
}
function _cropOnPointerMove(e) {
    if (!_cropDragActive || !_cropState) return;
    _cropState.offsetX += e.clientX - _cropDragLastX;
    _cropState.offsetY += e.clientY - _cropDragLastY;
    _cropDragLastX = e.clientX;
    _cropDragLastY = e.clientY;
    _clampCropOffset(_cropState);
    _drawCrop();
}
function _cropOnPointerUp() { _cropDragActive = false; }
function _cropOnWheel(e) {
    e.preventDefault();
    if (!_cropState) return;
    const s = _cropState;
    const delta  = e.deltaY < 0 ? 1.08 : 0.93;
    const newScale = Math.max(s.minScale, s.scale * delta);
    const cx = s.canvasSize / 2;
    const cy = s.canvasSize / 2;
    s.offsetX = cx - (cx - s.offsetX) * (newScale / s.scale);
    s.offsetY = cy - (cy - s.offsetY) * (newScale / s.scale);
    s.scale   = newScale;
    _clampCropOffset(s);
    _drawCrop();
}
function _cropOnTouchStart(e) { _cropTouches = Array.from(e.touches); }
function _cropOnTouchMove(e) {
    e.preventDefault();
    if (!_cropState) return;
    const touches = Array.from(e.touches);
    if (touches.length === 1 && _cropTouches.length === 1) {
        _cropState.offsetX += touches[0].clientX - _cropTouches[0].clientX;
        _cropState.offsetY += touches[0].clientY - _cropTouches[0].clientY;
        _clampCropOffset(_cropState);
        _drawCrop();
    } else if (touches.length === 2 && _cropTouches.length === 2) {
        const prevDist = Math.hypot(_cropTouches[0].clientX - _cropTouches[1].clientX, _cropTouches[0].clientY - _cropTouches[1].clientY);
        const newDist  = Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
        if (prevDist === 0) return;
        const s = _cropState;
        const newScale = Math.max(s.minScale, s.scale * (newDist / prevDist));
        const cx = s.canvasSize / 2;
        const cy = s.canvasSize / 2;
        s.offsetX = cx - (cx - s.offsetX) * (newScale / s.scale);
        s.offsetY = cy - (cy - s.offsetY) * (newScale / s.scale);
        s.scale   = newScale;
        _clampCropOffset(s);
        _drawCrop();
    }
    _cropTouches = touches;
}
function _cropOnTouchEnd(e) { _cropTouches = Array.from(e.touches); }

function _attachCropListeners(canvas) {
    canvas.addEventListener('pointerdown',   _cropOnPointerDown);
    canvas.addEventListener('pointermove',   _cropOnPointerMove);
    canvas.addEventListener('pointerup',     _cropOnPointerUp);
    canvas.addEventListener('pointercancel', _cropOnPointerUp);
    canvas.addEventListener('wheel',         _cropOnWheel, { passive: false });
    canvas.addEventListener('touchstart',    _cropOnTouchStart, { passive: true });
    canvas.addEventListener('touchmove',     _cropOnTouchMove,  { passive: false });
    canvas.addEventListener('touchend',      _cropOnTouchEnd,   { passive: true });
}
function _detachCropListeners(canvas) {
    canvas.removeEventListener('pointerdown',   _cropOnPointerDown);
    canvas.removeEventListener('pointermove',   _cropOnPointerMove);
    canvas.removeEventListener('pointerup',     _cropOnPointerUp);
    canvas.removeEventListener('pointercancel', _cropOnPointerUp);
    canvas.removeEventListener('wheel',         _cropOnWheel);
    canvas.removeEventListener('touchstart',    _cropOnTouchStart);
    canvas.removeEventListener('touchmove',     _cropOnTouchMove);
    canvas.removeEventListener('touchend',      _cropOnTouchEnd);
}

function _refreshContactModalPreview(url) {
    const previewEl = document.getElementById('textme-contact-modal-avatar');
    if (!previewEl) return;
    const src = url?.trim() || getCharAvatar();
    if (src) previewEl.innerHTML = `<img src="${src}" alt="" />`;
    else     previewEl.innerHTML = `<div class="textme-avatar-placeholder"><i class="fa-solid fa-user"></i></div>`;
}

function openContactEditModal() {
    const modal = document.getElementById('textme-contact-modal');
    if (!modal) return;
    _cropState = null;
    _cropDragActive = false;
    const canvas = document.getElementById('textme-contact-crop-canvas');
    if (canvas) { _detachCropListeners(canvas); _attachCropListeners(canvas); }
    const cropWrap    = document.getElementById('textme-contact-crop-wrap');
    const previewWrap = document.getElementById('textme-contact-preview-wrap');
    if (cropWrap)    cropWrap.style.display    = 'none';
    if (previewWrap) previewWrap.style.display = 'flex';
    const settings = getSettings();
    _updateScopeToggleUI(settings.contactScope || 'chat');
    const { name: currentName, avatar: currentAvatar } = getContactData();
    const nameInput = document.getElementById('textme-contact-name-input');
    const urlInput  = document.getElementById('textme-contact-url-input');
    if (nameInput) nameInput.value = currentName;
    if (urlInput)  urlInput.value  = currentAvatar;
    _refreshContactModalPreview(currentAvatar);
    modal.style.display = 'flex';
    urlInput?.addEventListener('input', _onContactUrlInput);
}

function _updateScopeToggleUI(scope) {
    document.querySelectorAll('#textme-contact-scope-toggle .textme-scope-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.scope === scope);
    });
}

function _onContactUrlInput(e) { if (!_cropState) _refreshContactModalPreview(e.target.value); }

function closeContactEditModal() {
    const modal   = document.getElementById('textme-contact-modal');
    const urlInput = document.getElementById('textme-contact-url-input');
    const canvas   = document.getElementById('textme-contact-crop-canvas');
    if (urlInput) urlInput.removeEventListener('input', _onContactUrlInput);
    if (canvas)   _detachCropListeners(canvas);
    _cropState      = null;
    _cropDragActive = false;
    if (modal) modal.style.display = 'none';
}

async function saveContactEdit() {
    const nameInput = document.getElementById('textme-contact-name-input');
    const urlInput  = document.getElementById('textme-contact-url-input');
    const name   = nameInput?.value.trim() || '';
    const avatar = _cropState ? (_exportCrop() || urlInput?.value.trim() || '') : (urlInput?.value.trim() || '');
    setContactData(name, avatar);
    const settings = getSettings();
    if (settings.contactScope === 'character') await SillyTavern.getContext().saveSettingsDebounced?.();
    else await savePhoneData();
    closeContactEditModal();
    updatePhoneHeader();
}

async function resetContactEdit() {
    setContactData('', '');
    const settings = getSettings();
    if (settings.contactScope === 'character') await SillyTavern.getContext().saveSettingsDebounced?.();
    else await savePhoneData();
    closeContactEditModal();
    updatePhoneHeader();
    toastr.success('Contact reset to default');
}

// ═══════════════════════════════════════════════
// Init / Destroy
// ═══════════════════════════════════════════════

export function initPhoneUI() {
    destroyPhoneUI();
    if (!hasCharacter()) { log.warn('No character selected, skipping phone UI init.'); return; }
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
    setupVisualViewport();
    bubble?.addEventListener('click', togglePhone);
    document.querySelector('.textme-header-back')?.addEventListener('click', minimizePhone);
    document.getElementById('textme-header-avatar')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        const newStatus = await cycleManualStatus();
        updateStatusDisplay();
        const { label } = getStatusInfo(newStatus || 'online');
        const msg = newStatus ? `Status overridden: ${label} ✱` : 'Status back to schedule';
        toastr.info(msg, '', { timeOut: 1500 });
    });
    document.querySelector('.textme-btn-clear')?.addEventListener('click', clearPhoneChat);
    document.getElementById('textme-btn-edit-contact')?.addEventListener('click', (e) => { e.stopPropagation(); openContactEditModal(); });
    document.getElementById('textme-contact-save-btn')?.addEventListener('click', saveContactEdit);
    document.getElementById('textme-contact-cancel-btn')?.addEventListener('click', closeContactEditModal);
    document.getElementById('textme-contact-reset-btn')?.addEventListener('click', resetContactEdit);
    document.getElementById('textme-contact-scope-toggle')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.textme-scope-btn');
        if (!btn) return;
        const scope = btn.dataset.scope;
        updateSetting('contactScope', scope);
        SillyTavern.getContext().saveSettingsDebounced?.();
        _updateScopeToggleUI(scope);
        const { name, avatar } = getContactData();
        const nameInput = document.getElementById('textme-contact-name-input');
        const urlInput  = document.getElementById('textme-contact-url-input');
        if (nameInput) nameInput.value = name;
        if (urlInput)  urlInput.value  = avatar;
        if (!_cropState) _refreshContactModalPreview(avatar);
    });
    document.getElementById('textme-contact-file-input')?.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        e.target.value = '';
        const reader = new FileReader();
        reader.onload = (ev) => {
            const urlInput = document.getElementById('textme-contact-url-input');
            if (urlInput) urlInput.value = '';
            _initCropper(ev.target.result);
        };
        reader.readAsDataURL(file);
    });
    document.getElementById('textme-contact-modal')?.addEventListener('click', (e) => {
        if (e.target === document.getElementById('textme-contact-modal')) closeContactEditModal();
    });
    document.getElementById('textme-send')?.addEventListener('click', handleSend);
    document.getElementById('textme-send')?.addEventListener('contextmenu', (e) => { e.preventDefault(); handleSilentSend(); });
    let _longPressTimer = null;
    const sendBtn = document.getElementById('textme-send');
    if (sendBtn) {
        sendBtn.addEventListener('touchstart', (e) => {
            _longPressTimer = setTimeout(() => { _longPressTimer = null; e.preventDefault(); handleSilentSend(); }, 500);
        }, { passive: false });
        sendBtn.addEventListener('touchend', () => { if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = null; } });
        sendBtn.addEventListener('touchmove', () => { if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = null; } });
    }
    const input = document.getElementById('textme-input');
    if (input) {
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                if (!getSettings().sendOnEnter) return;
                e.preventDefault();
                handleSend();
            }
        });
        input.addEventListener('input', autoResizeInput);
        input.addEventListener('focus', () => {
            if (window.innerWidth <= 500) setTimeout(() => input.scrollIntoView({ block: 'nearest', inline: 'nearest' }), 150);
        });
    }
    document.getElementById('textme-messages')?.addEventListener('contextmenu', (e) => {
        const msgEl = e.target.closest('.textme-msg');
        if (msgEl) showContextMenu(e, msgEl);
    });
    document.getElementById('textme-messages')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.textme-reply-btn');
        if (btn) {
            e.stopPropagation();
            const idx = parseInt(btn.dataset.idx, 10);
            if (!isNaN(idx)) setPendingReply(idx);
            return;
        }
        const quote = e.target.closest('.textme-reply-quote');
        if (quote) {
            const replyIdx = parseInt(quote.dataset.replyIdx, 10);
            if (!isNaN(replyIdx)) scrollToMessage(replyIdx);
        }
    });
    let _swipeMsgEl   = null;
    let _swipeStartX  = 0;
    let _swipeStartY  = 0;
    let _swipeTriggered = false;
    document.getElementById('textme-messages')?.addEventListener('touchstart', (e) => {
        const msgEl = e.target.closest('.textme-msg');
        if (!msgEl) return;
        _swipeMsgEl    = msgEl;
        _swipeStartX   = e.touches[0].clientX;
        _swipeStartY   = e.touches[0].clientY;
        _swipeTriggered = false;
    }, { passive: true });
    document.getElementById('textme-messages')?.addEventListener('touchmove', (e) => {
        if (!_swipeMsgEl || _swipeTriggered) return;
        const dx = e.touches[0].clientX - _swipeStartX;
        const dy = Math.abs(e.touches[0].clientY - _swipeStartY);
        if (dx > 50 && dy < 40) {
            _swipeTriggered = true;
            const idx = parseInt(_swipeMsgEl.dataset.idx, 10);
            if (!isNaN(idx)) {
                const wrap = _swipeMsgEl.querySelector('.textme-bubble-wrap');
                if (wrap) {
                    wrap.style.transition = 'transform 0.1s ease';
                    wrap.style.transform  = 'translateX(18px)';
                    setTimeout(() => { wrap.style.transform = ''; wrap.style.transition = 'transform 0.2s ease'; setTimeout(() => { wrap.style.transition = ''; }, 200); }, 150);
                }
                setPendingReply(idx);
            }
        }
    }, { passive: true });
    document.getElementById('textme-messages')?.addEventListener('touchend', () => { _swipeMsgEl = null; _swipeTriggered = false; }, { passive: true });
    let longPressTimer = null;
    document.getElementById('textme-messages')?.addEventListener('touchstart', (e) => {
        const msgEl = e.target.closest('.textme-msg');
        if (!msgEl) return;
        longPressTimer = setTimeout(() => {
            longPressTimer = null;
            const touch = e.touches[0];
            showContextMenu({ preventDefault: () => {}, clientX: touch.clientX, clientY: touch.clientY }, msgEl);
        }, 500);
    });
    document.getElementById('textme-messages')?.addEventListener('touchmove', () => { if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; } }, { passive: true });
    document.getElementById('textme-messages')?.addEventListener('touchend', () => { if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; } });
    document.getElementById('textme-context-menu')?.addEventListener('click', (e) => {
        const item = e.target.closest('.textme-ctx-item');
        if (item) handleContextAction(item.dataset.action);
    });
    _docClickHandler = (e) => { if (!e.target.closest('#textme-context-menu')) hideContextMenu(); };
    document.addEventListener('click', _docClickHandler);
    updateStatusBarTime();
    statusTimeInterval = setInterval(updateStatusBarTime, 60000);
    const settings = getSettings();
    if (settings.enabled && settings.autonomousEnabled) startAutonomousTimer();
    initNotifications();
    updateRpInjection();
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
    if (statusTimeInterval) { clearInterval(statusTimeInterval); statusTimeInterval = null; }
    stopAutonomousTimer();
    if (phoneAbortController) { phoneAbortController.abort(); phoneAbortController = null; }
    if (_docClickHandler) { document.removeEventListener('click', _docClickHandler); _docClickHandler = null; }
    cleanupDragListeners();
    cleanupVisualViewport();
    clearRpInjection();
    phoneOpen    = false;
    isGenerating = false;
}

export function reloadPhoneData() {
    if (phoneOpen) { renderMessages(); updatePhoneHeader(); }
}

export function isPhoneOpen() { return phoneOpen; }

export async function addExternalMessages(parts) {
    const phoneData = ensurePhoneData();
    showTyping();
    for (let i = 0; i < parts.length; i++) {
        const delay = 600 + Math.random() * 1200;
        await sleep(delay);
        hideTyping();
        let finalText = parts[i];
        let replyTo   = null;
        if (i === 0) {
            const parsed = parseReplyQuote(parts[i], phoneData.messages);
            finalText = parsed.text;
            replyTo   = parsed.replyTo;
        }
        const msg = { isUser: false, text: finalText, time: getCurrentTime().getTime() };
        if (replyTo) msg.replyTo = replyTo;
        phoneData.messages.push(msg);
        appendMessage(msg, phoneData.messages.length - 1);
        playNotificationSound();
        if (i < parts.length - 1) { showTyping(); await sleep(300); }
    }
    phoneData.lastActivity = Date.now();
    await savePhoneData();
    updateRpInjection();
    hideTyping();
    if (!phoneOpen) updateBadge(parts.length);
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
    if (badge) { badge.textContent = '0'; badge.style.display = 'none'; }
}
