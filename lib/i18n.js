/**
 * TextMe — Internationalization helper
 * License: AGPL-3.0
 *
 * Provides a t(key) function that returns a translated string for the
 * current SillyTavern locale (Russian only; all other locales fall back
 * to the English key).
 *
 * HOW IT WORKS
 * ─────────────
 * 1. SillyTavern exposes getCurrentLocale() via getContext().
 *    It returns a locale code such as 'ru-ru', 'en-us', 'de-de', etc.
 * 2. If the locale is 'ru-ru', we look up the key in LOCALE_RU.
 * 3. Any other locale → return key as-is (English).
 *
 * Used by phone-ui.js for dynamic JS strings (toastr messages, confirm
 * dialogs, inline HTML snippets) that are not covered by the manifest
 * i18n / data-i18n attribute system.
 */

/** Russian translations for dynamic JS strings used in phone-ui.js */
const LOCALE_RU = {
    // ── Phone HTML template ──────────────────────────────────────────────
    'Start a conversation!':              'Начните разговор!',
    'Type a message...':                  'Введите сообщение...',
    'Send (right-click / long-press = silent send)': 'Отправить (ПКМ / удержание = тихая отправка)',
    'Open TextMe':                        'Открыть TextMe',
    'Minimize':                           'Свернуть',
    'Click to change status':             'Нажмите для смены статуса',
    'Edit contact':                       'Редактировать контакт',
    'Clear chat':                         'Очистить чат',
    ' is typing...':                      ' печатает...',

    // ── Context menu ─────────────────────────────────────────────────────
    'Copy':                               'Копировать',
    'Regenerate':                         'Перегенерировать',
    'Edit':                               'Редактировать',
    'Delete':                             'Удалить',

    // ── Contact edit modal ───────────────────────────────────────────────
    'Edit Contact':                       'Редактировать контакт',
    'Save for':                           'Сохранить для',
    'This chat':                          'Этого чата',
    'All chats':                          'Всех чатов',
    'Drag to pan · Scroll to zoom':       'Перетащите для перемещения · Прокрутите для зума',
    'Display name':                       'Отображаемое имя',
    'Leave empty to use character name':  'Оставьте пустым для имени персонажа',
    'Avatar URL':                         'URL аватара',
    'Upload image':                       'Загрузить изображение',
    'Choose image':                       'Выбрать изображение',
    'Reset':                              'Сбросить',
    'Cancel':                             'Отмена',
    'Save':                               'Сохранить',

    // ── Toastr / confirm / prompt strings ───────────────────────────────
    'Copied to clipboard':                'Скопировано в буфер обмена',
    'Failed to copy':                     'Не удалось скопировать',
    'Delete this message?':               'Удалить это сообщение?',
    'Edit message:':                      'Редактировать сообщение:',
    'Clear all phone messages?':          'Очистить все сообщения телефона?',
    'Phone chat cleared':                 'Чат телефона очищен',
    'TextMe: Cancelled':                  'TextMe: Отменено',
    'Sent silently':                      'Отправлено без ответа',
    'Contact reset to default':           'Контакт сброшен по умолчанию',
    'Could not load image':               'Не удалось загрузить изображение',
    'Status back to schedule':            'Статус возвращён по расписанию',
    'Offline — will reply later':         'Не в сети — ответит позже',
    'Delivered':                          'Доставлено',
    'Read':                               'Прочитано',
    'Reply':                              'Ответить',
    'Cancel reply':                       'Отменить ответ',
    'Today':                              'Сегодня',
    'Yesterday':                          'Вчера',
};

/**
 * Return the translation of key for the current ST locale.
 * Falls back to key itself if no translation exists or locale is not Russian.
 *
 * @param {string} key  English source string
 * @returns {string}    Translated string (or key unchanged)
 */
export function t(key) {
    try {
        const locale = SillyTavern.getContext().getCurrentLocale?.() || '';
        if (locale === 'ru-ru' && Object.hasOwn(LOCALE_RU, key)) {
            return LOCALE_RU[key];
        }
    } catch { /* ignore — ST context not ready */ }
    return key;
}

/**
 * Convenience helper: t() with an interpolation map.
 * Replaces {{var}} placeholders in the translated string.
 *
 * Example:
 *   ti('{{name}} is offline and will reply when available.', { name: 'Nic' })
 *
 * @param {string} key
 * @param {Record<string, string>} vars
 * @returns {string}
 */
export function ti(key, vars) {
    let str = t(key);
    for (const [k, v] of Object.entries(vars || {})) {
        str = str.replaceAll(`{{${k}}}`, v);
    }
    return str;
}
