/* OverPhish – https://overphish.app
 * This file is part of the official OverPhish extension.
 * Redistribution and publication to extension stores is strictly prohibited.
 * © 2025 OverPhish.app – All rights reserved.
 */

/************************************************************
 *  OverPhish – background.js (Manifest V3 service worker)  *
 ************************************************************/

// Import external scripts for data structures
importScripts('bloomfilter.js');
importScripts('trie.js');

/* ==================== CONSTANTS ==================== */
// URL for fetching the blocklist
const BLOCKLIST_URL = "https://overphish.io/blocklist.txt";
// Storage keys for metadata and stats
const BLOCKLIST_META_KEY = 'OverPhish_BlocklistMeta';
const STATS_KEY = 'OverPhishStats';

const BLOOM_STORAGE_KEY = 'OverPhish_BloomCache';
const BLOOM_META_KEY = 'OverPhish_BloomMeta';   // version + timestamp

// IndexedDB configuration
const DB_NAME = 'OverPhishDB';
const STORE_NAME = 'blocklist';
// Cache and update intervals (in milliseconds)
const MAX_AGE = 6 * 60 * 60 * 1000;  // 6 hours for auto-update
const MAX_CACHE = 10_000;  // Maximum entries in domain cache
// Default whitelisted domains (not stored in user whitelist)
const PERMANENT_WHITELIST = new Set([
    // Google ecosystem
    'google.com', 'www.google.com',
    'youtube.com', 'www.youtube.com',
    'youtu.be',
    'googleapis.com',
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
    '::1',

    // Common CDNs / auth providers that break sites when blocked
    'cloudflare.com',
    'cloudflare.net',
    'akamai.net',
    'akamaized.net',
    'fastly.net',
]);
// Common TLDs for registrable domain extraction
const COMMON_TLDS = new Set(['com', 'org', 'net', 'co.uk', 'de', 'ru', 'cn', 'xyz', 'top', 'info', 'club', 'online', 'shop', 'site', 'store', 'tech', 'live', 'app']);
// Feature flags and retry settings
const USE_TRIE = true;
const MAX_RETRY_DELAY = 60 * 60 * 1000;  // 1 hour max retry delay

/* ==================== GLOBALS ==================== */
// Statistics for blocks and blocklist status
let stats = { blocked: 0, today: 0, blocklistSize: 0, lastUpdate: null };
// IndexedDB reference
let db = null;
// Fast lookup structures
let bloom = null;
let trie = null;
// Cache for quick domain block checks (hostname -> blocked boolean)
const DOMAIN_CACHE = new Map();
// Whitelist caching for efficiency
let cachedWhitelist = null;
let cachedVersion = -1;
let whitelistVersion = 0;
// Keep-alive interval for service worker persistence
let keepAlive = null;
// Ports for progress broadcasting (e.g., to popup)
const progressPorts = new Set();
// Initial retry delay for blocklist fetch failures (starts at 5 minutes, exponential backoff)
let fetchRetryDelay = 5 * 60 * 1000;

let isInitializing = null;
let globalRuleCounter = Date.now() % 100000;
let blockMeta = {};

/* ==================== KEEP-ALIVE & PORTS ==================== */
/**
 * Starts a keep-alive interval to prevent service worker termination.
 * Calls a harmless API every 20 seconds.
 */
function startKeepAlive() {
    if (keepAlive) clearInterval(keepAlive);
    keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => { }), 20_000);
}

async function ensureReady() {
    if (isInitializing) return isInitializing;
    isInitializing = init();
    return isInitializing;
}

/**
 * Listens for connections from other parts of the extension (e.g., popup).
 * Manages ports for progress updates.
 */
chrome.runtime.onConnect.addListener(port => {
    if (port.name !== 'overphish-progress') return;
    progressPorts.add(port);
    port.onDisconnect.addListener(() => progressPorts.delete(port));
});

/**
 * Broadcasts a message to all connected progress ports.
 * @param {Object} msg - Message to send.
 */
function broadcast(msg) {
    for (const p of progressPorts) {
        try { p.postMessage(msg); } catch { progressPorts.delete(p); }
    }
}

/**
 * Abbreviates large numbers with suffixes (e.g., 1000 -> 1K).
 * @param {number} n - Number to abbreviate.
 * @returns {string} Abbreviated string.
 */
function abbreviateNumber(n) {
    const units = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
    for (const [v, s] of units) if (Math.abs(n) >= v) return (n / v < 10 ? (n / v).toFixed(1) : Math.round(n / v)) + s;
    return n.toString();
}

/**
 * Formats bytes into human-readable string (e.g., 1024 -> 1 KB).
 * @param {number} bytes - Bytes to format.
 * @returns {string} Formatted string.
 */
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/* ==================== HELPERS ==================== */
/**
 * Reverses a domain for suffix matching (e.g., example.com -> com.example).
 * @param {string} d - Domain to reverse.
 * @returns {string} Reversed domain.
 */
function reverseDomain(d) {
    return d.toLowerCase().split('.').reverse().join('.');
}

/**
 * Extracts the registrable domain (e.g., sub.example.co.uk -> example.co.uk).
 * Handles common multi-part TLDs.
 * @param {string} hostname - Hostname to process.
 * @returns {string} Registrable domain or original hostname if invalid.
 */
function getRegistrableDomain(hostname) {
    if (!hostname || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname)) return hostname;
    hostname = hostname.toLowerCase().replace(/^\.+/, '');
    if (!hostname.includes('.')) return hostname;
    const parts = hostname.split('.');
    if (parts.length <= 2) return hostname;
    const tld = parts.slice(-1)[0];
    const sld = parts.slice(-2)[0];
    if (COMMON_TLDS.has(`${sld}.${tld}`)) return parts.slice(-3).join('.');
    return `${sld}.${tld}`;
}

/**
 * Sets a value in the domain cache, evicting oldest if at max size.
 * @param {string} key - Cache key (hostname).
 * @param {boolean} value - Blocked status.
 */
function cacheSet(key, value) {
    if (DOMAIN_CACHE.size >= MAX_CACHE) {
        DOMAIN_CACHE.delete(DOMAIN_CACHE.keys().next().value);
    }
    DOMAIN_CACHE.set(key, value);
}

/* ==================== WHITELIST ==================== */
/**
 * Retrieves the full whitelist, combining defaults and user additions.
 * Caches for performance, invalidates on changes.
 * @returns {Promise<Set<string>>} Set of whitelisted domains.
 */
async function getFullWhitelist() {
    if (cachedWhitelist && cachedVersion === whitelistVersion) return cachedWhitelist;
    const { whitelist = [] } = await chrome.storage.local.get('whitelist');
    cachedWhitelist = new Set([...PERMANENT_WHITELIST, ...whitelist]);
    cachedVersion = whitelistVersion;
    return cachedWhitelist;
}

// Listen for whitelist changes and invalidate caches
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.whitelist) {
        whitelistVersion++;
        cachedWhitelist = null;
        DOMAIN_CACHE.clear();
        console.log('[OverPhish] Whitelist changed → cache invalidated');
    }
});

/* ==================== INDEXEDDB ==================== */
/**
 * Opens or creates the IndexedDB database.
 * @returns {Promise<void>} Resolves when DB is open.
 */
function openDB() {
    return new Promise((res, rej) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = e => e.target.result.createObjectStore(STORE_NAME);
        req.onsuccess = e => { db = e.target.result; res(); };
        req.onerror = e => rej(e.target.error);
    });
}

/**
 * Adds domains to the IndexedDB store in a transaction.
 * @param {string[]} domains - Array of reversed domains to add.
 * @returns {Promise<void>} Resolves on transaction complete.
 */
async function addDomains(domains) {
    if (!db) await openDB();
    return new Promise(res => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        domains.forEach(d => store.put(true, d));
        tx.oncomplete = res;
    });
}

/**
 * Clears all data from the IndexedDB store.
 * @returns {Promise<void>} Resolves on transaction complete.
 */
async function clearDB() {
    if (!db) await openDB();
    return new Promise(res => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).clear();
        tx.oncomplete = res;
    });
}

// Global DB error handler: Recover by clearing and refetching
if (db) {
    db.onerror = async (e) => {
        console.error('[OverPhish] IndexedDB error → recovering', e);
        await clearDB();
        await fetchBlocklist(true);
        await buildFastStructures();
    };
}

/* ==================== BLOCK CHECK ==================== */
/**
 * Checks if a domain is blocked, using cache, whitelist, Bloom filter, and Trie/DB fallback.
 * @param {string} hostname - Hostname to check.
 * @returns {Promise<boolean>} True if blocked.
 */
async function isDomainBlocked(hostname) {
    if (!hostname) return false;
    const cacheKey = hostname;

    // Check session-based allow-once
    const allowData = await chrome.storage.session.get(`allow_${hostname}`);
    const allowUntil = allowData[`allow_${hostname}`];
    if (allowUntil) {
        if (Date.now() < allowUntil) return false;
        await chrome.storage.session.remove(`allow_${hostname}`);
    }

    // Check whitelist (full hostname or registrable domain)
    const wl = await getFullWhitelist();
    const reg = getRegistrableDomain(hostname);
    if (wl.has(hostname) || (reg && wl.has(reg))) {
        cacheSet(cacheKey, false);
        return false;
    }

    // Cache hit
    if (DOMAIN_CACHE.has(cacheKey)) return DOMAIN_CACHE.get(cacheKey);

    // Bloom filter probabilistic check on suffixes
    const rev = reverseDomain(hostname);
    let might = false;
    for (let i = 1; i <= rev.split('.').length; i++) {
        const suffix = rev.split('.').slice(0, i).join('.');
        if (bloom?.mightContain(suffix)) { might = true; break; }
    }
    if (!might) {
        cacheSet(cacheKey, false);
        return false;
    }

    // Exact check using Trie (preferred) or slow DB scan
    const blocked = USE_TRIE && trie ? trie.searchSuffix(rev) : await slowCheck(rev);
    cacheSet(cacheKey, blocked);
    return blocked;
}

/**
 * Slow fallback check for domain suffixes in IndexedDB.
 * @param {string} rev - Reversed domain.
 * @returns {Promise<boolean>} True if any suffix matches.
 */
async function slowCheck(rev) {
    return new Promise(res => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const parts = rev.split('.');
        let found = false;
        for (let i = 1; i <= parts.length; i++) {
            const suffix = parts.slice(0, i).join('.');
            const req = store.get(suffix);
            req.onsuccess = () => { if (req.result) found = true; };
        }
        tx.oncomplete = () => res(found);
    });
}

/* ==================== OFFSCREEN HELPERS ==================== */
async function setupOffscreen() {
    try {
        const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
        if (contexts.length > 0) return;

        await chrome.offscreen.createDocument({
            url: 'offscreen/offscreen.html',
            reasons: ['LOCAL_STORAGE'],
            justification: 'Keep service worker alive during blocklist sync.'
        });
    } catch (err) {
        console.warn('[Offscreen] Setup failed, proceeding without heartbeat:', err);
    }
}

async function closeOffscreen() {
    const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    if (existingContexts.length > 0) {
        await chrome.offscreen.closeDocument();
    }
}

/* ==================== BLOCKLIST FETCH ==================== */
/**
 * Fetches and updates the blocklist if stale or forced.
 * Processes in chunks, updates storage, and broadcasts progress.
 * @param {boolean} [force=false] - Force update regardless of age.
 */
async function fetchBlocklist(force = false) {
    const meta = await chrome.storage.local.get(BLOCKLIST_META_KEY);
    const savedMeta = meta[BLOCKLIST_META_KEY] || { size: 0, lastUpdate: 0 };
    const now = Date.now();

    // Force full update every 7 days or if first install
    const mustUpdate = now - savedMeta.lastUpdate > 7 * 24 * 60 * 60 * 1000;
    if (!force && !mustUpdate && savedMeta.size > 0 && now - savedMeta.lastUpdate < MAX_AGE) {
        stats.blocklistSize = savedMeta.size;
        stats.lastUpdate = savedMeta.lastUpdate;
        chrome.action.setBadgeText({ text: abbreviateNumber(savedMeta.size) });
        chrome.action.setBadgeBackgroundColor({ color: '#1a73e8' });
        broadcast({ action: 'phase', phase: 'ready' });
        return;
    }

    broadcast({ action: 'phase', phase: 'download' });
    await setupOffscreen(); // Start the heartbeat.
    try {
        const response = await fetch(`${BLOCKLIST_URL}?t=${now}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        // Stream response for large files
        const reader = response.body.getReader();
        const chunks = [];
        let received = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
                chunks.push(value);
                received += value.length;
                chrome.action.setBadgeText({ text: formatBytes(received) });
                broadcast({ action: 'progress', type: 'download', current: received });
            }
        }

        // Parse domains from text
        const txt = await new Blob(chunks).text();
        const domains = txt.split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#'))
            .map(reverseDomain);

        // Index in chunks to avoid blocking
        broadcast({ action: 'phase', phase: 'indexing' });
        await clearDB();
        const chunkSize = 5000;
        for (let i = 0; i < domains.length; i += chunkSize) {
            await addDomains(domains.slice(i, i + chunkSize));
            broadcast({ action: 'progress', type: 'indexing', current: i + chunkSize, total: domains.length });
        }

        // Update metadata
        const newMeta = {
            size: domains.length,
            lastUpdate: now,
            version: (savedMeta.version || 0) + 1
        };
        await chrome.storage.local.set({ [BLOCKLIST_META_KEY]: newMeta });
        // Invalidate old bloom cache (next startup will rebuild)
        await chrome.storage.local.remove([BLOOM_STORAGE_KEY, BLOOM_META_KEY]);

        stats.blocklistSize = newMeta.size;
        stats.lastUpdate = newMeta.lastUpdate;
        chrome.action.setBadgeText({ text: abbreviateNumber(domains.length) });
        chrome.action.setBadgeBackgroundColor({ color: '#1a73e8' });
        broadcast({ action: 'phase', phase: 'ready' });
        broadcast({ action: 'blocklistUpdated', size: domains.length });
    } catch (e) {
        console.error('[OverPhish] Blocklist fetch failed:', e);
        // Exponential backoff retry
        setTimeout(() => fetchBlocklist(true), fetchRetryDelay = Math.min(fetchRetryDelay * 2, MAX_RETRY_DELAY));
    } finally {
        await closeOffscreen();
    }
}

/* ==================== FAST STRUCTURES ==================== */
/**
 * Builds Bloom filter and Trie from IndexedDB for fast lookups.
 */
async function buildFastStructures() {
    const start = performance.now();

    // Load all domains from DB
    const domains = [];
    await new Promise(res => {
        const tx = db.transaction(STORE_NAME);
        const store = tx.objectStore(STORE_NAME);
        store.openCursor().onsuccess = e => {
            const cur = e.target.result;
            if (cur) { domains.push(cur.key); cur.continue(); }
            else res();
        };
    });

    // Build Bloom filter
    bloom = new BloomFilter(domains.length * 2, 0.01);
    domains.forEach(d => bloom.add(d));

    // Build Trie if enabled
    if (USE_TRIE) {
        trie = new DomainTrie();
        domains.forEach(d => trie.insert(d));
    }

    console.log(`[OverPhish] Bloom + Trie ready in ${(performance.now() - start).toFixed(0)} ms`);

    try {
        const bloomData = {
            bitArray: Array.from(bloom.bitArray),   // Uint8Array → plain array
            size: bloom.size,
            hashCount: bloom.hashCount
        };

        const meta = {
            version: (typeof blockMeta !== 'undefined' ? blockMeta.version : 0) || 0,
            timestamp: Date.now(),
            domainCount: stats.blocklistSize || 0
        };

        await chrome.storage.local.set({
            [BLOOM_STORAGE_KEY]: bloomData,
            [BLOOM_META_KEY]: meta
        });

        console.log('[OverPhish] Bloom filter persisted to storage');
    } catch (err) {
        console.warn('[OverPhish] Failed to save Bloom cache', err);
    }

}

/* ==================== DNR BLOCKING ==================== */
/**
 * Listens for navigation and blocks if domain is in blocklist.
 * Uses DNR for blocking and redirects to blocked page.
 */
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
    await ensureReady(); // The worker won't proceed until init() is done

    if (details.frameId !== 0) return;  // Main frame only

    let hostname = '';
    try { hostname = new URL(details.url).hostname.replace(/^www\./, ''); } catch { return; }

    const blocked = await isDomainBlocked(hostname);
    if (!blocked) return;

    // Update stats
    stats.today++;
    stats.blocked++;
    await chrome.storage.local.set({
        [STATS_KEY]: {
            blocked: stats.blocked,
            today: stats.today,
            todayStr: new Date().toDateString()
        }
    });
    broadcast({ action: 'blockCount', today: stats.today });

    // Prepare blocked page URL
    const blockedPageUrl = chrome.runtime.getURL('blocked/blocked.html') + '?url=' + encodeURIComponent(details.url);

    // Temporarily add DNR rule to block the domain
    const escaped = hostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = `^https?://([^/]*\\.)?${escaped}(/.*)?$`;
    const tempRuleId = globalRuleCounter++ % 10000;

    if (typeof tempRuleId !== 'number' || tempRuleId < 1) {
        console.error('[DNR] Invalid rule ID:', tempRuleId);
        chrome.tabs.update(details.tabId, { url: blockedPageUrl });
        return;
    }

    try {
        await chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: [tempRuleId],
            addRules: [{
                id: tempRuleId,
                priority: 1,
                action: { type: "block" },
                condition: {
                    regexFilter: regex,
                    resourceTypes: ["main_frame", "sub_frame"]
                }
            }]
        });
        console.log('[DNR] Temporary block rule added for tab', details.tabId, 'ID:', tempRuleId);

        chrome.tabs.update(details.tabId, { url: blockedPageUrl });

        setTimeout(() => {
            chrome.declarativeNetRequest.updateDynamicRules({
                removeRuleIds: [tempRuleId]
            }).catch(() => { });
        }, 3000);
    } catch (err) {
        console.error('[OverPhish] DNR update failed:', err);
        chrome.tabs.update(details.tabId, { url: blockedPageUrl });
    }
}, { url: [{ schemes: ["http", "https"] }] });

// Handle blocked errors by redirecting to blocked page
chrome.webNavigation.onErrorOccurred.addListener((details) => {
    if (details.frameId === 0 && details.error.includes("net::ERR_BLOCKED_BY_CLIENT")) {
        chrome.tabs.update(details.tabId, {
            url: chrome.runtime.getURL('blocked/blocked.html') + '?url=' + encodeURIComponent(details.url)
        });
    }
}, { url: [{ schemes: ["http", "https"] }] });

/* ==================== MESSAGING ==================== */
/**
 * Handles messages from other parts of the extension (e.g., popup, content scripts).
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'checkDomains') {
        (async () => {
            await ensureReady();
            const hostnames = msg.hostnames || [];
            const blocked = [];

            for (const hostname of hostnames) {
                const isBlocked = await isDomainBlocked(hostname);
                if (isBlocked) blocked.push(hostname);
            }

            sendResponse({ blocked });
        })();
        return true;  // Async response
    }

    if (msg.action === 'allowOnce' || msg.action === 'allowOnceFromContent') {
        (async () => {
            await ensureReady();
            let hostname = msg.hostname;
            if (!hostname && msg.url) {
                try { hostname = new URL(msg.url).hostname.replace(/^www\./, ''); } catch { sendResponse({ ok: false }); return; }
            }
            if (!hostname) { sendResponse({ ok: false }); return; }

            // Set 5-minute allow-once in session storage
            const until = Date.now() + 5 * 60 * 1000;
            await chrome.storage.session.set({ [`allow_${hostname}`]: until });
            DOMAIN_CACHE.delete(hostname);

            // Reload tab if on blocked page
            if (sender.tab?.url?.includes('blocked/blocked.html')) {
                chrome.tabs.update(sender.tab.id, { url: msg.url || sender.tab.url.split('?')[0] });
            }
            sendResponse({ ok: true });
        })();
        return true;
    }

    if (msg.action === 'whitelist' || msg.action === 'whitelistManual') {
        (async () => {
            await ensureReady();
            let domain = msg.domain || msg.hostname;
            if (msg.url && !domain) {
                try { domain = new URL(msg.url).hostname.replace(/^www\./, ''); } catch { }
            }
            if (!domain) { sendResponse({ ok: false }); return; }

            // Update user whitelist (exclude defaults)
            const { whitelist = [] } = await chrome.storage.local.get('whitelist');
            const cleanExisting = whitelist.filter(d => !PERMANENT_WHITELIST.has(d));
            if (!PERMANENT_WHITELIST.has(domain)) cleanExisting.push(domain);
            await chrome.storage.local.set({ whitelist: cleanExisting });
            whitelistVersion++;
            cachedWhitelist = null;
            DOMAIN_CACHE.clear();

            // Reload tab if on blocked page
            if (sender.tab?.id && msg.url) {
                chrome.tabs.update(sender.tab.id, { url: msg.url });
            }
            sendResponse({ ok: true });
        })();
        return true;
    }

    if (msg.action === 'removeFromWhitelist') {
        (async () => {
            await ensureReady();
            const domain = msg.domain;
            const { whitelist = [] } = await chrome.storage.local.get('whitelist');
            const updated = whitelist.filter(d => d !== domain && !PERMANENT_WHITELIST.has(d));
            await chrome.storage.local.set({ whitelist: updated });
            whitelistVersion++;
            cachedWhitelist = null;
            DOMAIN_CACHE.clear();
            sendResponse({ ok: true });
        })();
        return true;
    }

    if (msg.action === 'refreshBlocklist') {
        fetchBlocklist(true);
        sendResponse({ ok: true });
        return false;
    }

    if (msg.action === 'getStats') {
        sendResponse({ stats: { blocked: stats.blocked, today: stats.today, blocklistSize: stats.blocklistSize, lastUpdate: stats.lastUpdate } });
        return false;
    }

    return false;
});

/* ==================== STARTUP ==================== */
/**
 * Initializes the extension on install or startup.
 * Opens DB, checks blocklist integrity, builds structures, loads stats, sets auto-update.
 */
async function init() {
    await openDB();

    let restored = false;
    blockMeta = { version: 0, size: 0 };

    // Attempt fast Bloom restore
    try {
        const data = await chrome.storage.local.get([
            BLOOM_STORAGE_KEY,
            BLOOM_META_KEY,
            BLOCKLIST_META_KEY
        ]);

        const bloomSaved = data[BLOOM_STORAGE_KEY];
        const bloomMeta = data[BLOOM_META_KEY];
        blockMeta = data[BLOCKLIST_META_KEY] || { version: 0, size: 0 };

        if (
            bloomSaved &&
            bloomMeta &&
            bloomMeta.version === blockMeta.version &&
            bloomMeta.domainCount === blockMeta.size
        ) {
            bloom = new BloomFilter(bloomSaved.size, bloomSaved.hashCount);
            bloom.bitArray = new Uint8Array(bloomSaved.bitArray);
            console.log('[OverPhish] Bloom restored in', Date.now() - bloomMeta.timestamp, 'ms');
            restored = true;
        }
    } catch (err) {
        console.warn('[OverPhish] Bloom restore failed:', err);
    }

    // Load blocklist metadata
    const meta = await chrome.storage.local.get(BLOCKLIST_META_KEY);
    const savedMeta = meta[BLOCKLIST_META_KEY] || { size: 0, lastUpdate: 0 };

    const dbCount = await new Promise(res => {
        const tx = db.transaction(STORE_NAME);
        tx.objectStore(STORE_NAME).count().onsuccess = e => res(e.target.result);
    });

    if (dbCount === 0 || dbCount !== savedMeta.size) {
        console.log('[OverPhish] DB empty/mismatched → force update');
        await fetchBlocklist(true);
        // After force fetch → restored will be false → will rebuild below
    } else {
        stats.blocklistSize = savedMeta.size;
        stats.lastUpdate = savedMeta.lastUpdate;
        chrome.action.setBadgeText({ text: abbreviateNumber(savedMeta.size) });
        chrome.action.setBadgeBackgroundColor({ color: '#1a73e8' });
    }

    // Build structures only if not restored
    if (!restored) {
        console.log('[OverPhish] Building Bloom + Trie');
        await buildFastStructures();
    }

    if (restored) {
        broadcast({ action: 'phase', phase: 'ready' });
    }

    // Load stats
    const saved = await chrome.storage.local.get(STATS_KEY);
    if (saved[STATS_KEY]) {
        const { blocked, today, todayStr } = saved[STATS_KEY];
        stats.blocked = blocked || 0;
        stats.today = (new Date().toDateString() === todayStr) ? (today || 0) : 0;
    }

    // setInterval(() => fetchBlocklist(false), MAX_AGE);
    chrome.alarms.create('checkBlocklistUpdate', { periodInMinutes: 60 });

    chrome.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === 'checkBlocklistUpdate') {
            fetchBlocklist(false);
        }
    });
    startKeepAlive();
}

// Register init listeners
chrome.runtime.onInstalled.addListener(() => { ensureReady(); });
chrome.runtime.onStartup.addListener(() => { ensureReady(); });
if (!isInitializing) {
    ensureReady().catch(err => console.error("Background init failed on load", err));
}