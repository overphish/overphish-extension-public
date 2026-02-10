/* OverPhish – https://overphish.app
 * This file is part of the official OverPhish extension.
 * Redistribution and publication to extension stores is strictly prohibited.
 * © 2025 OverPhish.app – All rights reserved.
 */

const PERMANENT_WHITELIST = new Set([
    // Google ecosystem
    'google.com', 'www.google.com',
    'youtube.com', 'www.youtube.com',
    'youtu.be',
    'googleapis.com',         // many sites break without it
    'gstatic.com',

    // Meta / Facebook / Instagram / WhatsApp
    'facebook.com', 'www.facebook.com',
    'fb.com', 'www.fb.com',
    'instagram.com', 'www.instagram.com',
    'whatsapp.com', 'www.whatsapp.com',

    // X / Twitter
    'twitter.com', 'www.twitter.com',
    'x.com', 'www.x.com',

    // Microsoft
    'microsoft.com', 'www.microsoft.com',
    'live.com', 'outlook.live.com', 'outlook.com',

    // Apple
    'apple.com', 'www.apple.com',
    'icloud.com',

    // Amazon
    'amazon.com', 'www.amazon.com',

    // GitHub + common dev sites
    'github.com', 'www.github.com',
    'githubusercontent.com',

    // Local / loopback
    'localhost',
    '127.0.0.1',
    '::1',                    // IPv6 localhost

    // Common CDNs / auth providers that break sites when blocked
    'cloudflare.com',
    'cloudflare.net',
    'akamai.net',
    'akamaized.net',
    'fastly.net',
]);

document.addEventListener('DOMContentLoaded', async () => {
    const whitelistList = document.getElementById('whitelist-list');
    const addInput = document.getElementById('new-domain');
    const addBtn = document.getElementById('add-domain');
    const addError = document.getElementById('add-error');
    const refreshBtn = document.getElementById('refresh-blocklist');

    // === RENDER WHITELIST (with built-in domains shown but unremovable) ===
    async function renderWhitelist() {
        const { whitelist = [] } = await chrome.storage.local.get('whitelist');

        // Combine user domains + defaults, but mark defaults
        const userDomains = whitelist.filter(d => !PERMANENT_WHITELIST.has(d));
        const allDomains = [...new Set([...userDomains, ...PERMANENT_WHITELIST])].sort();

        whitelistList.innerHTML = '';

        if (allDomains.length === 0) {
            whitelistList.innerHTML = '<p class="no-domains"><em>No domains whitelisted.</em></p>';
            return;
        }

        allDomains.forEach(domain => {
            const isDefault = PERMANENT_WHITELIST.has(domain);
            const isUserAdded = userDomains.includes(domain);

            const item = document.createElement('div');
            item.className = 'whitelist-item';
            item.innerHTML = `
                <pre style="color:${isDefault ? '#888' : 'var(--pico-text)'}">${domain} ${isDefault ? ' <small style="opacity:0.7">(built-in)</small>' : ''}</pre>
                ${!isDefault ? `
                <button class="remove-btn reset" data-domain="${domain}" title="Remove from whitelist">
                    <svg class="trash-can" viewBox="0 0 640 640" xmlns="http://www.w3.org/2000/svg">
                        <path d="M232.7 69.9C237.1 56.8 249.3 48 263.1 48L377 48C390.8 48 403 56.8 407.4 69.9L416 96L512 96C529.7 96 544 110.3 544 128C544 145.7 529.7 160 512 160L128 160C110.3 160 96 145.7 96 128C96 110.3 110.3 96 128 96L224 96L232.7 69.9zM128 208L512 208L512 512C512 547.3 483.3 576 448 576L192 576C156.7 576 128 547.3 128 512L128 208zM216 272C202.7 272 192 282.7 192 296L192 488C192 501.3 202.7 512 216 512C229.3 512 240 501.3 240 488L240 296C240 282.7 229.3 272 216 272zM320 272C306.7 272 296 282.7 296 296L296 488C296 501.3 306.7 512 320 512C333.3 512 344 501.3 344 488L344 296C344 282.7 333.3 272 320 272zM424 272C410.7 272 400 282.7 400 296L400 488C400 501.3 410.7 512 424 512C437.3 512 448 501.3 448 488L448 296C448 282.7 437.3 272 424 272z"/>
                    </svg>
                </button>
                ` : '<div style="width:40px;"></div>'}
            `;

            whitelistList.appendChild(item);
        });
    }

    // === ADD DOMAIN ===
    addBtn?.addEventListener('click', async () => {
        let domain = addInput.value.trim().toLowerCase()
            .replace(/^https?:\/\//, '')
            .replace(/\/.*$/, '')
            .replace(/^www\./, '');

        addError.textContent = '';

        if (!domain) return addError.textContent = 'Enter a domain';
        if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return addError.textContent = 'Invalid domain';
        if (PERMANENT_WHITELIST.has(domain)) return addError.textContent = `${domain} is already permanently allowed`;

        const { whitelist = [] } = await chrome.storage.local.get('whitelist');
        if (whitelist.includes(domain)) {
            addError.textContent = 'Already in whitelist';
            addInput.select();
            return;
        }

        await chrome.storage.local.set({ whitelist: [...whitelist, domain] });
        addInput.value = '';
        document.getElementById('whitelist-search').value = '';

        const toast = document.createElement('div');
        toast.textContent = `Added ${domain}`;
        toast.style = 'position:fixed;bottom:20px;right:20px;background:#10b981;color:white;padding:12px 20px;border-radius:8px;z-index:1000;';
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 2500);

        await renderWhitelist();
    });

    // Allow Enter key
    addInput?.addEventListener('keypress', e => e.key === 'Enter' && addBtn.click());

    // === REMOVE DOMAIN ===
    whitelistList.addEventListener('click', async (e) => {
        const btn = e.target.closest('.remove-btn');
        if (!btn) return;

        const domain = btn.dataset.domain;
        const { whitelist = [] } = await chrome.storage.local.get('whitelist');
        const updated = whitelist.filter(d => d !== domain);

        await chrome.storage.local.set({ whitelist: updated });
        await renderWhitelist();
    });

    // === REFRESH STATS + BLOCKLIST ===
    async function refreshStats() {
        const resp = await chrome.runtime.sendMessage({ action: 'getStats' });
        if (resp?.stats) {
            document.getElementById('today').textContent = resp.stats.today || 0;
            document.getElementById('total').textContent = resp.stats.blocked || 0;
            document.getElementById('domains').textContent = (resp.stats.blocklistSize || 0).toLocaleString();
            document.getElementById('updated').textContent = resp.stats.lastUpdate
                ? new Date(resp.stats.lastUpdate).toLocaleString()
                : 'Never';
        }
    }

    refreshBtn?.addEventListener('click', async () => {
        refreshBtn.disabled = true;
        refreshBtn.textContent = 'Updating...';
        await chrome.runtime.sendMessage({ action: 'refreshBlocklist' });
        setTimeout(async () => {
            await refreshStats();
            await renderWhitelist();
            refreshBtn.disabled = false;
            refreshBtn.textContent = 'Refresh Blocklist Now';
        }, 1200);
        const toast = document.createElement('div');
        toast.textContent = 'Blocklist refreshed!';
        toast.style = 'position:fixed;bottom:20px;right:20px;background:#10b981;color:white;padding:12px 20px;border-radius:8px;z-index:1000;';
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
    });

    // === CLEAR STATS ===
    document.getElementById('clear-stats')?.addEventListener('click', async () => {
        if (confirm('Clear all statistics?')) {
            await chrome.storage.local.remove('OverPhishStats');
            await refreshStats();
        }
    });

    // === SEARCH FILTER ===
    document.getElementById('whitelist-search')?.addEventListener('input', (e) => {
        const term = e.target.value.toLowerCase();
        document.querySelectorAll('.whitelist-item').forEach(item => {
            const text = item.textContent.toLowerCase();
            item.style.display = text.includes(term) ? '' : 'none';
        });
    });

    // === INITIAL LOAD ===
    await refreshStats();
    await renderWhitelist();

    // === REACT TO WHITELIST CHANGES FROM OTHER PAGES (e.g. blocked.html) ===
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.whitelist) {
            renderWhitelist();
        }
    });
});

// === THEME SYSTEM (unchanged — your version is perfect) ===
document.getElementById('theme-toggle')?.addEventListener('click', async () => {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'light' ? 'dark' : 'light';
    await chrome.storage.local.set({ 'overphish-theme': next });
    document.documentElement.setAttribute('data-theme', next);
    updateThemeIcon();
    chrome.runtime.sendMessage({ action: 'themeChanged', theme: next }).catch(() => { });
});

function updateThemeIcon() {
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    document.querySelectorAll('.bi').forEach(el => {
        el.style.display = el.classList.contains(isLight ? 'bi-sun' : 'bi-moon-stars') ? 'inline-block' : 'none';
    });
    const text = document.getElementById('theme-mode');
    if (text) text.textContent = isLight ? 'Light Mode' : 'Dark Mode';
}

function applySavedTheme() {
    chrome.storage.local.get('overphish-theme', (data) => {
        const theme = data['overphish-theme'] ||
            (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
        document.documentElement.setAttribute('data-theme', theme);
        updateThemeIcon();
    });
}

applySavedTheme();
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', applySavedTheme);

// === IMPORT / EXPORT WHITELIST ===

// Export: download current user whitelist as JSON file
document.getElementById('export-whitelist')?.addEventListener('click', async () => {
    try {
        const { whitelist = [] } = await chrome.storage.local.get('whitelist');
        const userWhitelist = whitelist.filter(d => !PERMANENT_WHITELIST.has(d)); // exclude built-ins

        if (userWhitelist.length === 0) {
            alert('No custom domains to export.');
            return;
        }

        const blob = new Blob([JSON.stringify(userWhitelist, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const date = new Date().toISOString().split('T')[0];

        a.download = `overphish-whitelist-${date}.json`;
        a.href = url;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();

        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (err) {
        console.error('Export failed:', err);
        alert('Failed to export whitelist. Check console for details.');
    }
});

// Import: trigger hidden file input
document.getElementById('import-whitelist')?.addEventListener('click', () => {
    document.getElementById('import-file')?.click();
});

// Handle file selection and import
document.getElementById('import-file')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    try {
        const text = await file.text();
        let imported;

        try {
            imported = JSON.parse(text);
        } catch (parseErr) {
            alert('Invalid JSON file.');
            return;
        }

        if (!Array.isArray(imported)) {
            alert('File must contain an array of domains.');
            return;
        }

        // Clean and validate domains
        const cleaned = imported
            .map(d => d.trim().toLowerCase())
            .filter(d => d && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d))
            .filter(d => !PERMANENT_WHITELIST.has(d)); // ignore built-ins

        if (cleaned.length === 0) {
            alert('No valid custom domains found in file.');
            return;
        }

        // Merge with existing user whitelist
        const { whitelist = [] } = await chrome.storage.local.get('whitelist');
        const existingUser = whitelist.filter(d => !PERMANENT_WHITELIST.has(d));
        const duplicates = cleaned.filter(d => existingUser.includes(d));
        if (duplicates.length > 0) {
            console.warn('Skipped duplicates during import:', duplicates);
        }
        const merged = [...new Set([...existingUser, ...cleaned])];

        await chrome.storage.local.set({ whitelist: merged });
        alert(`Imported ${cleaned.length} new domain(s). Total custom: ${merged.length}`);

        // Refresh UI
        await renderWhitelist();
    } catch (err) {
        console.error('Import failed:', err);
        alert('Failed to import whitelist. Check console for details.');
    }

    // Reset file input
    e.target.value = '';
});

chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'themeChanged') {
        document.documentElement.setAttribute('data-theme', msg.theme);
        updateThemeIcon();
    }
});

function reportError(errorObj) {
    return chrome.runtime.sendMessage({
        action: 'logError',
        ...errorObj
    }).catch(() => { });
}

// Also listen to storage (fallback)
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['overphish-theme']) {
        const theme = changes['overphish-theme'].newValue;
        document.documentElement.setAttribute('data-theme', theme);
        updateThemeIcon();
    }
    if (area === 'local' && changes.whitelist) {
        chrome.runtime.sendMessage({ action: 'clearDomainCache' }).catch(() => { });
    }
});

// System preference fallback
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    chrome.storage.local.get('overphish-theme', (data) => {
        const saved = data['overphish-theme'];
        const system = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
        const theme = saved || system;
        document.documentElement.setAttribute('data-theme', theme);
        updateThemeIcon();
    });
});

document.getElementById('view-errors').addEventListener('click', async () => {
    const data = await chrome.storage.local.get(null);
    const errors = Object.entries(data)
        .filter(([k]) => k.startsWith('error_'))
        .map(([k, v]) => `${new Date(v.timestamp).toLocaleString()}: ${v.message}\n${v.stack || ''}`)
        .join('\n---\n');
    if (errors) {
        document.getElementById('error-log').textContent = errors;
    } else {
        document.getElementById('error-log').textContent = 'Checking...';
        setTimeout(() => {
            document.getElementById('error-log').textContent = 'No errors.';
        }, 500);
    }

    // Clear badge when user views errors
    chrome.action.setBadgeText({ text: '' });
});

document.getElementById('clear-errors')?.addEventListener('click', async () => {
    const data = await chrome.storage.local.get(null);
    const keys = Object.keys(data).filter(k => k.startsWith('error_'));
    await chrome.storage.local.remove(keys);
    document.getElementById('error-log').textContent = 'Cleared!';
    chrome.action.setBadgeText({ text: '' });
});