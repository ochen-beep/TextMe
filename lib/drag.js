/**
 * TextMe — Drag & drop for phone window and bubble icon
 * License: AGPL-3.0
 */

const STORAGE_KEY_BUBBLE = 'textme-bubble-pos';
const STORAGE_KEY_PHONE = 'textme-phone-pos';

/**
 * Make the bubble icon draggable.
 * @param {HTMLElement} bubble
 */
export function makeBubbleDraggable(bubble) {
    if (!bubble) return;

    let isDragging = false;
    let hasMoved = false;
    let startX, startY, origX, origY;

    // Restore saved position
    const saved = loadPosition(STORAGE_KEY_BUBBLE);
    if (saved) {
        bubble.style.right = 'auto';
        bubble.style.bottom = 'auto';
        bubble.style.left = clamp(saved.x, 0, window.innerWidth - 56) + 'px';
        bubble.style.top = clamp(saved.y, 0, window.innerHeight - 56) + 'px';
    }

    bubble.addEventListener('mousedown', onStart);
    bubble.addEventListener('touchstart', onTouchStart, { passive: false });

    function onStart(e) {
        if (e.button !== 0) return;
        isDragging = true;
        hasMoved = false;
        startX = e.clientX;
        startY = e.clientY;
        const rect = bubble.getBoundingClientRect();
        origX = rect.left;
        origY = rect.top;
        e.preventDefault();
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onEnd);
    }

    function onTouchStart(e) {
        if (e.touches.length !== 1) return;
        isDragging = true;
        hasMoved = false;
        const t = e.touches[0];
        startX = t.clientX;
        startY = t.clientY;
        const rect = bubble.getBoundingClientRect();
        origX = rect.left;
        origY = rect.top;
        document.addEventListener('touchmove', onTouchMove, { passive: false });
        document.addEventListener('touchend', onTouchEnd);
    }

    function onMove(e) {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved = true;
        if (!hasMoved) return;
        applyPos(origX + dx, origY + dy);
    }

    function onTouchMove(e) {
        if (!isDragging) return;
        e.preventDefault();
        const t = e.touches[0];
        const dx = t.clientX - startX;
        const dy = t.clientY - startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved = true;
        if (!hasMoved) return;
        applyPos(origX + dx, origY + dy);
    }

    function onEnd() {
        isDragging = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onEnd);
        if (hasMoved) {
            saveCurrentPos();
            // Prevent click from firing
            bubble.addEventListener('click', suppressClick, { capture: true, once: true });
        }
    }

    function onTouchEnd() {
        isDragging = false;
        document.removeEventListener('touchmove', onTouchMove);
        document.removeEventListener('touchend', onTouchEnd);
        if (hasMoved) saveCurrentPos();
    }

    function suppressClick(e) {
        e.stopImmediatePropagation();
        e.preventDefault();
    }

    function applyPos(x, y) {
        x = clamp(x, 0, window.innerWidth - bubble.offsetWidth);
        y = clamp(y, 0, window.innerHeight - bubble.offsetHeight);
        bubble.style.right = 'auto';
        bubble.style.bottom = 'auto';
        bubble.style.left = x + 'px';
        bubble.style.top = y + 'px';
    }

    function saveCurrentPos() {
        const rect = bubble.getBoundingClientRect();
        savePosition(STORAGE_KEY_BUBBLE, { x: rect.left, y: rect.top });
    }
}

/**
 * Make the phone window draggable by its header.
 * @param {HTMLElement} phone
 * @param {HTMLElement} handle - the header element
 */
export function makePhoneDraggable(phone, handle) {
    if (!phone || !handle) return;

    let isDragging = false;
    let startX, startY, origX, origY;

    // Restore saved position
    const saved = loadPosition(STORAGE_KEY_PHONE);
    if (saved) {
        phone.style.right = 'auto';
        phone.style.top = 'auto';
        phone.style.left = clamp(saved.x, 0, window.innerWidth - 100) + 'px';
        phone.style.top = clamp(saved.y, 0, window.innerHeight - 100) + 'px';
        phone.style.transform = 'none';
    }

    handle.addEventListener('mousedown', onStart);
    handle.addEventListener('touchstart', onTouchStart, { passive: false });

    function onStart(e) {
        // Don't drag if clicking buttons inside header
        if (e.target.closest('.textme-btn-icon, .textme-btn-close, .textme-btn-clear, button')) return;
        if (e.button !== 0) return;
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = phone.getBoundingClientRect();
        origX = rect.left;
        origY = rect.top;
        phone.style.transform = 'none';
        e.preventDefault();
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onEnd);
    }

    function onTouchStart(e) {
        if (e.target.closest('.textme-btn-icon, .textme-btn-close, .textme-btn-clear, button')) return;
        if (e.touches.length !== 1) return;
        isDragging = true;
        const t = e.touches[0];
        startX = t.clientX;
        startY = t.clientY;
        const rect = phone.getBoundingClientRect();
        origX = rect.left;
        origY = rect.top;
        phone.style.transform = 'none';
        document.addEventListener('touchmove', onTouchMove, { passive: false });
        document.addEventListener('touchend', onTouchEnd);
    }

    function onMove(e) {
        if (!isDragging) return;
        applyPos(origX + e.clientX - startX, origY + e.clientY - startY);
    }

    function onTouchMove(e) {
        if (!isDragging) return;
        e.preventDefault();
        const t = e.touches[0];
        applyPos(origX + t.clientX - startX, origY + t.clientY - startY);
    }

    function onEnd() {
        isDragging = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onEnd);
        saveCurrentPos();
    }

    function onTouchEnd() {
        isDragging = false;
        document.removeEventListener('touchmove', onTouchMove);
        document.removeEventListener('touchend', onTouchEnd);
        saveCurrentPos();
    }

    function applyPos(x, y) {
        x = clamp(x, 0, window.innerWidth - phone.offsetWidth);
        y = clamp(y, 0, window.innerHeight - 60);
        phone.style.right = 'auto';
        phone.style.left = x + 'px';
        phone.style.top = y + 'px';
    }

    function saveCurrentPos() {
        const rect = phone.getBoundingClientRect();
        savePosition(STORAGE_KEY_PHONE, { x: rect.left, y: rect.top });
    }
}

/**
 * Make the phone window resizable from the bottom-right corner.
 * @param {HTMLElement} phone
 */
export function makePhoneResizable(phone) {
    if (!phone) return;

    const handle = document.createElement('div');
    handle.className = 'textme-resize-handle';
    phone.appendChild(handle);

    let isResizing = false;
    let startX, startY, startW, startH;

    handle.addEventListener('mousedown', onStart);
    handle.addEventListener('touchstart', onTouchStart, { passive: false });

    function onStart(e) {
        isResizing = true;
        startX = e.clientX;
        startY = e.clientY;
        startW = phone.offsetWidth;
        startH = phone.offsetHeight;
        e.preventDefault();
        e.stopPropagation();
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onEnd);
    }

    function onTouchStart(e) {
        if (e.touches.length !== 1) return;
        isResizing = true;
        const t = e.touches[0];
        startX = t.clientX;
        startY = t.clientY;
        startW = phone.offsetWidth;
        startH = phone.offsetHeight;
        e.preventDefault();
        e.stopPropagation();
        document.addEventListener('touchmove', onTouchMove, { passive: false });
        document.addEventListener('touchend', onTouchEnd);
    }

    function onMove(e) {
        if (!isResizing) return;
        doResize(e.clientX - startX, e.clientY - startY);
    }

    function onTouchMove(e) {
        if (!isResizing) return;
        e.preventDefault();
        const t = e.touches[0];
        doResize(t.clientX - startX, t.clientY - startY);
    }

    function doResize(dx, dy) {
        const newW = clamp(startW + dx, 300, window.innerWidth - 20);
        const newH = clamp(startH + dy, 400, window.innerHeight - 20);
        phone.style.width = newW + 'px';
        phone.style.height = newH + 'px';
    }

    function onEnd() {
        isResizing = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onEnd);
    }

    function onTouchEnd() {
        isResizing = false;
        document.removeEventListener('touchmove', onTouchMove);
        document.removeEventListener('touchend', onTouchEnd);
    }
}

// ── Utilities ──

function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
}

function savePosition(key, pos) {
    try { localStorage.setItem(key, JSON.stringify(pos)); } catch { /* ignore */ }
}

function loadPosition(key) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}
