/* OverPhish – https://overphish.app
 * This file is part of the official OverPhish extension.
 * Redistribution and publication to extension stores is strictly prohibited.
 * © 2025 OverPhish.app – All rights reserved.
 */

(async () => {
    const params = new URLSearchParams(location.search);
    let blockedUrl = params.get('url');
    if (blockedUrl) blockedUrl = decodeURIComponent(blockedUrl);

    const urlEl = document.getElementById('blocked-url');
    const domainEl = document.getElementById('domain_bold');

    if (!blockedUrl || !blockedUrl.startsWith('http')) {
        urlEl && (urlEl.textContent = 'Unknown URL');
        domainEl && (domainEl.textContent = 'unknown');
    } else {
        urlEl && (urlEl.textContent = blockedUrl);
        let hostname = 'unknown';
        try {
            hostname = new URL(blockedUrl).hostname.replace(/^www\./, '');
        } catch (_) { }
        domainEl && (domainEl.textContent = hostname);
    }

    // === Allow Once (single, correct handler) ===
    let allowOnceInProgress = false;
    document.getElementById('allow-once')?.addEventListener('click', async () => {
        if (allowOnceInProgress) return;
        allowOnceInProgress = true;

        const button = document.getElementById('allow-once');
        button.textContent = 'Allowing...';
        button.disabled = true;

        try {
            const resp = await chrome.runtime.sendMessage({
                action: 'allowOnce',
                url: blockedUrl
            });
            if (resp?.ok) {
                window.location.replace(blockedUrl);
            } else throw new Error('rejected');
        } catch (err) {
            button.textContent = 'Failed – Try Again';
            setTimeout(() => {
                button.textContent = 'Allow this site once';
                button.disabled = false;
                allowOnceInProgress = false;
            }, 2000);
        }
    });

    // === Whitelist ===
    document.getElementById('whitelist')?.addEventListener('click', async () => {
        const button = document.getElementById('whitelist');
        const orig = button.textContent;
        button.textContent = 'Adding...';
        button.disabled = true;

        try {
            await chrome.runtime.sendMessage({
                action: 'whitelist',
                domain: domainEl?.textContent || 'unknown'
            });
            window.location.replace(blockedUrl);
        } catch {
            button.textContent = 'Failed';
            setTimeout(() => {
                button.textContent = orig;
                button.disabled = false;
            }, 2000);
        }
    });

    // === Go Back ===
    document.getElementById('go-back')?.addEventListener('click', () => {
        if (history.length <= 1) {
            chrome.tabs.getCurrent(tab => chrome.tabs.remove(tab.id));
        } else {
            history.back();
        }
    });

    // === THEME SYSTEM (USING chrome.storage.local) ===
    const STORAGE_KEY = 'overphish-theme';
    const LIGHT = 'light';
    const DARK = 'dark';

    function getCurrentTheme() {
        return new Promise(resolve => {
            chrome.storage.local.get(STORAGE_KEY, (data) => {
                const saved = data[STORAGE_KEY];
                if (saved) return resolve(saved);
                resolve(window.matchMedia('(prefers-color-scheme: light)').matches ? LIGHT : DARK);
            });
        });
    }

    async function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        await chrome.storage.local.set({ [STORAGE_KEY]: theme });
        updateThemeIcon();

        // Broadcast to ALL pages
        chrome.runtime.sendMessage({
            action: 'themeChanged',
            theme: theme
        }).catch(() => { });
    }

    async function toggleTheme() {
        const current = document.documentElement.getAttribute('data-theme') || DARK;
        const next = current === LIGHT ? DARK : LIGHT;
        await applyTheme(next);
    }

    function updateThemeIcon() {
        const isLight = document.documentElement.getAttribute('data-theme') === 'light';
        document.querySelectorAll('.bi').forEach(el => {
            el.style.display = el.classList.contains(isLight ? 'bi-sun' : 'bi-moon-stars') ? 'inline-block' : 'none';
        });
        const textEl = document.getElementById('theme-mode');
        if (textEl) textEl.textContent = isLight ? 'Light Mode' : 'Dark Mode';
    }

    // === INITIALIZE ===
    getCurrentTheme().then(applyTheme);

    // === TOGGLE BUTTON ===
    document.getElementById('theme-toggle')?.addEventListener('click', () => {
        toggleTheme();
    });

    // === LISTEN FOR THEME CHANGES FROM OTHER PAGES ===
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg.action === 'themeChanged') {
            document.documentElement.setAttribute('data-theme', msg.theme);
            updateThemeIcon();
        } else if (msg.action === 'logError') {
            console.error('[OverPhish] Reported error:', msg);
            reportError(msg).then(() => sendResponse({ ok: true }));
            return true; // async response
        }
    });

    // === STORAGE CHANGE FALLBACK ===
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes[STORAGE_KEY]) {
            const theme = changes[STORAGE_KEY].newValue;
            document.documentElement.setAttribute('data-theme', theme);
            updateThemeIcon();
        }
    });

    // === SYSTEM PREFERENCE CHANGE ===
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
        chrome.storage.local.get(STORAGE_KEY, (data) => {
            if (!data[STORAGE_KEY]) {
                const theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
                applyTheme(theme);
            }
        });
    });

    // === EXPOSE FOR DEBUGGING ===
    window.OverPhishTheme = { toggle: toggleTheme };
})();

/* -------------------------------------------------------------
   Send any error to the background worker – it will store it.
   ------------------------------------------------------------- */
function reportError(obj) {
    chrome.runtime.sendMessage({ action: 'logError', ...obj }).catch(() => { });
}

window.addEventListener('error', e => reportError({
    message: e.error?.message,
    stack: e.error?.stack,
    url: e.filename,
    line: e.lineno
}));

window.addEventListener('unhandledrejection', e => reportError({
    message: e.reason?.message || String(e.reason),
    stack: e.reason?.stack
}));