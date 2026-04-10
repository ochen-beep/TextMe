/**
 * TextMe — Emoji Picker
 * License: AGPL-3.0
 *
 * Adapted from stc/src/ui/emoji-picker.js.
 *
 * Changes vs stc:
 *  - Container ID: textme-phone (not conv-phone)
 *  - CSS class prefix: textme-emoji- (not conv-emoji-)
 *  - localStorage key: textme_recent_emojis (not conv_recent_emojis)
 *  - Positioning: sticks above the input bar inside #textme-phone
 */

const EMOJI_CATEGORIES = {
    'Smileys':    ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','😊','😇','🥰','😍','🤩','😘','😗','😚','😋','😛','😜','🤪','😝','🤗','🤭','🤫','🤔','😐','😑','😶','😏','😒','🙄','😬','😌','😔','😪','😴','😷','🤒','🥵','🥶','😱','😨','😰','😥','😢','😭','😤','😠','😡'],
    'Gestures':   ['👋','🤚','✋','🖖','👌','🤏','✌','🤞','🤟','🤘','🤙','👈','👉','👆','👇','👍','👎','👊','✊','🤛','🤜','👏','🙌','🤝','🙏','💪'],
    'Hearts':     ['❤','🧡','💛','💚','💙','💜','🖤','🤍','💔','💕','💞','💓','💗','💖','💘','💝'],
    'Nature':     ['🌸','💐','🌹','🌺','🌻','🌼','🌱','🌲','🌳','🌴','🍀','☀','🌤','⛅','🌧','🌈','❄','🔥','💧','⭐','✨','🌟','💫'],
    'Food':       ['🍎','🍊','🍋','🍌','🍉','🍇','🍓','🍒','🍑','🍕','🍔','🍟','🌮','🍿','🥤','☕','🍵','🍺','🍷','🍸','🥂'],
    'Activities': ['⚽','🏀','🎮','🎲','🎯','🎨','🎬','🎤','🎧','🎵','🎶','🎸','🎹'],
    'Objects':    ['📱','💻','📷','💡','📖','📝','💌','📧','🔑','💰','💎','🎁','🏆'],
    'Symbols':    ['💥','❗','❓','⁉','‼','✅','❌','⭕','🔴','🟡','🟢','🔵','💯','🆗','🆕'],
};

const RECENT_KEY = 'textme_recent_emojis';
const MAX_RECENT = 20;

let pickerEl = null;
let onSelectCallback = null;

/**
 * Open the emoji picker above anchorEl.
 * @param {HTMLElement} anchorEl  — button that triggered the picker
 * @param {Function}    onSelect  — called with the selected emoji string
 */
export function openEmojiPicker(anchorEl, onSelect) {
    closeEmojiPicker();
    onSelectCallback = onSelect;

    pickerEl = document.createElement('div');
    pickerEl.className = 'textme-emoji-picker';

    // Search input
    const searchInput = document.createElement('input');
    searchInput.className   = 'textme-emoji-search';
    searchInput.placeholder = 'Search...';
    searchInput.type        = 'text';
    pickerEl.appendChild(searchInput);

    // Tab bar
    const tabBar = document.createElement('div');
    tabBar.className = 'textme-emoji-tabs';

    const allCategories = ['Recent', ...Object.keys(EMOJI_CATEGORIES)];
    allCategories.forEach((cat, i) => {
        const tab = document.createElement('button');
        tab.className    = `textme-emoji-tab${i === 0 ? ' active' : ''}`;
        tab.textContent  = cat === 'Recent' ? '🕐' : (Object.values(EMOJI_CATEGORIES)[i - 1]?.[0] || cat.charAt(0));
        tab.title        = cat;
        tab.dataset.cat  = cat;
        tab.addEventListener('click', () => {
            tabBar.querySelectorAll('.textme-emoji-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            showCategory(grid, cat);
        });
        tabBar.appendChild(tab);
    });
    pickerEl.appendChild(tabBar);

    // Grid
    const grid = document.createElement('div');
    grid.className = 'textme-emoji-grid';
    pickerEl.appendChild(grid);

    showCategory(grid, 'Recent');

    searchInput.addEventListener('input', () => {
        const q = searchInput.value.toLowerCase().trim();
        if (!q) {
            const active = tabBar.querySelector('.textme-emoji-tab.active');
            showCategory(grid, active?.dataset.cat || 'Recent');
        } else {
            showSearchResults(grid, q);
        }
    });

    // Mount inside phone container for proper clipping
    const phoneEl = document.getElementById('textme-phone');
    const container = phoneEl || document.body;
    container.appendChild(pickerEl);

    // Position above anchor
    const anchorRect    = anchorEl.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    pickerEl.style.position = 'absolute';
    pickerEl.style.bottom   = `${containerRect.bottom - anchorRect.top + 6}px`;
    pickerEl.style.left     = '8px';
    pickerEl.style.right    = '8px';

    searchInput.focus();

    setTimeout(() => {
        document.addEventListener('click', _handleOutsideClick);
    }, 10);
}

/**
 * Close and remove the picker.
 */
export function closeEmojiPicker() {
    if (pickerEl) {
        pickerEl.remove();
        pickerEl = null;
    }
    document.removeEventListener('click', _handleOutsideClick);
    onSelectCallback = null;
}

// ─── internal ────────────────────────────────────────────────────────────────

function showCategory(grid, category) {
    grid.innerHTML = '';
    let emojis;
    if (category === 'Recent') {
        emojis = _getRecent();
        if (emojis.length === 0) {
            grid.innerHTML = '<div class="textme-emoji-empty">No recent emojis</div>';
            return;
        }
    } else {
        emojis = EMOJI_CATEGORIES[category] || [];
    }
    _renderButtons(grid, emojis);
}

function showSearchResults(grid, query) {
    grid.innerHTML = '';
    const results = [];
    Object.entries(EMOJI_CATEGORIES).forEach(([cat, emojis]) => {
        if (cat.toLowerCase().includes(query)) results.push(...emojis);
    });
    if (results.length === 0) {
        Object.values(EMOJI_CATEGORIES).forEach(e => results.push(...e));
    }
    if (results.length === 0) {
        grid.innerHTML = '<div class="textme-emoji-empty">No results</div>';
        return;
    }
    _renderButtons(grid, results.slice(0, 60));
}

function _renderButtons(grid, emojis) {
    const row = document.createElement('div');
    row.className = 'textme-emoji-row';
    emojis.forEach(emoji => {
        const btn = document.createElement('button');
        btn.className   = 'textme-emoji-btn';
        btn.textContent = emoji;
        btn.title       = emoji;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            _addToRecent(emoji);
            if (onSelectCallback) onSelectCallback(emoji);
            closeEmojiPicker();
        });
        row.appendChild(btn);
    });
    grid.appendChild(row);
}

function _getRecent() {
    try {
        const s = localStorage.getItem(RECENT_KEY);
        return s ? JSON.parse(s) : [];
    } catch { return []; }
}

function _addToRecent(emoji) {
    try {
        let r = _getRecent().filter(e => e !== emoji);
        r.unshift(emoji);
        if (r.length > MAX_RECENT) r = r.slice(0, MAX_RECENT);
        localStorage.setItem(RECENT_KEY, JSON.stringify(r));
    } catch { /* ignore */ }
}

function _handleOutsideClick(e) {
    if (pickerEl && !pickerEl.contains(e.target)) {
        closeEmojiPicker();
    }
}
