/**
 * TextMe — Phone UI
 * License: AGPL-3.0
 *
 * Creates and manages the phone messenger interface.
 */

import { EXTENSION_NAME, getSettings, getPhoneData, savePhoneData, getCharName, getUserName } from './state.js';
import { sendAndReceive } from './prompt-engine.js';

let phoneOpen = false;
let isGenerating = false;

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

        <!-- Header -->
        <div class="textme-header">
            <div class="textme-header-back" title="Minimize">
                <i class="fa-solid fa-chevron-left"></i>
            </div>
            <div class="textme-header-avatar">
                ${avatar ? `<img src="${avatar}" alt="" />` : `<div class="textme-avatar-placeholder"><i class="fa-solid fa-user"></i></div>`}
                <span class="textme-status-dot textme-status-online" title="Online"></span>
            </div>
            <div class="textme-header-info">
                <div class="textme-header-name">${charName}</div>
                <div class="textme-header-status">Online</div>
            </div>
            <div class="textme-header-actions">
                <button class="textme-btn-icon textme-btn-clear" title="Clear chat">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
                <button class="textme-btn-icon textme-btn-close" title="Close">
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

        // Day separator
        if (day !== lastDay) {
            html += `<div class="textme-day-sep">${formatDaySeparator(msg.time)}</div>`;
            lastDay = day;
        }

        // Check if this is part of a group (consecutive messages from same sender)
        const prevMsg = i > 0 ? phoneData.messages[i - 1] : null;
        const isGrouped = prevMsg && prevMsg.isUser === msg.isUser &&
            (msg.time - prevMsg.time) < 60000; // within 1 minute

        const side = msg.isUser ? 'user' : 'char';
        const grouped = isGrouped ? 'textme-grouped' : '';
        const timeHtml = settings.showTimestamps ? `<span class="textme-msg-time">${formatTime(msg.time)}</span>` : '';

        if (msg.type === 'image') {
            html += `
                <div class="textme-msg textme-msg-${side} ${grouped}" data-idx="${i}">
                    <div class="textme-bubble-wrap">
                        <div class="textme-bubble-content">
                            <img src="${escapeHtml(msg.src)}" class="textme-msg-image" alt="selfie" />
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

    // Remove empty state if present
    const empty = container.querySelector('.textme-empty-state');
    if (empty) empty.remove();

    const settings = getSettings();
    const side = msg.isUser ? 'user' : 'char';
    const timeHtml = settings.showTimestamps ? `<span class="textme-msg-time">${formatTime(msg.time)}</span>` : '';

    const div = document.createElement('div');
    div.className = `textme-msg textme-msg-${side}`;
    div.dataset.idx = index;
    div.innerHTML = `
        <div class="textme-bubble-wrap">
            <div class="textme-bubble-content">${escapeHtml(msg.text)}</div>
            ${timeHtml}
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
// Send Message
// ═══════════════════════════════════════════════

async function handleSend() {
    if (isGenerating) return;

    const input = document.getElementById('textme-input');
    if (!input) return;

    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    autoResizeInput();

    // Append user bubble immediately
    const phoneData = getPhoneData();
    if (!phoneData) return;

    const userMsg = { isUser: true, text, time: Date.now() };
    phoneData.messages.push(userMsg);
    appendMessage(userMsg, phoneData.messages.length - 1);

    // Save and generate
    isGenerating = true;
    showTyping();
    updateSendButton();

    try {
        const { generatePhoneResponse } = await import('./prompt-engine.js');
        const reply = await generatePhoneResponse(text);

        // Note: generatePhoneResponse doesn't save messages anymore —
        // sendAndReceive does, but we do it manually here for better UX
        const charMsg = { isUser: false, text: reply, time: Date.now() };
        phoneData.messages.push(charMsg);
        phoneData.lastActivity = Date.now();
        phoneData.autonomousCount = 0;
        appendMessage(charMsg, phoneData.messages.length - 1);

        await (await import('./state.js')).savePhoneData();
    } catch (err) {
        console.error(`[${EXTENSION_NAME}] Generation error:`, err);
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
    input.style.height = Math.min(input.scrollHeight, 100) + 'px';
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

    // Show/hide regenerate based on message type
    const regenItem = menu.querySelector('[data-action="regenerate"]');
    if (regenItem) {
        regenItem.style.display = msg && !msg.isUser ? '' : 'none';
    }

    menu.style.display = 'block';
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';

    // Keep menu in viewport
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
            const { Popup } = SillyTavern.getContext();
            if (Popup?.show?.input) {
                const newText = await Popup.show.input('Edit Message', 'Edit the message text:', msg.text);
                if (newText !== null && newText !== undefined) {
                    phoneData.messages[idx].text = newText;
                    await savePhoneData();
                    renderMessages();
                }
            }
            break;
        }

        case 'regenerate':
            if (msg.isUser) break;
            // Remove the last assistant message and regenerate
            phoneData.messages.splice(idx, 1);
            await savePhoneData();
            renderMessages();

            // Find the last user message before this
            let lastUserMsg = '';
            for (let i = idx - 1; i >= 0; i--) {
                if (phoneData.messages[i]?.isUser) {
                    lastUserMsg = phoneData.messages[i].text;
                    break;
                }
            }
            if (lastUserMsg) {
                isGenerating = true;
                showTyping();
                updateSendButton();
                try {
                    const { generatePhoneResponse } = await import('./prompt-engine.js');
                    const reply = await generatePhoneResponse(lastUserMsg);
                    const charMsg = { isUser: false, text: reply, time: Date.now() };
                    phoneData.messages.push(charMsg);
                    phoneData.lastActivity = Date.now();
                    appendMessage(charMsg, phoneData.messages.length - 1);
                    await savePhoneData();
                } catch (err) {
                    toastr.error(`Regeneration failed: ${err.message}`);
                } finally {
                    isGenerating = false;
                    hideTyping();
                    updateSendButton();
                }
            }
            break;
    }

    hideContextMenu();
}

// ═══════════════════════════════════════════════
// Phone Toggle
// ═══════════════════════════════════════════════

export function togglePhone() {
    const phone = document.getElementById('textme-phone');
    if (!phone) return;

    phoneOpen = !phoneOpen;
    phone.style.display = phoneOpen ? 'flex' : 'none';

    if (phoneOpen) {
        renderMessages();
        updatePhoneHeader();
        updateStatusBarTime();

        // Focus input
        setTimeout(() => {
            const input = document.getElementById('textme-input');
            if (input) input.focus();
        }, 100);
    }
}

export function openPhone() {
    if (!phoneOpen) togglePhone();
}

export function closePhone() {
    if (phoneOpen) togglePhone();
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
                avatarEl.innerHTML = `<img src="${avatar}" alt="" /><span class="textme-status-dot textme-status-online"></span>`;
            }
        }
    }

    // Update typing indicator name
    const typingText = document.querySelector('.textme-typing-text');
    if (typingText) typingText.textContent = `${getCharName()} is typing...`;
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

    const { Popup, POPUP_RESULT } = SillyTavern.getContext();
    if (Popup?.show?.confirm) {
        const confirmed = await Popup.show.confirm('Clear Phone Chat', 'Are you sure you want to clear all phone messages?');
        if (confirmed !== POPUP_RESULT?.AFFIRMATIVE) return;
    }

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

let statusTimeInterval = null;

export function initPhoneUI() {
    if (document.getElementById('textme-bubble')) return; // already exists

    const context = SillyTavern.getContext();
    if (context.characterId === undefined) return;

    console.log(`[${EXTENSION_NAME}] Initializing Phone UI for ${getCharName()}`);

    // Remove any old instances
    destroyPhoneUI();

    // Create DOM
    const wrapper = document.createElement('div');
    wrapper.id = 'textme-container';
    wrapper.innerHTML = createPhoneHTML();
    document.body.appendChild(wrapper);

    // Apply settings-based positioning
    applyPhonePosition();

    // ── Event Listeners ──

    // Bubble click → toggle phone
    document.getElementById('textme-bubble')?.addEventListener('click', togglePhone);

    // Close / minimize buttons
    document.querySelector('.textme-btn-close')?.addEventListener('click', closePhone);
    document.querySelector('.textme-header-back')?.addEventListener('click', closePhone);

    // Clear button
    document.querySelector('.textme-btn-clear')?.addEventListener('click', clearPhoneChat);

    // Send button
    document.getElementById('textme-send')?.addEventListener('click', handleSend);

    // Input: Enter to send, Shift+Enter for newline
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

    // Context menu on messages
    document.getElementById('textme-messages')?.addEventListener('contextmenu', (e) => {
        const msgEl = e.target.closest('.textme-msg');
        if (msgEl) showContextMenu(e, msgEl);
    });

    // Long press for mobile
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

    // Context menu actions
    document.getElementById('textme-context-menu')?.addEventListener('click', (e) => {
        const item = e.target.closest('.textme-ctx-item');
        if (item) handleContextAction(item.dataset.action);
    });

    // Click outside to close context menu
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#textme-context-menu')) hideContextMenu();
    });

    // Update time every minute
    updateStatusBarTime();
    statusTimeInterval = setInterval(updateStatusBarTime, 60000);

    // Phone starts closed
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

/** Called when chat changes — reload messages for new chat */
export function reloadPhoneData() {
    if (phoneOpen) {
        renderMessages();
        updatePhoneHeader();
    }
}

export function isPhoneOpen() {
    return phoneOpen;
}
