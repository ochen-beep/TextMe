/**
 * TextMe — Phone UI
 * License: AGPL-3.0
 *
 * Creates and manages the phone messenger interface.
 * Fixes: enable toggle, scrollbar, close vs minimize,
 * streaming messages, drag support, resize support.
 */

import { EXTENSION_NAME, getSettings, getPhoneData, savePhoneData, getCharName, getUserName, hasCharacter, updateSetting } from './state.js';
import { generatePhoneResponse } from './prompt-engine.js';
import { getCurrentStatus, getStatusInfo } from './schedule.js';
import { makeBubbleDraggable, makePhoneDraggable, makePhoneResizable } from './drag.js';
import { log } from './logger.js';

let phoneOpen = false;
let isGenerating = false;
let statusTimeInterval = null;

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
    const avatar = getCharAvatar();
    const settings = getSettings();
    const theme = settings.theme || 'dark';
    const scheme = settings.colorScheme || 'default';

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
            <div class="textme-header-avatar">
                ${avatar ? `<img src="${avatar}" alt="" />` : `<div class="textme-avatar-placeholder"><i class="fa-solid fa-user"></i></div>`}
                <span class="textme-status-dot textme-status-online" id="textme-status-dot" title="Online"></span>
            </div>
            <div class="textme-header-info">
                <div class="textme-header-name">${charName}</div>
                <div class="textme-header-status" id="textme-header-status">Online</div>
            </div>
            <div class="textme-header-actions">
                <button class="textme-btn-icon textme-btn-clear" title="Clear chat">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
                <button class="textme-btn-icon textme-btn-close" title="Close phone">
                    <i class="fa-solid fa-xmark"></i>
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
            <button id="textme-send" class="textme-btn-send" title="Send">
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
    const date = new Date(timestamp);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (date.toDateString() === today.toDateString()) return 'Today';
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return date.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function renderMessages() {
    const container = document.getElementById('textme-messages');
    if (!container) return;

    const phoneData = getPhoneData();
    const settings = getSettings();

    if (!phoneData || phoneData.messages.length === 0) {
        container.innerHTML = `
            <div class="textme-empty-state">
                <i class="fa-regular fa-comment-dots"></i>
                <p>Start a conversation!</p>
            </div>`;
        return;
    }

    let html = '';
    let lastDay = '';

    for (let i = 0; i < phoneData.messages.length; i++) {
        const msg = phoneData.messages[i];
        const day = new Date(msg.time).toDateString();

        if (day !== lastDay) {
            html += `<div class="textme-day-sep">${formatDaySeparator(msg.time)}</div>`;
            lastDay = day;
        }

        const prevMsg = i > 0 ? phoneData.messages[i - 1] : null;
        const isGrouped = prevMsg && prevMsg.isUser === msg.isUser &&
            (msg.time - prevMsg.time) < 120000;

        const side = msg.isUser ? 'user' : 'char';
        const grouped = isGrouped ? 'textme-grouped' : '';
        const timeHtml = settings.showTimestamps && !isGrouped
            ? `<span class="textme-msg-time">${formatTime(msg.time)}</span>`
            : '';

        if (msg.type === 'image') {
            html += `
                <div class="textme-msg textme-msg-${side} ${grouped}" data-idx="${i}">
                    <div class="textme-bubble-wrap">
                        <div class="textme-bubble-content">
                            <img src="${escapeHtml(msg.src)}" class="textme-msg-image" alt="image" />
                        </div>
                        ${timeHtml}
                    </div>
                </div>`;
        } else {
            html += `
                <div class="textme-msg textme-msg-${side} ${grouped}" data-idx="${i}">
                    <div class="textme-bubble-wrap">
                        <div class="textme-bubble-content">${escapeHtml(msg.text)}</div>
                        ${timeHtml}
                    </div>
                </div>`;
        }
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

    const settings = getSettings();
    const side = msg.isUser ? 'user' : 'char';

    const phoneData = getPhoneData();
    const prevIdx = index - 1;
    const prevMsg = prevIdx >= 0 ? phoneData?.messages[prevIdx] : null;
    const isGrouped = prevMsg && prevMsg.isUser === msg.isUser &&
        (msg.time - prevMsg.time) < 120000;

    const timeHtml = settings.showTimestamps && !isGrouped
        ? `<span class="textme-msg-time">${formatTime(msg.time)}</span>`
        : '';

    const div = document.createElement('div');
    div.className = `textme-msg textme-msg-${side}${isGrouped ? ' textme-grouped' : ''}`;
    div.dataset.idx = index;

    if (msg.type === 'image') {
        div.innerHTML = `
            <div class="textme-bubble-wrap">
                <div class="textme-bubble-content">
                    <img src="${escapeHtml(msg.src)}" class="textme-msg-image" alt="image" />
                </div>
                ${timeHtml}
            </div>`;
    } else {
        div.innerHTML = `
            <div class="textme-bubble-wrap">
                <div class="textme-bubble-content">${escapeHtml(msg.text)}</div>
                ${timeHtml}
            </div>`;
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
// Streaming Messages (simulate typing delay)
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

        const charMsg = { isUser: false, text, time: Date.now() };
        phoneData.messages.push(charMsg);
        appendMessage(charMsg, phoneData.messages.length - 1);

        if (i < messageParts.length - 1) {
            await sleep(200);
        }
    }

    phoneData.lastActivity = Date.now();
    phoneData.autonomousCount = 0;
    await savePhoneData();
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════════
// Send Message
// ═══════════════════════════════════════════════

async function handleSend() {
    if (isGenerating) {
        log.warn('Already generating, ignoring send.');
        return;
    }

    const input = document.getElementById('textme-input');
    if (!input) {
        log.error('Input element not found!');
        return;
    }

    const text = input.value.trim();
    if (!text) return;

    // FIX: Block response when character is offline
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

    const phoneData = getPhoneData();
    if (!phoneData) {
        log.error('No phone data available!');
        return;
    }

    // Append user bubble immediately
    const userMsg = { isUser: true, text, time: Date.now() };
    phoneData.messages.push(userMsg);
    phoneData.lastActivity = Date.now();
    phoneData.autonomousCount = 0;
    appendMessage(userMsg, phoneData.messages.length - 1);
    await savePhoneData();

    // Generate response
    isGenerating = true;
    showTyping();
    updateSendButton();

    try {
        const parts = await generatePhoneResponse(text);
        log.info('Got response parts:', parts.length);

        const initialDelay = 500 + Math.random() * 1000;
        await sleep(initialDelay);

        hideTyping();
        await streamMessages(parts, phoneData);

    } catch (err) {
        log.error('Generation error:', err);
        hideTyping();
        toastr.error(`TextMe: ${err.message || 'Generation failed'}`);
    } finally {
        isGenerating = false;
        hideTyping();
        updateSendButton();
    }
}

function updateSendButton() {
    const btn = document.getElementById('textme-send');
    if (!btn) return;
    if (isGenerating) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    } else {
        btn.disabled = false;
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
    const idx = parseInt(msgEl.dataset.idx, 10);
    const phoneData = getPhoneData();
    const msg = phoneData?.messages[idx];

    const regenItem = menu.querySelector('[data-action="regenerate"]');
    if (regenItem) {
        regenItem.style.display = msg && !msg.isUser ? '' : 'none';
    }

    menu.style.display = 'block';
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';

    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
        menu.style.left = (window.innerWidth - rect.width - 5) + 'px';
    }
    if (rect.bottom > window.innerHeight) {
        menu.style.top = (window.innerHeight - rect.height - 5) + 'px';
    }
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
                // FIX: Save the last user message BEFORE splice, because indices shift after removal.
                let lastUserMsg = '';
                for (let i = idx - 1; i >= 0; i--) {
                    if (phoneData.messages[i]?.isUser) {
                        lastUserMsg = phoneData.messages[i].text;
                        break;
                    }
                }

                phoneData.messages.splice(idx, 1);
                await savePhoneData();
                renderMessages();

                if (lastUserMsg) {
                    isGenerating = true;
                    showTyping();
                    updateSendButton();
                    try {
                        const parts = await generatePhoneResponse(lastUserMsg);
                        hideTyping();
                        await streamMessages(parts, phoneData);
                    } catch (err) {
                        hideTyping();
                        toastr.error(`Regeneration failed: ${err.message}`);
                    } finally {
                        isGenerating = false;
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
// Phone Toggle — minimize vs close
// ═══════════════════════════════════════════════

/** Minimize = hide phone, show bubble */
export function minimizePhone() {
    const phone = document.getElementById('textme-phone');
    if (phone) phone.style.display = 'none';

    const bubble = document.getElementById('textme-bubble');
    if (bubble) bubble.style.display = 'flex';

    phoneOpen = false;
}

/**
 * Close = hide BOTH phone and bubble.
 * User must use /phone or re-enable in settings to get it back.
 */
export function closePhone() {
    const phone = document.getElementById('textme-phone');
    if (phone) phone.style.display = 'none';

    const bubble = document.getElementById('textme-bubble');
    if (bubble) bubble.style.display = 'none';

    phoneOpen = false;
    log.info('Phone closed (bubble hidden). Use /phone or settings to reopen.');
}

/** Toggle phone visibility */
export function togglePhone() {
    const phone = document.getElementById('textme-phone');
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

    const avatar = getCharAvatar();
    const avatarEl = document.querySelector('.textme-header-avatar');
    if (avatarEl) {
        if (avatar) {
            const img = avatarEl.querySelector('img');
            if (img) {
                img.src = avatar;
            } else {
                avatarEl.innerHTML = `<img src="${avatar}" alt="" /><span class="textme-status-dot textme-status-online" id="textme-status-dot"></span>`;
            }
        }
    }

    const typingText = document.querySelector('.textme-typing-text');
    if (typingText) typingText.textContent = `${getCharName()} is typing...`;

    // FIX: Update status dot and text from schedule
    updateStatusDisplay();
}

/**
 * Update the header status dot and text based on current schedule.
 * FIX: Was always showing "Online" regardless of schedule.
 */
function updateStatusDisplay() {
    try {
        const { status, activity } = getCurrentStatus();
        const { label, cssClass } = getStatusInfo(status);

        const dot = document.getElementById('textme-status-dot');
        if (dot) {
            dot.className = `textme-status-dot ${cssClass}`;
            dot.title = label;
        }

        const statusText = document.getElementById('textme-header-status');
        if (statusText) {
            statusText.textContent = activity ? `${label} — ${activity}` : label;
        }
    } catch (e) {
        log.warn('Could not update status display:', e);
    }
}

function updateStatusBarTime() {
    const el = document.querySelector('.textme-time-display');
    if (el) {
        el.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
}

// ═══════════════════════════════════════════════
// Clear Chat
// ═══════════════════════════════════════════════

export async function clearPhoneChat() {
    const phoneData = getPhoneData();
    if (!phoneData) return;

    if (!confirm('Clear all phone messages?')) return;

    phoneData.messages = [];
    phoneData.lastActivity = null;
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

    const wrapper = document.createElement('div');
    wrapper.id = 'textme-container';
    wrapper.innerHTML = createPhoneHTML();
    document.body.appendChild(wrapper);

    applyPhonePosition();

    const phone = document.getElementById('textme-phone');
    const header = document.getElementById('textme-header');
    const bubble = document.getElementById('textme-bubble');

    makePhoneDraggable(phone, header);
    makePhoneResizable(phone);
    makeBubbleDraggable(bubble);

    // ── Event Listeners ──

    bubble?.addEventListener('click', togglePhone);

    document.querySelector('.textme-header-back')?.addEventListener('click', minimizePhone);
    document.querySelector('.textme-btn-close')?.addEventListener('click', closePhone);
    document.querySelector('.textme-btn-clear')?.addEventListener('click', clearPhoneChat);

    document.getElementById('textme-send')?.addEventListener('click', handleSend);

    const input = document.getElementById('textme-input');
    if (input) {
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
            }
        });
        input.addEventListener('input', autoResizeInput);
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
            showContextMenu({ preventDefault: () => {}, clientX: touch.clientX, clientY: touch.clientY }, msgEl);
        }, 500);
    });
    document.getElementById('textme-messages')?.addEventListener('touchend', () => {
        if (longPressTimer) clearTimeout(longPressTimer);
    });

    document.getElementById('textme-context-menu')?.addEventListener('click', (e) => {
        const item = e.target.closest('.textme-ctx-item');
        if (item) handleContextAction(item.dataset.action);
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('#textme-context-menu')) hideContextMenu();
    });

    updateStatusBarTime();
    statusTimeInterval = setInterval(updateStatusBarTime, 60000);

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

    phoneOpen = false;
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

/**
 * Add an autonomous/external message directly and show it.
 */
export async function addExternalMessages(parts) {
    const phoneData = getPhoneData();
    if (!phoneData) return;

    showTyping();

    for (let i = 0; i < parts.length; i++) {
        const delay = 600 + Math.random() * 1200;
        await sleep(delay);

        hideTyping();

        const msg = { isUser: false, text: parts[i], time: Date.now() };
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

    const current = parseInt(badge.textContent || '0', 10);
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
        badge.textContent = '0';
        badge.style.display = 'none';
    }
}
