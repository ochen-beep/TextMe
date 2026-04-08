// TextMe — Phone UI (placeholder)
// License: AGPL-3.0

import { EXTENSION_NAME } from './state.js';

/** Initialize phone UI — create DOM elements */
export function initPhoneUI() {
    if ($('#textme-phone-container').length) return; // already initialized

    console.log(`[${EXTENSION_NAME}] Initializing Phone UI`);

    // TODO: M4 — Full phone UI implementation
    // For now, create a minimal floating bubble
    const bubble = $(`
        <div id="textme-phone-container">
            <div id="textme-bubble" title="Open TextMe">
                💬
            </div>
        </div>
    `);

    $('body').append(bubble);

    $('#textme-bubble').on('click', () => {
        // TODO: Toggle phone window
        console.log(`[${EXTENSION_NAME}] Phone bubble clicked`);
    });
}

/** Destroy phone UI — remove DOM elements */
export function destroyPhoneUI() {
    $('#textme-phone-container').remove();
    console.log(`[${EXTENSION_NAME}] Phone UI destroyed`);
}
