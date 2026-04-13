/**
 * TextMe — Phone UI
 * License: AGPL-3.0
 *
 * FIX: renderMessages() and appendMessage() now convert \n → <br> so that
 * messages saved with internal line-breaks are rendered correctly.
 * FIX: Status dot reflects real schedule on init.
 * FIX: Regenerate deletes the full char-message group and archives cycles.
 * FEAT: Avatar click cycles manual status override.
 * FIX: Initial reply delay reduced to 100 ms.
 *
 * FIX: Generation isolation from ST Stop button.
 * - Each TextMe generation (send / regenerate) owns its own AbortController
 *   stored in phoneAbortController.
 * - The signal is forwarded to generatePhoneResponse() → generateRaw().
 * - While generating, the send button becomes a Cancel button that aborts
 *   ONLY the TextMe request (phoneAbortController.abort()), leaving the
 *   ST main-chat generation untouched.
 * - If ST's global Stop aborts our request anyway (older ST versions that
 *   don't honour a custom signal), the error is caught and shown as a
 *   neutral 'Cancelled' info toast instead of a red error.
 *
 * FIX: document-level click listener for context-menu dismissal is now stored
 * as a named reference and removed in destroyPhoneUI() to prevent
 * memory leaks on repeated chat switches.
 *
 * FIX: destroyPhoneUI() now calls cleanupDragListeners() to remove the
 * window resize handler from drag.js, preventing listener accumulation.
 *
 * FIX (mobile): Visual Viewport API integration.
 * Chrome 108+ on Android changed viewport-resize behavior: only the
 * Visual Viewport shrinks when the virtual keyboard opens; the Layout
 * Viewport stays the same size. Because `position: fixed` elements anchor
 * to the Layout Viewport, the input bar was hidden under the keyboard and
 * under the browser's own chrome (address bar).
 *
 * setupVisualViewport() subscribes to window.visualViewport "resize" and
 * "scroll" events on mobile (innerWidth ≤ 500) and writes two CSS custom
 * properties onto :root:
 *   --textme-vvh     = visualViewport.height (px)
 *   --textme-vvh-top = visualViewport.offsetTop (px)
 * The CSS media-query in style.css consumes these vars so the phone element
 * always fits the truly visible area regardless of keyboard state.
 * cleanupVisualViewport() removes the listeners in destroyPhoneUI().
 *
 * FIX: createPhoneHTML() now calls getContactData().avatar || getCharAvatar()
 * so the initial render uses the custom avatar (or ST avatar as fallback)
 * consistently with updatePhoneHeader(). Previously it only called
 * getCharAvatar(), so contacts without a custom avatar set but with a
 * custom-scope active (contactScope: 'character') would render a blank
 * placeholder on first load even though the ST avatar was available.
 *
 * FIX: Race condition between autonomous and regular generation.
 * isGenerating is now exposed to autonomous.js via setPhoneGenerating() /
 * isPhoneGenerating() in state.js. The flag is set to true at the very start
 * of handleSend() (before responseDelay begins) and cleared in finally{}.
 * autonomous.js reads this flag in checkAndSend() and skips the tick if the
 * phone is already generating, preventing duplicate responses.
 *
 * v1.5.0 logging improvements:
 * — handleSilentSend: log full char count alongside truncated preview
 * — handleSend: log full char count alongside truncated preview
 * — pickResponseDelay: log min–max range alongside chosen delay value
 *
 * FIX (streamMessages / addExternalMessages): parseReplyQuote() now runs on
 * EVERY bubble, not just the first. The previous `if (i === 0)` guard meant
 * that citations placed in the second or later bubble were never resolved to
 * a replyTo reference and the raw "> ..." text was saved as-is.
 *
 * FEAT: i18n support via lib/i18n.js
 * The t() helper resolves JS-side strings (toastr, confirm, prompt, inline
 * HTML) to Russian when ST locale is 'ru-ru'. All other locales fall back to
 * the English source string unchanged.
 * The edit-contact button has been moved from .textme-header-name-row into
 * .textme-header-actions (next to the trash icon) and is now always visible
 * (opacity: 1) — no hover required.
 *
 * FEAT: Header actions menu (⋮ button).
 * The edit-contact button now opens a small context menu instead of directly
 * opening the modal. Menu items: Edit Contact + Send first message.
 * handleForceFirstMessage() forces {{char}} to generate an unprompted message
 * using the same generation path as handleSend, without a user message and
 * without responseDelay. The same isGenerating mutex prevents races with the
 * autonomous timer and handleSend.
 */
import {
    EXTENSION_NAME,
    getSettings,
    getPhoneData,
    ensurePhoneData,
    savePhoneData,
    getCharName,
    getUserName,
    hasCharacter,
    updateSetting,
    getContactData,
    setContactData,
    setPhoneGenerating,
} from './state.js';
import { generatePhoneResponse, parseReplyQuote } from './prompt-engine.js';
import { getCurrentStatus, getStatusInfo, cycleManualStatus } from './schedule.js';
import { makeBubbleDraggable, makePhoneDraggable, makePhoneResizable, cleanupDragListeners } from './drag.js';
import { startAutonomousTimer, stopAutonomousTimer, resetAutonomousWait } from './autonomous.js';
import { initNotifications, playNotificationSound } from './notifications.js';
import { getFormattedGameTime, getCurrentTime } from './custom-time.js';
import { updateRpInjection, clearRpInjection } from './rp-inject.js';
import { log } from './logger.js';
import { t } from './i18n.js';

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
 * bubble context menu. Stored here so destroyPhoneUI() can remove it and
 * prevent listener accumulation across chat switches.
 */
let _docClickHandler = null;

/**
 * Named reference to the document-level click handler used to dismiss the
 * header actions menu. Separate from _docClickHandler so the two menus
 * can coexist without interfering with each other's dismiss logic.
 */
let _headerMenuDocHandler = null;

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
    if (_vvResizeHandler) { vv.removeEventListener('resize', _vvResizeHandler); _vvResizeHandler = null; }
    if (_vvScrollHandler) { vv.removeEventListener('scroll', _vvScrollHandler); _vvScrollHandler = null; }
    if (_vvRAF) { cancelAnimationFrame(_vvRAF); _vvRAF = null; }
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
    // FIX: use custom avatar/name if set, otherwise fall back to ST character avatar/name.
    // This matches the logic in updatePhoneHeader() and prevents the avatar
    // placeholder from appearing on first render when no custom avatar is set
    // but the character has a valid ST avatar.
    const { name: customName, avatar: customAvatar } = getContactData();
    const avatar = customAvatar || getCharAvatar();
    const settings = getSettings();
    const theme  = settings.theme || 'dark';
    const scheme = settings.colorScheme || 'default';

    return `
        <div id="textme-bubble" class="textme-bubble" style="display:none">
            <div id="textme-bubble-avatar" class="textme-bubble-avatar">
                ${avatar ? `<img src="${avatar}" alt="${customName || charName}">` : `<span class="textme-avatar-placeholder">${(customName || charName).charAt(0).toUpperCase()}</span>`}
            </div>
            <div id="textme-badge" class="textme-badge" style="display:none">0</div>
        </div>
        <div id="textme-phone" class="textme-phone textme-theme-${theme} textme-scheme-${scheme}" style="display:none">
            <div class="textme-status-bar">
                <span class="textme-time-display">12:00</span>
                <div class="textme-status-icons">
                    <i class="fa-solid fa-signal"></i>
                    <i class="fa-solid fa-wifi"></i>
                    <i class="fa-solid fa-battery-full"></i>
                </div>
            </div>
            <div id="textme-header" class="textme-header">
                <button class="textme-header-back textme-btn-icon" title="Minimize">
                    <i class="fa-solid fa-chevron-left"></i>
                </button>
                <div id="textme-header-avatar" class="textme-header-avatar" title="Click to change status">
                    ${avatar ? `<img src="${avatar}" alt="${customName || charName}">` : `<span class="textme-avatar-placeholder">${(customName || charName).charAt(0).toUpperCase()}</span>`}
                    <div id="textme-status-dot" class="textme-status-dot textme-status-online"></div>
                </div>
                <div class="textme-header-info">
                    <div class="textme-header-name">${customName || charName}</div>
                    <div id="textme-header-status" class="textme-header-status">...</div>
                </div>
                <div class="textme-header-actions">
                    <button class="textme-btn-icon textme-btn-clear" title="Clear chat">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                    <button id="textme-btn-edit-contact" class="textme-btn-icon textme-btn-edit-contact" title="${t('More')}">
                        <i class="fa-solid fa-ellipsis-vertical"></i>
                    </button>
                </div>
            </div>
            <div id="textme-messages" class="textme-messages">
                <div class="textme-empty-state">${t('Start a conversation!')}</div>
            </div>
            <div id="textme-typing" class="textme-typing" style="display:none">
                <div class="textme-typing-dots"><span></span><span></span><span></span></div>
                <span class="textme-typing-text">${customName || charName}${t(' is typing...')}</span>
            </div>
            <div id="textme-reply-bar" class="textme-reply-bar" style="display:none"></div>
            <div class="textme-input-row">
                <button class="textme-btn-icon textme-emoji-btn" id="textme-emoji-btn" title="Emoji">
                    <i class="fa-regular fa-face-smile"></i>
                </button>
                <textarea id="textme-input" class="textme-input" placeholder="Message..." rows="1"></textarea>
                <button id="textme-send" class="textme-send-btn" title="Send">
                    <i class="fa-solid fa-paper-plane"></i>
                </button>
            </div>
            <div id="textme-unread-bar" class="textme-unread-bar" style="display:none">
                <span id="textme-unread-count">0 ${t('unread')}</span>
            </div>
        </div>
        <div id="textme-context-menu" class="textme-context-menu" style="display:none">
            <div class="textme-ctx-item" data-action="copy"><i class="fa-regular fa-copy"></i> ${t('Copy')}</div>
            <div class="textme-ctx-item" data-action="regenerate"><i class="fa-solid fa-rotate-right"></i> ${t('Regenerate')}</div>
            <div class="textme-ctx-item" data-action="edit"><i class="fa-solid fa-pen"></i> ${t('Edit')}</div>
            <div class="textme-ctx-item" data-action="delete"><i class="fa-solid fa-trash"></i> ${t('Delete')}</div>
        </div>
        <div id="textme-header-menu" class="textme-context-menu" style="display:none">
            <div class="textme-ctx-item" data-action="hm-edit-contact"><i class="fa-solid fa-user-pen"></i> ${t('Edit Contact')}</div>
            <div class="textme-ctx-item" data-action="hm-force-message"><i class="fa-solid fa-message"></i> ${t('Send first message')}</div>
        </div>
        <div id="textme-contact-modal" class="textme-modal-overlay" style="display:none">
            <div class="textme-modal">
                <div class="textme-modal-header">${t('Edit Contact')}</div>
                <div id="textme-contact-scope-toggle" class="textme-scope-toggle">
                    <button class="textme-scope-btn" data-scope="chat">${t('Save for')}<br>${t('This chat')}</button>
                    <button class="textme-scope-btn" data-scope="character">${t('Save for')}<br>${t('All chats')}</button>
                </div>
                <div id="textme-contact-preview-wrap" class="textme-contact-preview-wrap">
                    <div id="textme-contact-modal-avatar" class="textme-contact-modal-avatar"></div>
                </div>
                <div id="textme-contact-crop-wrap" class="textme-contact-crop-wrap" style="display:none">
                    <canvas id="textme-contact-crop-canvas" class="textme-contact-crop-canvas"></canvas>
                    <div class="textme-crop-hint">${t('Drag to pan · Scroll to zoom')}</div>
                </div>
                <div class="textme-modal-field">
                    <label class="textme-modal-label">${t('Display name')}</label>
                    <input id="textme-contact-name-input" class="textme-modal-input" type="text" placeholder="${customName || charName}">
                </div>
                <div class="textme-modal-field">
                    <label class="textme-modal-label">${t('Avatar URL')}</label>
                    <input id="textme-contact-url-input" class="textme-modal-input" type="text" placeholder="https://...">
                </div>
                <div class="textme-modal-field textme-modal-upload-row">
                    <label class="textme-modal-label">${t('Upload image')}</label>
                    <label class="textme-modal-upload-btn">
                        <i class="fa-solid fa-upload"></i> ${t('Choose image')}
                        <input id="textme-contact-file-input" type="file" accept="image/*" style="display:none">
                    </label>
                </div>
                <div class="textme-modal-actions">
                    <button id="textme-contact-reset-btn" class="textme-modal-btn textme-modal-btn-danger">${t('Reset')}</button>
                    <button id="textme-contact-cancel-btn" class="textme-modal-btn">${t('Cancel')}</button>
                    <button id="textme-contact-save-btn" class="textme-modal-btn textme-modal-btn-primary">${t('Save')}</button>
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
    const date = new Date(timestamp);
    const today = getCurrentTime();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (date.toDateString() === today.toDateString()) return t('Today');
    if (date.toDateString() === yesterday.toDateString()) return t('Yesterday');
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

// ═══════════════════════════════════════════════
// Reply-to helpers
// ═══════════════════════════════════════════════

/**
 * Build the quote block HTML shown above the bubble content.
 * @param {{ index: number, isUser: boolean, text: string }} replyTo
 * @param {string} charName
 * @param {string} userName
 * @returns {string}
 */
function replyQuoteHtml(replyTo, charName, userName) {
    if (!replyTo) return '';
    const MAX = 80;
    const snippet = (replyTo.text || '').trim();
    const preview = snippet.length > MAX ? snippet.substring(0, MAX) + '…' : snippet;
    const sender  = replyTo.isUser ? userName : charName;
    return `
        <div class="textme-reply-quote" data-reply-idx="${replyTo.index}">
            <span class="textme-reply-quote-sender">${escapeHtml(sender)}</span>
            <span class="textme-reply-quote-text">${escapeHtml(preview)}</span>
        </div>`;
}

/**
 * Activate reply mode: store pendingReply and show the reply-bar above the input.
 * @param {number} index  index in phoneData.messages
 */
function setPendingReply(index) {
    const phoneData = getPhoneData();
    if (!phoneData) return;
    const msg = phoneData.messages[index];
    if (!msg) return;
    pendingReply = {
        index,
        isUser: msg.isUser,
        text:   msg.text || '',
    };
    _updateReplyBar();
    // Focus input so user can start typing immediately
    document.getElementById('textme-input')?.focus();
}

/**
 * Clear reply mode.
 */
function clearPendingReply() {
    pendingReply = null;
    _updateReplyBar();
}

/**
 * Show or hide the reply-bar based on pendingReply state.
 */
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
        <div class="textme-reply-bar-content">
            <span class="textme-reply-bar-sender">${escapeHtml(sender)}</span>
            <span class="textme-reply-bar-text">${escapeHtml(snippet)}</span>
        </div>
        <button id="textme-reply-bar-close" class="textme-reply-bar-close">✕</button>`;
    document.getElementById('textme-reply-bar-close')?.addEventListener('click', clearPendingReply);
}

/**
 * Scroll the message container to the bubble at the given index and briefly flash it.
 * @param {number} index
 */
function scrollToMessage(index) {
    const container = document.getElementById('textme-messages');
    if (!container) return;
    const el = container.querySelector(`.textme-msg[data-idx="${index}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Flash highlight
    el.classList.add('textme-msg-flash');
    setTimeout(() => el.classList.remove('textme-msg-flash'), 1200);
}

export function renderMessages() {
    const container = document.getElementById('textme-messages');
    if (!container) return;
    const phoneData = getPhoneData();
    const settings  = getSettings();

    if (!phoneData || phoneData.messages.length === 0) {
        container.innerHTML = `<div class="textme-empty-state">${t('Start a conversation!')}</div>`;
        return;
    }

    const msgs = phoneData.messages;
    const { name: _contactName } = getContactData();
    const charName = _contactName || getCharName();
    const userName = getUserName();

    let html    = '';
    let lastDay = '';

    // pendingOrphanQuote: when a char bubble contains only "> quote" with no body,
    // we skip it and carry the quote forward to attach to the next char bubble.
    let pendingOrphanQuote = null; // { index, isUser, text } | null

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
        const timeHtml    = settings.showTimestamps && last
            ? `<span class="textme-msg-time">${formatTime(msg.time)}</span>` : '';
        const cyclesHtml  = msg._prevCycles?.length
            ? `<span class="textme-cycle-badge" title="Regenerated ${msg._prevCycles.length}x">↻${msg._prevCycles.length}</span>` : '';
        const receiptHtml = readReceiptHtml(msgs, i, settings);

        // For char messages that were saved before the reply-quote fix,
        // the raw "> quote\ntext" may still be in msg.text with no replyTo set.
        // Always take parsed.text (stripped of "> " lines) even if no match was found —
        // this ensures the raw "> ..." never leaks into the rendered bubble.
        let displayText   = msg.text;
        let displayReplyTo = msg.replyTo;

        if (!msg.isUser && !msg.replyTo && msg.text?.startsWith('>')) {
            const parsed = parseReplyQuote(msg.text, msgs);
            if (parsed.text !== msg.text) {
                // parseReplyQuote found a non-empty body — normal case
                displayText    = parsed.text;
                displayReplyTo = parsed.replyTo;
            } else {
                // Body was empty — orphan quote-only bubble (saved as two separate messages).
                // Extract the snippet and find the matching message in history.
                const quoteSnippet = msg.text.replace(/^>\s?/gm, '').trim();
                const needle       = quoteSnippet.toLowerCase();
                const prefix       = needle.substring(0, 30);
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
                continue; // skip rendering this bubble entirely
            }
        }

        // Attach orphan quote carried from the previous skipped bubble
        if (!msg.isUser && !displayReplyTo && pendingOrphanQuote) {
            displayReplyTo     = pendingOrphanQuote;
            pendingOrphanQuote = null;
        } else if (!msg.isUser) {
            pendingOrphanQuote = null;
        }

        const quoteHtml    = displayReplyTo ? replyQuoteHtml(displayReplyTo, charName, userName) : '';
        const bubbleContent = msg.type === 'image'
            ? `<img src="${msg.url}" class="textme-msg-image" alt="image">`
            : textToHtml(displayText);

        // Reply button — shown on hover via CSS, activates reply mode
        const replyBtnHtml = `<button class="textme-reply-btn" data-idx="${i}" title="Reply">↩</button>`;

        html += `
            <div class="textme-msg textme-msg-${side} ${grouped}" data-idx="${i}">
                ${msg.isUser ? replyBtnHtml : ''}
                <div class="textme-bubble-wrap">
                    ${quoteHtml}
                    <div class="textme-bubble">${bubbleContent}</div>
                    <div class="textme-msg-meta">${timeHtml}${cyclesHtml}${receiptHtml}</div>
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
    const first     = isFirstInGroup(msgs, index);
    const last      = isLastInGroup(msgs, index); // always true for a freshly appended msg

    // If prev message is from same sender and now becomes non-last, hide its timestamp
    if (!first) {
        const prevIdx = index - 1;
        const prevEl  = container.querySelector(`.textme-msg[data-idx="${prevIdx}"]`);
        if (prevEl) { prevEl.querySelector('.textme-msg-time')?.remove(); }
    }

    // Strip any existing receipt from ALL previous user bubbles —
    // only the newest user message (this one) should ever show Delivered
    if (msg.isUser === true) {
        container.querySelectorAll('.textme-msg-user .textme-read-receipt').forEach(el => el.remove());
    }

    // If a char message just arrived, strip the Delivered receipt from the last user bubble
    if (msg.isUser !== true) {
        const prevUserIdx = lastUserMsgIndex(msgs.slice(0, index));
        if (prevUserIdx >= 0) {
            container.querySelector(`.textme-msg[data-idx="${prevUserIdx}"] .textme-read-receipt`)?.remove();
        }
    }

    const timeHtml    = settings.showTimestamps && last ? `<span class="textme-msg-time">${formatTime(msg.time)}</span>` : '';
    const receiptHtml = readReceiptHtml(msgs, index, settings);

    const { name: _contactName } = getContactData();
    const charName = _contactName || getCharName();
    const userName = getUserName();

    // For char messages saved before the reply-quote fix, parse "> quote\ntext"
    // on the fly so the UI renders correctly without touching saved data.
    // Always take parsed.text even if no match — prevents "> ..." leaking into the bubble.
    let displayText    = msg.text;
    let displayReplyTo = msg.replyTo;
    if (!msg.isUser && !msg.replyTo && msg.text?.startsWith('>')) {
        const parsed   = parseReplyQuote(msg.text, msgs);
        displayText    = parsed.text;
        displayReplyTo = parsed.replyTo; // may be null
    }

    const quoteHtml    = displayReplyTo ? replyQuoteHtml(displayReplyTo, charName, userName) : '';
    const replyBtnHtml = `<button class="textme-reply-btn" data-idx="${index}" title="Reply">↩</button>`;

    const div = document.createElement('div');
    div.className  = `textme-msg textme-msg-${side}${first ? '' : ' textme-grouped'}`;
    div.dataset.idx = index;

    const bubbleContent = msg.type === 'image'
        ? `<img src="${msg.url}" class="textme-msg-image" alt="image">`
        : textToHtml(displayText);

    div.innerHTML = `
        ${msg.isUser ? replyBtnHtml : ''}
        <div class="textme-bubble-wrap">
            ${quoteHtml}
            <div class="textme-bubble">${bubbleContent}</div>
            <div class="textme-msg-meta">${timeHtml}${receiptHtml}</div>
        </div>
        ${!msg.isUser ? replyBtnHtml : ''}`;

    // Insert a day separator if this message is on a different calendar day than
    // the previous message. Uses the game clock so custom time shifts are reflected.
    const prevMsg = index > 0 ? msgs[index - 1] : null;
    if (!prevMsg || new Date(msg.time).toDateString() !== new Date(prevMsg.time).toDateString()) {
        // Only insert if there's actually a prior message (avoid duplicate of the
        // separator that renderMessages() already placed at the very top).
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

        // Parse > quote from the model's output — for EVERY bubble.
        // Models sometimes place the citation in a bubble other than the first.
        const parsed    = parseReplyQuote(text, phoneData.messages);
        const finalText = parsed.text;
        const replyTo   = parsed.replyTo;

        const charMsg = { isUser: false, text: finalText, time: getCurrentTime().getTime() };
        if (replyTo) charMsg.replyTo = replyTo;
        phoneData.messages.push(charMsg);
        appendMessage(charMsg, phoneData.messages.length - 1);
        playNotificationSound();

        if (i < messageParts.length - 1) { await sleep(200); }
    }

    phoneData.lastActivity    = Date.now();
    phoneData.autonomousCount = 0;
    resetAutonomousWait(phoneData); // clear stale wait snapshot; char just replied, fresh cycle
    await savePhoneData();
    updateRpInjection();
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Like sleep(), but rejects with AbortError if the signal fires before ms elapses.
 * @param {number} ms
 * @param {AbortSignal} signal
 */
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

/**
 * Pick a random delay (ms) from the responseDelay setting for the given status.
 * Returns 0 when the status has no delay configured.
 * Logs the chosen value alongside the configured min–max range.
 * @param {string} status  'online' | 'idle' | 'dnd' | 'offline'
 * @returns {number}
 */
function pickResponseDelay(status) {
    const cfg = getSettings().responseDelay?.[status];
    if (!cfg) return 0;
    const minMs = (cfg.min ?? 0) * 1000;
    const maxMs = (cfg.max ?? 0) * 1000;
    const delay = maxMs <= minMs ? minMs : minMs + Math.random() * (maxMs - minMs);
    if (delay > 0) {
        log.info(`[Generation] Response delay: ${Math.round(delay / 1000)}s (status: ${status}, range: ${cfg.min ?? 0}–${cfg.max ?? 0}s)`);
    }
    return delay;
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
        if (messages[i].isUser === true) return i;
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
    const msg = messages[index];
    // Only show on user messages
    if (msg?.isUser !== true) return '';
    // Only show on the absolute last user message in the array
    const lastIdx = lastUserMsgIndex(messages);
    if (index !== lastIdx) return '';
    // Hide if ANY char message exists anywhere after this user message
    for (let j = index + 1; j < messages.length; j++) {
        if (messages[j].isUser !== true) return '';
    }
    // Still waiting for reply — show "Delivered"
    return `
        <span class="textme-read-receipt textme-receipt-delivered">
            <i class="fa-solid fa-check-double"></i>
            <span class="textme-receipt-label">${t('Delivered')}</span>
        </span>`;
}

/**
 * Upgrade the "Delivered" receipt on the last user bubble to "Read".
 * Called when the response delay elapses — char has "seen" the message.
 */
function markReceiptRead() {
    const container = document.getElementById('textme-messages');
    if (!container) return;
    const receipt = container.querySelector('.textme-msg-user .textme-read-receipt.textme-receipt-delivered');
    if (!receipt) return;
    receipt.classList.replace('textme-receipt-delivered', 'textme-receipt-read');
    const label = receipt.querySelector('.textme-receipt-label');
    if (label) label.textContent = t('Read');
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
    if (!input) { log.error('Input element not found!'); return; }
    const text = input.value.trim();
    if (!text) return;

    // Retrieve current status BEFORE appending message (used for delay below).
    let currentStatus = 'online';
    try {
        const { status } = getCurrentStatus();
        if (status === 'offline') {
            // Offline: message is saved, but generation is skipped.
            // The autonomous timer will pick it up via the unanswered-message
            // bypass once the character comes back online.
            log.info('Character is offline — message queued, generation skipped.');
            input.value = '';
            autoResizeInput();
            const phoneData = ensurePhoneData();
            const userMsg = { isUser: true, text, time: getCurrentTime().getTime() };
            // Attach reply reference if user was in reply mode
            if (pendingReply) { userMsg.replyTo = { ...pendingReply }; clearPendingReply(); }
            phoneData.messages.push(userMsg);
            // Do NOT reset lastActivity or autonomousCount here —
            // _onStatusChanged in autonomous.js will handle the reply trigger.
            appendMessage(userMsg, phoneData.messages.length - 1);
            await savePhoneData();
            updateRpInjection();
            const statusEl = document.getElementById('textme-header-status');
            if (statusEl) statusEl.textContent = t('Offline — will reply later');
            toastr.info(`${getCharName()} is offline and will reply when available.`, '', { timeOut: 3000 });
            return;
        }
        currentStatus = status;
    } catch (e) {
        log.warn('Could not check schedule status:', e);
    }

    // Log full message length alongside truncated preview
    const preview = text.length > 50 ? text.substring(0, 50) + '...' : text;
    log.info(`Sending message (${text.length} chars): ${preview}`);

    input.value = '';
    autoResizeInput();

    const phoneData = ensurePhoneData();
    const userMsg   = { isUser: true, text, time: getCurrentTime().getTime() };
    // Attach reply reference if user was in reply mode
    if (pendingReply) { userMsg.replyTo = { ...pendingReply }; clearPendingReply(); }
    phoneData.messages.push(userMsg);
    phoneData.lastActivity    = Date.now();
    phoneData.autonomousCount = 0;
    resetAutonomousWait(phoneData); // clear stale snapshot so next autonomous check starts fresh
    appendMessage(userMsg, phoneData.messages.length - 1);
    await savePhoneData();
    updateRpInjection();

    // Create a fresh AbortController for this TextMe request.
    // Aborting it cancels only our generateRaw call, not ST's main chat.
    phoneAbortController = new AbortController();

    // FIX: set the shared mutex BEFORE the responseDelay sleep so that any
    // autonomous tick firing during the delay window sees isPhoneGenerating()=true
    // and skips the cycle, preventing a parallel autonomous request.
    isGenerating = true;
    setPhoneGenerating(true);
    updateSendButton();

    try {
        // ── Response delay ────────────────────────────────────────────────────
        // Wait the configured delay for this status before the char "starts typing".
        // During this time: Delivered receipt is visible, typing indicator is hidden.
        // When delay elapses: upgrade receipt to "Read", then show typing indicator.
        const delayMs = pickResponseDelay(currentStatus);
        if (delayMs > 0) {
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
            toastr.info(t('TextMe: Cancelled'), '', { timeOut: 1500 });
        } else {
            log.error('Generation error:', err);
            toastr.error(`TextMe: ${err.message || 'Generation failed'}`);
        }
    } finally {
        isGenerating = false;
        setPhoneGenerating(false);
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

    // Log full message length alongside truncated preview
    const preview = text.length > 50 ? text.substring(0, 50) + '...' : text;
    log.info(`Silent send (${text.length} chars): ${preview}`);

    input.value = '';
    autoResizeInput();

    const phoneData = ensurePhoneData();
    const userMsg   = { isUser: true, text, time: getCurrentTime().getTime(), silent: true };
    if (pendingReply) { userMsg.replyTo = { ...pendingReply }; clearPendingReply(); }
    phoneData.messages.push(userMsg);
    phoneData.lastActivity    = Date.now();
    phoneData.autonomousCount = 0;
    resetAutonomousWait(phoneData); // clear stale snapshot
    appendMessage(userMsg, phoneData.messages.length - 1);
    await savePhoneData();
    toastr.info(t('Sent silently'), '', { timeOut: 1200 });
}

function updateSendButton() {
    const btn = document.getElementById('textme-send');
    if (!btn) return;
    if (isGenerating) {
        // Show stop icon — clicking will abort TextMe generation only
        btn.disabled = false;
        btn.title    = 'Cancel TextMe generation';
        btn.innerHTML = '<i class="fa-solid fa-stop"></i>';
    } else {
        btn.disabled  = false;
        btn.title     = 'Send';
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
    input.style.height   = newH + 'px';
    input.style.overflowY = newH >= 100 ? 'auto' : 'hidden';
}

// ═══════════════════════════════════════════════
// Bubble Context Menu
// ═══════════════════════════════════════════════

let contextMenuTarget = null;

function showContextMenu(e, msgEl) {
    e.preventDefault();
    // Close header menu if open
    hideHeaderMenu();
    const menu = document.getElementById('textme-context-menu');
    if (!menu) return;
    contextMenuTarget = msgEl;

    const idx     = parseInt(msgEl.dataset.idx, 10);
    const phoneData = getPhoneData();
    const msg     = phoneData?.messages[idx];
    const regenItem = menu.querySelector('[data-action="regenerate"]');
    if (regenItem) { regenItem.style.display = msg && !msg.isUser ? '' : 'none'; }

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
    const idx = parseInt(contextMenuTarget.dataset.idx, 10);
    const phoneData = getPhoneData();
    if (!phoneData || idx < 0 || idx >= phoneData.messages.length) return;
    const msg = phoneData.messages[idx];

    switch (action) {
        case 'copy':
            try {
                await navigator.clipboard.writeText(msg.text || '');
                toastr.success(t('Copied to clipboard'));
            } catch { toastr.error(t('Failed to copy')); }
            break;
        case 'delete': {
            // Fix: snapshot idx before any async gap to avoid stale-index race condition
            const deleteIdx = idx;
            if (!confirm(t('Delete this message?'))) break;
            phoneData.messages.splice(deleteIdx, 1);
            await savePhoneData();
            updateRpInjection();
            renderMessages();
            break;
        }
        case 'edit': {
            const newText = prompt(t('Edit message:'), msg.text);
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
                const groupStart  = lastUserIdx + 1;
                const charGroup   = phoneData.messages.slice(groupStart);
                const prevTexts   = charGroup.filter(m => !m.isUser).map(m => m.text);
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
                    setPhoneGenerating(true);
                    updateSendButton();
                    try {
                        // Apply response delay before showing typing indicator (same as handleSend)
                        let regenStatus = 'online';
                        try { regenStatus = getCurrentStatus().status; } catch (_) { /* ignore */ }
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
                        if (isCancelError(err)) {
                            log.info('TextMe regeneration cancelled.');
                            toastr.info(t('TextMe: Cancelled'), '', { timeOut: 1500 });
                        } else {
                            toastr.error(`Regeneration failed: ${err.message}`);
                        }
                    } finally {
                        isGenerating = false;
                        setPhoneGenerating(false);
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
// Header Actions Menu
// ═══════════════════════════════════════════════

/**
 * Open the header ⋮ menu anchored below btnEl.
 * Closes the bubble context menu first (mutual exclusion).
 * Right-aligns the menu to the button edge.
 * Guards against overflow below the viewport (e.g. very tall menus on short screens).
 */
function showHeaderMenu(btnEl) {
    hideContextMenu();
    const menu = document.getElementById('textme-header-menu');
    if (!menu) return;

    menu.style.display = 'block';

    const rect = btnEl.getBoundingClientRect();
    menu.style.top   = (rect.bottom + 4) + 'px';
    menu.style.left  = 'auto';
    menu.style.right = (window.innerWidth - rect.right) + 'px';

    // Guard: if menu overflows below viewport, show it above the button instead.
    requestAnimationFrame(() => {
        const mr = menu.getBoundingClientRect();
        if (mr.bottom > window.innerHeight) {
            menu.style.top = (rect.top - mr.height - 4) + 'px';
        }
    });

    // Dismiss on outside click — stored as named reference for proper cleanup.
    // setTimeout(0) skips the current event so the button-click that opened
    // the menu doesn't immediately close it again.
    _headerMenuDocHandler = (e) => {
        if (!e.target.closest('#textme-header-menu') &&
            !e.target.closest('#textme-btn-edit-contact')) {
            hideHeaderMenu();
        }
    };
    setTimeout(() => document.addEventListener('click', _headerMenuDocHandler), 0);
}

function hideHeaderMenu() {
    const menu = document.getElementById('textme-header-menu');
    if (menu) menu.style.display = 'none';
    if (_headerMenuDocHandler) {
        document.removeEventListener('click', _headerMenuDocHandler);
        _headerMenuDocHandler = null;
    }
}

async function handleHeaderMenuAction(action) {
    hideHeaderMenu();
    switch (action) {
        case 'hm-edit-contact':
            openContactEditModal();
            break;
        case 'hm-force-message':
            await handleForceFirstMessage();
            break;
    }
}

/**
 * Force {{char}} to send an unprompted message — works regardless of whether
 * the chat is empty. Uses the same generation path as handleSend but without
 * a user message and without responseDelay (force = immediate).
 *
 * Safe: uses the same isGenerating / setPhoneGenerating mutex as all other
 * generation paths, so the autonomous timer correctly sees the lock and skips
 * its tick while this is running.
 */
async function handleForceFirstMessage() {
    if (isGenerating) {
        toastr.info(t('TextMe: Already generating'), '', { timeOut: 1500 });
        return;
    }
    phoneAbortController = new AbortController();
    isGenerating = true;
    setPhoneGenerating(true);
    updateSendButton();
    showTyping();
    try {
        const parts = await generatePhoneResponse(phoneAbortController.signal);
        log.info('[ForceMessage] parts:', parts.length);
        hideTyping();
        const phoneData = ensurePhoneData();
        await streamMessages(parts, phoneData);
    } catch (err) {
        hideTyping();
        if (isCancelError(err)) {
            log.info('TextMe force-message cancelled.');
            toastr.info(t('TextMe: Cancelled'), '', { timeOut: 1500 });
        } else {
            log.error('Force message error:', err);
            toastr.error(`TextMe: ${err.message || 'Generation failed'}`);
        }
    } finally {
        isGenerating = false;
        setPhoneGenerating(false);
        phoneAbortController = null;
        hideTyping();
        updateSendButton();
    }
}

// ═══════════════════════════════════════════════
// Phone Toggle
// ═══════════════════════════════════════════════

export function minimizePhone() {
    const phone  = document.getElementById('textme-phone');
    if (phone)  phone.style.display  = 'none';
    const bubble = document.getElementById('textme-bubble');
    if (bubble) bubble.style.display = 'flex';
    phoneOpen = false;
}

export function closePhone() {
    const phone  = document.getElementById('textme-phone');
    if (phone)  phone.style.display  = 'none';
    const bubble = document.getElementById('textme-bubble');
    if (bubble) bubble.style.display = 'none';
    phoneOpen = false;
    log.info('Phone closed (bubble hidden). Use /phone or settings to reopen.');
}

export function togglePhone() {
    const phone  = document.getElementById('textme-phone');
    const bubble = document.getElementById('textme-bubble');
    if (!phone) return;
    if (bubble && bubble.style.display === 'none') { bubble.style.display = 'flex'; }
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
    const { name: customName, avatar: customAvatar } = getContactData();
    const displayName = customName || getCharName();

    const nameEl = document.querySelector('.textme-header-name');
    if (nameEl) nameEl.textContent = displayName;

    // Avatar: custom overrides ST character avatar
    const avatar    = customAvatar || getCharAvatar();
    const avatarEl  = document.querySelector('.textme-header-avatar');
    if (avatarEl) {
        const img = avatarEl.querySelector('img');
        if (avatar) {
            if (img) {
                img.src = avatar;
            } else {
                const dot = avatarEl.querySelector('.textme-status-dot');
                // FIX: img must come BEFORE the dot so the dot overlays correctly via CSS absolute positioning.
                // Fallback creates a new span if the dot element was somehow lost.
                const dotHtml = dot ? dot.outerHTML : '';
                avatarEl.innerHTML = `<img src="${avatar}" alt="${displayName}">${dotHtml}`;
            }
        }
        // If avatar is empty AND there's a placeholder, leave it — nothing to show
    }

    const typingText = document.querySelector('.textme-typing-text');
    if (typingText) typingText.textContent = `${displayName}${t(' is typing...')}`;

    updateStatusDisplay();
}

export function updateStatusDisplay() {
    try {
        const { status, activity, isManual } = getCurrentStatus();
        const { label, cssClass }            = getStatusInfo(status);

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
    if (el) { el.textContent = getFormattedGameTime(); }
}

// ═══════════════════════════════════════════════
// Clear Chat
// ═══════════════════════════════════════════════

export async function clearPhoneChat() {
    const phoneData = getPhoneData();
    if (!phoneData) return;
    if (!confirm(t('Clear all phone messages?'))) return;
    phoneData.messages        = [];
    phoneData.lastActivity    = null;
    phoneData.autonomousCount = 0;
    await savePhoneData();
    updateRpInjection();
    renderMessages();
    toastr.success(t('Phone chat cleared'));
}

// ═══════════════════════════════════════════════
// Contact Edit Modal
// ═══════════════════════════════════════════════

/**
 * Cropper state — lives for the lifetime of one modal open session.
 * Cleared on closeContactEditModal().
 */
let _cropState = null; // { img, offsetX, offsetY, scale, canvasSize }

// ── Cropper helpers ────────────────────────────────────────────────────────────

const CROP_SIZE = 240; // canvas render size (px); exported square is also this

/**
 * Draw the current crop frame onto the canvas.
 * Renders the image at (offsetX, offsetY) with the current scale,
 * then overlays a circular clip mask and a subtle grid/border.
 */
function _drawCrop() {
    const s = _cropState;
    if (!s) return;
    const canvas = document.getElementById('textme-contact-crop-canvas');
    if (!canvas) return;
    const ctx  = canvas.getContext('2d');
    const size = s.canvasSize;
    ctx.clearRect(0, 0, size, size);

    // Draw image
    const w = s.img.naturalWidth  * s.scale;
    const h = s.img.naturalHeight * s.scale;
    ctx.drawImage(s.img, s.offsetX, s.offsetY, w, h);

    // Dim outside circle
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.rect(0, 0, size, size);
    ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2, true);
    ctx.fill();
    ctx.restore();

    // Circle border
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
}

/**
 * Clamp offsets so the image always covers the full canvas square.
 */
function _clampCropOffset(s) {
    const w    = s.img.naturalWidth  * s.scale;
    const h    = s.img.naturalHeight * s.scale;
    const size = s.canvasSize;
    // Max offset: image left/top edge can't go right/below canvas origin
    s.offsetX = Math.min(0, s.offsetX);
    s.offsetY = Math.min(0, s.offsetY);
    // Min offset: image right/bottom edge can't go left/above canvas end
    s.offsetX = Math.max(size - w, s.offsetX);
    s.offsetY = Math.max(size - h, s.offsetY);
}

/**
 * Load an image src into the cropper: show crop zone, hide preview, init state.
 */
function _initCropper(src) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
        const canvas = document.getElementById('textme-contact-crop-canvas');
        if (!canvas) return;
        const size   = CROP_SIZE;
        canvas.width = size;
        canvas.height = size;

        // Fit image to cover the square (like object-fit: cover)
        const scaleX = size / img.naturalWidth;
        const scaleY = size / img.naturalHeight;
        const scale  = Math.max(scaleX, scaleY);
        const w      = img.naturalWidth  * scale;
        const h      = img.naturalHeight * scale;

        _cropState = {
            img,
            offsetX:  (size - w) / 2,
            offsetY:  (size - h) / 2,
            scale,
            minScale: scale,
            canvasSize: size,
        };
        _drawCrop();

        // Show crop zone, hide avatar preview
        const cropWrap    = document.getElementById('textme-contact-crop-wrap');
        const previewWrap = document.getElementById('textme-contact-preview-wrap');
        if (cropWrap)    cropWrap.style.display    = 'block';
        if (previewWrap) previewWrap.style.display = 'none';
    };
    img.onerror = () => { toastr.error(t('Could not load image')); };
    img.src = src;
}

/**
 * Export the current crop as a square data URI (JPEG, 0.92 quality).
 * Returns null if cropper is not active.
 */
function _exportCrop() {
    const s = _cropState;
    if (!s) return null;
    // Draw to an offscreen canvas at the crop size
    const out = document.createElement('canvas');
    out.width  = CROP_SIZE;
    out.height = CROP_SIZE;
    const ctx  = out.getContext('2d');
    // Clip to circle
    ctx.beginPath();
    ctx.arc(CROP_SIZE / 2, CROP_SIZE / 2, CROP_SIZE / 2, 0, Math.PI * 2);
    ctx.clip();
    const w = s.img.naturalWidth  * s.scale;
    const h = s.img.naturalHeight * s.scale;
    ctx.drawImage(s.img, s.offsetX, s.offsetY, w, h);
    return out.toDataURL('image/jpeg', 0.92);
}

// ── Cropper pointer / touch / wheel events ──────────────────────────────────────

let _cropDragActive = false;
let _cropDragLastX  = 0;
let _cropDragLastY  = 0;
// Touch: track two fingers for pinch-zoom
let _cropTouches = [];

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
    const s      = _cropState;
    const delta  = e.deltaY < 0 ? 1.08 : 0.93;
    const newScale = Math.max(s.minScale, s.scale * delta);
    // Zoom toward canvas center
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
        // Pan
        const dx = touches[0].clientX - _cropTouches[0].clientX;
        const dy = touches[0].clientY - _cropTouches[0].clientY;
        _cropState.offsetX += dx;
        _cropState.offsetY += dy;
        _clampCropOffset(_cropState);
        _drawCrop();
    } else if (touches.length === 2 && _cropTouches.length === 2) {
        // Pinch zoom
        const prevDist = Math.hypot(
            _cropTouches[0].clientX - _cropTouches[1].clientX,
            _cropTouches[0].clientY - _cropTouches[1].clientY,
        );
        const newDist = Math.hypot(
            touches[0].clientX - touches[1].clientX,
            touches[0].clientY - touches[1].clientY,
        );
        if (prevDist === 0) return;
        const s        = _cropState;
        const newScale = Math.max(s.minScale, s.scale * (newDist / prevDist));
        const cx       = s.canvasSize / 2;
        const cy       = s.canvasSize / 2;
        s.offsetX = cx - (cx - s.offsetX) * (newScale / s.scale);
        s.offsetY = cy - (cy - s.offsetY) * (newScale / s.scale);
        s.scale   = newScale;
        _clampCropOffset(s);
        _drawCrop();
    }
    _cropTouches = touches;
}
function _cropOnTouchEnd(e) { _cropTouches = Array.from(e.touches); }

/** Attach all crop canvas event listeners. */
function _attachCropListeners(canvas) {
    canvas.addEventListener('pointerdown',  _cropOnPointerDown);
    canvas.addEventListener('pointermove',  _cropOnPointerMove);
    canvas.addEventListener('pointerup',    _cropOnPointerUp);
    canvas.addEventListener('pointercancel',_cropOnPointerUp);
    canvas.addEventListener('wheel',        _cropOnWheel,        { passive: false });
    canvas.addEventListener('touchstart',   _cropOnTouchStart,   { passive: true });
    canvas.addEventListener('touchmove',    _cropOnTouchMove,    { passive: false });
    canvas.addEventListener('touchend',     _cropOnTouchEnd,     { passive: true });
}
/** Remove all crop canvas event listeners. */
function _detachCropListeners(canvas) {
    canvas.removeEventListener('pointerdown',  _cropOnPointerDown);
    canvas.removeEventListener('pointermove',  _cropOnPointerMove);
    canvas.removeEventListener('pointerup',    _cropOnPointerUp);
    canvas.removeEventListener('pointercancel',_cropOnPointerUp);
    canvas.removeEventListener('wheel',        _cropOnWheel);
    canvas.removeEventListener('touchstart',   _cropOnTouchStart);
    canvas.removeEventListener('touchmove',    _cropOnTouchMove);
    canvas.removeEventListener('touchend',     _cropOnTouchEnd);
}

// ── Modal open / close / save / reset ────────────────────────────────────────────

/**
 * Refresh the avatar preview circle (not the crop zone).
 * Uses the given URL (data: or http/https) or falls back to the ST avatar.
 */
function _refreshContactModalPreview(url) {
    const previewEl = document.getElementById('textme-contact-modal-avatar');
    if (!previewEl) return;
    const src = url?.trim() || getCharAvatar();
    if (src) {
        previewEl.innerHTML = `<img src="${src}" alt="avatar">`;
    } else {
        previewEl.innerHTML = `<span class="textme-avatar-placeholder">${getCharName().charAt(0).toUpperCase()}</span>`;
    }
}

/** Open the contact-edit modal, pre-filling current custom values. */
function openContactEditModal() {
    const modal = document.getElementById('textme-contact-modal');
    if (!modal) return;

    // Reset cropper state from previous session
    _cropState      = null;
    _cropDragActive = false;
    const canvas    = document.getElementById('textme-contact-crop-canvas');
    if (canvas) { _detachCropListeners(canvas); _attachCropListeners(canvas); }

    const cropWrap    = document.getElementById('textme-contact-crop-wrap');
    const previewWrap = document.getElementById('textme-contact-preview-wrap');
    if (cropWrap)    cropWrap.style.display    = 'none';
    if (previewWrap) previewWrap.style.display = 'flex';

    // Sync scope toggle to current setting
    const settings = getSettings();
    _updateScopeToggleUI(settings.contactScope || 'chat');

    // Pre-fill fields from the active scope's data
    const { name: currentName, avatar: currentAvatar } = getContactData();
    const nameInput = document.getElementById('textme-contact-name-input');
    const urlInput  = document.getElementById('textme-contact-url-input');
    if (nameInput) nameInput.value = currentName;
    if (urlInput)  urlInput.value  = currentAvatar;

    // Show current avatar in preview
    _refreshContactModalPreview(currentAvatar);

    modal.style.display = 'flex';

    // URL input → live preview (only if no crop active)
    urlInput?.addEventListener('input', _onContactUrlInput);
}

/** Update the active state of the scope toggle buttons. */
function _updateScopeToggleUI(scope) {
    document.querySelectorAll('#textme-contact-scope-toggle .textme-scope-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.scope === scope);
    });
}

function _onContactUrlInput(e) {
    if (!_cropState) _refreshContactModalPreview(e.target.value);
}

/** Close the modal and clean up. */
function closeContactEditModal() {
    const modal    = document.getElementById('textme-contact-modal');
    const urlInput = document.getElementById('textme-contact-url-input');
    const canvas   = document.getElementById('textme-contact-crop-canvas');
    if (urlInput) urlInput.removeEventListener('input', _onContactUrlInput);
    if (canvas)   _detachCropListeners(canvas);
    _cropState      = null;
    _cropDragActive = false;
    if (modal) modal.style.display = 'none';
}

/** Save custom name/avatar from modal fields and refresh header. */
async function saveContactEdit() {
    const nameInput = document.getElementById('textme-contact-name-input');
    const urlInput  = document.getElementById('textme-contact-url-input');
    const name      = nameInput?.value.trim() || '';
    // If the cropper was used, export the crop result; otherwise use the URL field
    const avatar = _cropState
        ? (_exportCrop() || urlInput?.value.trim() || '')
        : (urlInput?.value.trim() || '');
    setContactData(name, avatar);
    const settings = getSettings();
    if (settings.contactScope === 'character') {
        await SillyTavern.getContext().saveSettingsDebounced?.();
    } else {
        await savePhoneData();
    }
    closeContactEditModal();
    updatePhoneHeader();
}

/** Reset custom name and avatar back to defaults. */
async function resetContactEdit() {
    setContactData('', '');
    const settings = getSettings();
    if (settings.contactScope === 'character') {
        await SillyTavern.getContext().saveSettingsDebounced?.();
    } else {
        await savePhoneData();
    }
    closeContactEditModal();
    updatePhoneHeader();
    toastr.success(t('Contact reset to default'));
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

    // ── Visual Viewport API (mobile keyboard fix) ─────────────────────────────
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
            : t('Status back to schedule');
        toastr.info(msg, '', { timeOut: 1500 });
    });

    document.querySelector('.textme-btn-clear')?.addEventListener('click', clearPhoneChat);

    // ── Header ⋮ menu ───────────────────────────────────────────────────────────
    document.getElementById('textme-btn-edit-contact')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const menu = document.getElementById('textme-header-menu');
        if (menu?.style.display === 'block') {
            hideHeaderMenu();
        } else {
            showHeaderMenu(e.currentTarget);
        }
    });

    document.getElementById('textme-header-menu')?.addEventListener('click', (e) => {
        const item = e.target.closest('.textme-ctx-item');
        if (item) handleHeaderMenuAction(item.dataset.action);
    });

    // ── Contact Edit Modal ──────────────────────────────────────────────────────
    document.getElementById('textme-contact-save-btn')?.addEventListener('click', saveContactEdit);
    document.getElementById('textme-contact-cancel-btn')?.addEventListener('click', closeContactEditModal);
    document.getElementById('textme-contact-reset-btn')?.addEventListener('click', resetContactEdit);

    // Scope toggle — switching scope reloads the fields from the new source
    document.getElementById('textme-contact-scope-toggle')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.textme-scope-btn');
        if (!btn) return;
        const scope = btn.dataset.scope;
        updateSetting('contactScope', scope);
        SillyTavern.getContext().saveSettingsDebounced?.();
        _updateScopeToggleUI(scope);
        // Reload fields from the newly selected scope
        const { name, avatar } = getContactData();
        const nameInput = document.getElementById('textme-contact-name-input');
        const urlInput  = document.getElementById('textme-contact-url-input');
        if (nameInput) nameInput.value = name;
        if (urlInput)  urlInput.value  = avatar;
        if (!_cropState) _refreshContactModalPreview(avatar);
    });

    // File upload → convert to data URI and fill URL input + preview
    document.getElementById('textme-contact-file-input')?.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        // Reset file input so the same file can be re-selected later
        e.target.value = '';
        const reader = new FileReader();
        reader.onload = (ev) => {
            // Clear URL field — the cropped result will replace it on Save
            const urlInput = document.getElementById('textme-contact-url-input');
            if (urlInput) urlInput.value = '';
            // Launch cropper with the loaded data URI
            _initCropper(ev.target.result);
        };
        reader.readAsDataURL(file);
    });

    // Close modal on backdrop click
    document.getElementById('textme-contact-modal')?.addEventListener('click', (e) => {
        if (e.target === document.getElementById('textme-contact-modal')) {
            closeContactEditModal();
        }
    });

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
            if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = null; }
        });
        sendBtn.addEventListener('touchmove', () => {
            if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = null; }
        });
    }

    const input = document.getElementById('textme-input');
    if (input) {
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                if (!getSettings().sendOnEnter) return; // setting OFF — Enter inserts newline
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

    // ── Reply button (hover / desktop) ────────────────────────────────────────────
    // Delegated click on .textme-reply-btn inside the messages container.
    document.getElementById('textme-messages')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.textme-reply-btn');
        if (btn) {
            e.stopPropagation();
            const idx = parseInt(btn.dataset.idx, 10);
            if (!isNaN(idx)) setPendingReply(idx);
            return;
        }
        // Click on a quote block → scroll to the original message
        const quote = e.target.closest('.textme-reply-quote');
        if (quote) {
            const replyIdx = parseInt(quote.dataset.replyIdx, 10);
            if (!isNaN(replyIdx)) scrollToMessage(replyIdx);
        }
    });

    // ── Swipe-right to reply (touch / mobile) ─────────────────────────────────────
    // Track touchstart X/Y on each message bubble and trigger reply on right swipe ≥ 50px.
    let _swipeMsgEl    = null;
    let _swipeStartX   = 0;
    let _swipeStartY   = 0;
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
        // Only horizontal swipe, not mostly vertical
        if (dx > 50 && dy < 40) {
            _swipeTriggered = true;
            const idx = parseInt(_swipeMsgEl.dataset.idx, 10);
            if (!isNaN(idx)) {
                // Visual feedback: translate bubble slightly right, then snap back
                const wrap = _swipeMsgEl.querySelector('.textme-bubble-wrap');
                if (wrap) {
                    wrap.style.transition = 'transform 0.1s ease';
                    wrap.style.transform  = 'translateX(18px)';
                    setTimeout(() => {
                        wrap.style.transform  = '';
                        wrap.style.transition = 'transform 0.2s ease';
                        setTimeout(() => { wrap.style.transition = ''; }, 200);
                    }, 150);
                }
                setPendingReply(idx);
            }
        }
    }, { passive: true });

    document.getElementById('textme-messages')?.addEventListener('touchend', () => {
        _swipeMsgEl    = null;
        _swipeTriggered = false;
    }, { passive: true });

    let longPressTimer = null;
    document.getElementById('textme-messages')?.addEventListener('touchstart', (e) => {
        const msgEl = e.target.closest('.textme-msg');
        if (!msgEl) return;
        longPressTimer = setTimeout(() => {
            longPressTimer = null;
            const touch = e.touches[0];
            showContextMenu(
                { preventDefault: () => {}, clientX: touch.clientX, clientY: touch.clientY },
                msgEl
            );
        }, 500);
    });
    // Cancel long-press if the finger moves (scroll or swipe gesture)
    document.getElementById('textme-messages')?.addEventListener('touchmove', () => {
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    }, { passive: true });
    document.getElementById('textme-messages')?.addEventListener('touchend', () => {
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
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

    // Initialize audio context for notification sounds (fire-and-forget)
    initNotifications();

    // Register SMS history injection into RP context (if enabled)
    updateRpInjection();

    phoneOpen = false;
}

function applyPhonePosition() {
    const phone = document.getElementById('textme-phone');
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

    // Stop autonomous timer — callers that immediately re-init will restart it
    stopAutonomousTimer();

    // Abort any in-flight TextMe generation when the UI is destroyed
    if (phoneAbortController) {
        phoneAbortController.abort();
        phoneAbortController = null;
    }

    // FIX: Remove document-level click handler for bubble context menu
    if (_docClickHandler) {
        document.removeEventListener('click', _docClickHandler);
        _docClickHandler = null;
    }

    // FIX: Remove document-level click handler for header actions menu
    if (_headerMenuDocHandler) {
        document.removeEventListener('click', _headerMenuDocHandler);
        _headerMenuDocHandler = null;
    }

    // FIX: Remove window resize handler from drag.js
    cleanupDragListeners();

    // FIX: Remove Visual Viewport API listeners and clear CSS vars
    cleanupVisualViewport();

    // Clear SMS injection from RP context
    clearRpInjection();

    phoneOpen    = false;
    isGenerating = false;
    setPhoneGenerating(false);
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
        // Parse > quote from the model's output — for EVERY bubble.
        const parsed    = parseReplyQuote(parts[i], phoneData.messages);
        const finalText = parsed.text;
        const replyTo   = parsed.replyTo;
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
    if (!phoneOpen) { updateBadge(parts.length); }
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
        badge.textContent   = '0';
        badge.style.display = 'none';
    }
}
