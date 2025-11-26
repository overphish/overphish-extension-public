/* OverPhish – https://overphish.app
 * This file is part of the official OverPhish extension.
 * Redistribution and publication to extension stores is strictly prohibited.
 * © 2025 OverPhish.app – All rights reserved.
 */

(() => {
    const marker = document.getElementById('overphish-allow-once');
    if (!marker) return;

    const hostname = marker.dataset.hostname;
    marker.remove();

    chrome.runtime.sendMessage({ action: 'allowOnce', hostname });

    if (history.replaceState) {
        const cleanUrl = new URL(location.href);
        cleanUrl.search = '';
        history.replaceState(null, '', cleanUrl.toString());
    }
})();