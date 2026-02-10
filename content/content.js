/* OverPhish – https://overphish.app
 * This file is part of the official OverPhish extension.
 * Redistribution and publication to extension stores is strictly prohibited.
 * © 2025 OverPhish.app – All rights reserved.
 */

// content/content.js

let processedNodes = new WeakSet();

async function checkAndHighlightLinks(root = document) {
    const links = root.querySelectorAll('a[href]');
    const hostnamesToCheck = new Set();

    links.forEach(link => {
        if (processedNodes.has(link)) return;
        try {
            const url = new URL(link.href, location.origin); // Fallback base
            if (url.protocol === 'http:' || url.protocol === 'https:') {
                const hostname = url.hostname.replace(/^www\./, '');
                if (hostname) hostnamesToCheck.add(hostname);
            }
        } catch (_) { }
    });

    if (hostnamesToCheck.size === 0) return;

    let response;
    try {
        response = await chrome.runtime.sendMessage({
            action: 'checkDomains',
            hostnames: Array.from(hostnamesToCheck)
        });
    } catch (e) {
        console.warn('[OverPhish] Background message failed (normal during startup):', e);
        return;
    }

    const blockedHostnames = new Set(response.blocked || []);

    links.forEach(link => {
        console.log(link);
        try {
            const url = new URL(link.href, location.origin);
            const hostname = url.hostname.replace(/^www\./, '');
            if (blockedHostnames.has(hostname)) {
                link.style.outline = '2px solid red';
                link.style.borderRadius = '.2rem';
                link.style.backgroundColor = 'rgba(255, 0, 0, 0.3)';
                link.style.padding = '.2rem .3rem';
                link.style.cursor = 'help';
                link.title = '⚠️ OverPhish: This link points to a known phishing domain.';
                processedNodes.add(link);
            }
        } catch (_) { }
    });
}

// Main function: wait for body, then scan and observe
function init() {
    if (!document.body) {
        // Body not ready yet — wait a tick
        requestAnimationFrame(init);
        return;
    }

    // Initial scan
    checkAndHighlightLinks();

    // Observe future changes (Gmail dynamically updates the compose area)
    const observer = new MutationObserver(mutations => {
        for (const mutation of mutations) {
            if (mutation.addedNodes.length) {
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        checkAndHighlightLinks(node);
                    }
                });
            }
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: false,
        characterData: false
    });
}

// Start when DOM is ready (safe fallback)
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}