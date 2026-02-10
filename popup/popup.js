/* OverPhish – https://overphish.app
 * This file is part of the official OverPhish extension.
 * Redistribution and publication to extension stores is strictly prohibited.
 * © 2025 OverPhish.app – All rights reserved.
 */

let port = null;
let isReady = false;
let stats = {};

const modal = document.getElementById('loading-modal');
const title = document.getElementById('modal-title');
const subtitle = document.getElementById('modal-subtitle');
const progressBar = document.getElementById('progress-bar');
const progressTxt = document.getElementById('progress-text');
document.querySelector('.version').textContent = `v${chrome.runtime.getManifest().version}`;

/* --------------------------------------------------------------
   1. THEME: Apply on load + listen to changes
   -------------------------------------------------------------- */
function applyStoredTheme() {
    chrome.storage.local.get('overphish-theme', (data) => {
        const theme = data['overphish-theme'] ||
            (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
        document.documentElement.setAttribute('data-theme', theme);
        updateThemeIcon();
    });
}
applyStoredTheme();

/* --------------------------------------------------------------
   1. Connect to background progress port
   -------------------------------------------------------------- */
function connect() {
    try {
        port = chrome.runtime.connect({ name: 'overphish-progress' });

        port.onMessage.addListener(msg => {
            if (!msg || typeof msg !== 'object') return;

            if (msg.action === 'phase') {
                setPhase(msg.phase);
            } else if (msg.action === 'progress') {
                // Only process if we have the expected fields
                if ('type' in msg && 'current' in msg && 'total' in msg) {
                    updateProgress(msg.type, msg.current, msg.total);
                } else {
                    console.warn('[Popup] Invalid progress message:', msg);
                }
            } else if (msg.action === 'blocklistUpdated') {
                if (typeof msg.size === 'number' && !isNaN(msg.size)) {
                    updateStats(msg.size);
                } else {
                    console.warn('[Popup] Invalid blocklistUpdated size:', msg);
                }
            } else if (msg.action === 'blockCount') {
                const today = Number(msg.today);
                if (!isNaN(today)) {
                    stats.today = today;
                    document.getElementById('today').textContent = today;
                }
            }
        });

        port.onDisconnect.addListener(() => {
            console.warn('[OverPhish popup] progress port disconnected - reconnecting…');
            port = null;
            setTimeout(connect, 500);
        });
    } catch (e) {
        console.error('[OverPhish popup] connect error:', e);
    }
}

/* --------------------------------------------------------------
   2. Stats UI update
   -------------------------------------------------------------- */
function updateStats(size) {
    stats.blocklistSize = size;
    stats.lastUpdate = Date.now();

    const totalEl = document.getElementById('total');
    const updatedEl = document.getElementById('updated');
    const todayEl = document.getElementById('today');

    if (totalEl) totalEl.textContent = size.toLocaleString();
    if (updatedEl) updatedEl.textContent = new Date().toLocaleString();
    if (todayEl) todayEl.textContent = stats.today ?? 0;
}

/* --------------------------------------------------------------
   3. Modal / progress helpers
   -------------------------------------------------------------- */
function setPhase(phase) {
    const phases = {
        start: { title: "Initializing…", subtitle: "Preparing" },
        download: { title: "Downloading blocklist…", subtitle: "From overphish.io" },
        indexing: { title: "Building fast index…", subtitle: "Bloom filter + trie" },
        ready: { title: "Ready!", subtitle: "Protection active" }
    };
    const p = phases[phase] || phases.start;
    title.textContent = p.title;
    subtitle.textContent = p.subtitle;

    if (phase === 'ready' && !isReady) {
        setTimeout(() => modal?.classList.add('hidden'), 500);
        isReady = true;
    }
}

function updateProgress(type, current, total) {
    current = Number(current) || 0;
    total = Number(total) || 0;

    const percent = total > 0 ? Math.round((current / total) * 100) : 0;

    progressBar.value = percent;
    progressBar.max = 100;

    let text = 'Processing…';

    if (type === 'download') {
        text = percent > 0
            ? `${percent}% (${formatBytes(current)} / ${formatBytes(total || current)})`
            : `Downloading… ${formatBytes(current)}`;
    } else if (type === 'indexing') {
        text = `Indexing ${current.toLocaleString()} / ${total.toLocaleString()} domains`;
    } else if (type) {
        // fallback for unknown but present type
        text = `${type.charAt(0).toUpperCase() + type.slice(1)} ${current.toLocaleString()}`;
    }

    progressTxt.textContent = text;
}

/* --------------------------------------------------------------
   4. Buttons
   -------------------------------------------------------------- */
document.getElementById('openSettings')?.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('settings/settings.html') });
});

/* --------------------------------------------------------------
   5. Theme button – uses theme.js + localStorage sync
   -------------------------------------------------------------- */
document.getElementById('theme-toggle')?.addEventListener('click', async () => {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'light' ? 'dark' : 'light';

    await chrome.storage.local.set({ 'overphish-theme': next });
    document.documentElement.setAttribute('data-theme', next);
    updateThemeIcon();

    // Broadcast to other pages
    chrome.runtime.sendMessage({ action: 'themeChanged', theme: next }).catch(() => { });
});

/* --------------------------------------------------------------
   8. Icon / text updater
   -------------------------------------------------------------- */
function updateThemeIcon() {
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    document.querySelectorAll('.bi').forEach(el => {
        el.style.display = el.classList.contains(isLight ? 'bi-sun' : 'bi-moon-stars')
            ? 'inline-block' : 'none';
    });
    const txt = document.getElementById('theme-mode');
    if (txt) txt.textContent = isLight ? 'Light Mode' : 'Dark Mode';
}

/* --------------------------------------------------------------
   9. Initial load – fetch stats + start progress if needed
   -------------------------------------------------------------- */
(async () => {
    try {
        const resp = await chrome.runtime.sendMessage({ action: 'getStats' });
        if (resp?.stats) {
            stats = resp.stats;

            const size = Number(stats.blocklistSize) || 0;
            const todayCount = Number(stats.today) || 0;

            const todayEl = document.getElementById('today');
            const totalEl = document.getElementById('total');
            const updatedEl = document.getElementById('updated');

            if (totalEl) totalEl.textContent = size.toLocaleString();
            if (todayEl) todayEl.textContent = todayCount;
            if (updatedEl) updatedEl.textContent = stats.lastUpdate
                ? new Date(stats.lastUpdate).toLocaleString()
                : 'never';

            if (size > 0) {
                modal?.classList.add('hidden');
                isReady = true;
            } else {
                modal?.classList.remove('hidden');
                setPhase('start');
                connect();
            }
        }
    } catch (e) {
        console.error('Failed to get stats:', e);
        modal?.classList.remove('hidden');
        setPhase('start');
        connect();
    }

    // Run once after DOM is ready
    updateThemeIcon();
})();

// === THEME SYNC LISTENER (add to popup.js, settings.js, blocked.js) ===
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'themeChanged') {
        document.documentElement.setAttribute('data-theme', msg.theme);
        updateThemeIcon(); // Make sure you have this function
    }
});

// Also listen to storage (fallback)
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['overphish-theme']) {
        const theme = changes['overphish-theme'].newValue;
        document.documentElement.setAttribute('data-theme', theme);
        updateThemeIcon();
    }
});

// System preference fallback
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    chrome.storage.local.get('overphish-theme', (data) => {
        if (!data['overphish-theme']) {
            const theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', theme);
            updateThemeIcon();
        }
    });
});

window.addEventListener('error', (e) => {
    chrome.runtime.sendMessage({
        action: 'logError',
        message: e.error?.message,
        stack: e.error?.stack,
        url: e.filename,
        line: e.lineno,
        col: e.colno
    }).catch(() => { });
});