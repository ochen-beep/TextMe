/**
 * TextMe — Drag & drop for phone window and bubble icon
 * License: AGPL-3.0
 *
 * FIX (Termux/Mobile): Bubble drag now uses Pointer Events API (pointerdown/
 * pointermove/pointerup) with setPointerCapture() instead of the old
 * mousedown/touchstart split. This works correctly on Android WebView (Termux),
 * iOS Safari, and all desktop browsers.
 *
 * touchAction:'none' on the bubble prevents the browser from stealing the drag
 * gesture as a scroll, which was causing the bubble to disappear on mobile.
 *
 * Mobile: after drag, bubble snaps to nearest horizontal edge (left/right).
 * Desktop: bubble stays where dropped.
 *
 * FIX: The resize listener reference is stored in module scope so it can
 * be removed via cleanupDragListeners(). This prevents listener
 * accumulation across repeated initPhoneUI()/destroyPhoneUI() cycles.
 */

const STORAGE_KEY_BUBBLE = 'textme-bubble-pos';
const STORAGE_KEY_PHONE  = 'textme-phone-pos';
const DRAG_THRESHOLD     = 5; // px — movement needed before drag activates

/**
 * Module-scope reference to the window resize handler for bubble clamping.
 * Stored here so cleanupDragListeners() can remove it.
 */
let _bubbleResizeHandler = null;

/**
 * Remove global event listeners added by drag helpers.
 * Must be called from destroyPhoneUI() to prevent listener accumulation.
 */
export function cleanupDragListeners() {
    if (_bubbleResizeHandler) {
        window.removeEventListener('resize', _bubbleResizeHandler);
        _bubbleResizeHandler = null;
    }
}

// ─────────────────────────────────────────────────────────────
// Bubble — Pointer Events drag (works on desktop + Termux/mobile)
// ─────────────────────────────────────────────────────────────

/**
 * Make the bubble icon draggable using Pointer Events API.
 * Works on desktop (mouse), mobile (touch), and Android WebView (Termux).
 * @param {HTMLElement} bubble
 */
export function makeBubbleDraggable(bubble) {
    if (!bubble) return;

    // Prevent browser from treating drag as a scroll gesture (critical on mobile)
    bubble.style.touchAction = 'none';

    let startX, startY, origX, origY;
    let isDragging = false;

    // Restore saved position (clamped to current viewport)
    applyBubbleSavedPos(bubble);

    // Re-clamp on viewport resize — store ref in module scope for cleanup
    if (_bubbleResizeHandler) {
        window.removeEventListener('resize', _bubbleResizeHandler);
    }
    _bubbleResizeHandler = () => applyBubbleSavedPos(bubble);
    window.addEventListener('resize', _bubbleResizeHandler);

    // ── Pointer Events handlers ──

    function onPointerDown(e) {
        if (e.button !== 0) return; // primary button / first touch only
        const rect = bubble.getBoundingClientRect();
        startX   = e.clientX;
        startY   = e.clientY;
        origX    = rect.left;
        origY    = rect.top;
        isDragging = false;

        // Capture the pointer so pointermove/pointerup fire even outside element
        bubble.setPointerCapture(e.pointerId);
    }

    function onPointerMove(e) {
        if (!bubble.hasPointerCapture(e.pointerId)) return;

        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        // Activate drag only after crossing threshold (prevents misfire on tap)
        if (!isDragging && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
        isDragging = true;

        applyPos(origX + dx, origY + dy);
    }

    function onPointerUp(e) {
        if (!bubble.hasPointerCapture(e.pointerId)) return;
        bubble.releasePointerCapture(e.pointerId);

        if (isDragging) {
            // Flag to suppress the click event that fires after pointerup
            bubble._justDragged = true;
            setTimeout(() => { bubble._justDragged = false; }, 300);

            saveCurrentPos();

            // Mobile: snap to nearest horizontal edge after drag
            if (isMobile()) {
                const rect = bubble.getBoundingClientRect();
                const centerX = rect.left + rect.width / 2;
                if (centerX > window.innerWidth / 2) {
                    bubble.style.left  = 'auto';
                    bubble.style.right = '8px';
                } else {
                    bubble.style.right = 'auto';
                    bubble.style.left  = '8px';
                }
                // Save the post-snap position
                saveCurrentPos();
            }
        }

        isDragging = false;
    }

    bubble.addEventListener('pointerdown',   onPointerDown);
    bubble.addEventListener('pointermove',   onPointerMove);
    bubble.addEventListener('pointerup',     onPointerUp);
    bubble.addEventListener('pointercancel', onPointerUp);

    // Suppress click after a drag
    bubble.addEventListener('click', (e) => {
        if (bubble._justDragged) {
            bubble._justDragged = false;
            e.stopImmediatePropagation();
            e.preventDefault();
        }
    }, { capture: true });

    // ── Helpers ──

    function applyPos(x, y) {
        const w = bubble.offsetWidth  || 56;
        const h = bubble.offsetHeight || 56;
        x = clamp(x, 0, window.innerWidth  - w);
        y = clamp(y, 0, window.innerHeight - h);
        bubble.style.right  = 'auto';
        bubble.style.bottom = 'auto';
        bubble.style.left   = x + 'px';
        bubble.style.top    = y + 'px';
    }

    function saveCurrentPos() {
        const rect = bubble.getBoundingClientRect();
        savePosition(STORAGE_KEY_BUBBLE, { x: rect.left, y: rect.top });
    }
}

function isMobile() {
    return window.matchMedia('(max-width: 768px)').matches;
}

/**
 * Apply (or re-apply) the saved bubble position, clamping to current viewport.
 * Called both on init and on window resize.
 * @param {HTMLElement} bubble
 */
function applyBubbleSavedPos(bubble) {
    const saved = loadPosition(STORAGE_KEY_BUBBLE);
    const w = bubble.offsetWidth  || 56;
    const h = bubble.offsetHeight || 56;
    if (saved) {
        bubble.style.right  = 'auto';
        bubble.style.bottom = 'auto';
        bubble.style.left   = clamp(saved.x, 0, window.innerWidth  - w) + 'px';
        bubble.style.top    = clamp(saved.y, 0, window.innerHeight - h) + 'px';
    }
    // If no saved position, leave CSS default (fixed bottom-right via stylesheet)
}

// ─────────────────────────────────────────────────────────────
// Phone window — drag by header
// ─────────────────────────────────────────────────────────────

/**
 * Make the phone window draggable by its header.
 * Uses the classic mousedown/touchstart approach (phone is desktop-primary).
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
        phone.style.right     = 'auto';
        phone.style.top       = 'auto';
        phone.style.left      = clamp(saved.x, 0, window.innerWidth  - 100) + 'px';
        phone.style.top       = clamp(saved.y, 0, window.innerHeight - 100) + 'px';
        phone.style.transform = 'none';
    }

    handle.addEventListener('mousedown', onStart);
    handle.addEventListener('touchstart', onTouchStart, { passive: false });

    function onStart(e) {
        if (e.target.closest('.textme-btn-icon, .textme-btn-clear, button')) return;
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
        document.addEventListener('mouseup',   onEnd);
    }

    function onTouchStart(e) {
        if (e.target.closest('.textme-btn-icon, .textme-btn-clear, button')) return;
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
        document.addEventListener('touchend',  onTouchEnd);
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
        document.removeEventListener('mouseup',   onEnd);
        saveCurrentPos();
    }

    function onTouchEnd() {
        isDragging = false;
        document.removeEventListener('touchmove', onTouchMove);
        document.removeEventListener('touchend',  onTouchEnd);
        saveCurrentPos();
    }

    function applyPos(x, y) {
        x = clamp(x, 0, window.innerWidth  - phone.offsetWidth);
        y = clamp(y, 0, window.innerHeight - 60);
        phone.style.right = 'auto';
        phone.style.left  = x + 'px';
        phone.style.top   = y + 'px';
    }

    function saveCurrentPos() {
        const rect = phone.getBoundingClientRect();
        savePosition(STORAGE_KEY_PHONE, { x: rect.left, y: rect.top });
    }
}

// ─────────────────────────────────────────────────────────────
// Phone window — resize handle
// ─────────────────────────────────────────────────────────────

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
        document.addEventListener('mouseup',   onEnd);
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
        document.addEventListener('touchend',  onTouchEnd);
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
        const newW = clamp(startW + dx, 300, window.innerWidth  - 20);
        const newH = clamp(startH + dy, 400, window.innerHeight - 20);
        phone.style.width  = newW + 'px';
        phone.style.height = newH + 'px';
    }

    function onEnd() {
        isResizing = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onEnd);
    }

    function onTouchEnd() {
        isResizing = false;
        document.removeEventListener('touchmove', onTouchMove);
        document.removeEventListener('touchend',  onTouchEnd);
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
