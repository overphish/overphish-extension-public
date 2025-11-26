/* OverPhish – https://overphish.app
 * This file is part of the official OverPhish extension.
 * Redistribution and publication to extension stores is strictly prohibited.
 * © 2025 OverPhish.app – All rights reserved.
 */

/************************************************************
 *  OverPhish – background.js (Manifest V3 service worker)  *
 ************************************************************/

importScripts('bloomfilter.js');
importScripts('trie.js');

/* ==================== CONSTANTS ==================== */
const BLOCKLIST_URL = "https://overphish.io/blocklist.txt";
const BLOCKLIST_META_KEY = 'OverPhish_BlocklistMeta';
const STORAGE_KEY = 'blocklistMeta';
const STATS_KEY = 'OverPhishStats';
const DB_NAME = 'OverPhishDB';
const STORE_NAME = 'blocklist';
const MAX_AGE = 6 * 60 * 60 * 1000;  // 6 hours

const DEFAULT_WHITELIST = new Set([
    'google.com', 'www.google.com',
    'youtube.com', 'www.youtube.com',
    'facebook.com', 'www.facebook.com',
    'twitter.com', 'www.twitter.com', 'x.com',
    'github.com', 'localhost', '127.0.0.1'
]);

/* ==================== GLOBALS ==================== */
let stats = { blocked: 0, today: 0, blocklistSize: 0, lastUpdate: null };
let db = null;
let bloom = null;
let trie = null;
const DOMAIN_CACHE = new Map();
const MAX_CACHE = 10_000;
const USE_TRIE = true;

let whitelistVersion = 0;
let keepAlive = null;
const progressPorts = new Set();
let fetchRetryDelay = 5 * 60 * 1000;
const MAX_RETRY_DELAY = 60 * 60 * 1000;

/* ==================== KEEP-ALIVE & PORTS ==================== */
function startKeepAlive() {
    if (keepAlive) clearInterval(keepAlive);
    keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => { }), 20_000);
}

chrome.runtime.onConnect.addListener(port => {
    if (port.name !== 'overphish-progress') return;
    progressPorts.add(port);
    port.onDisconnect.addListener(() => progressPorts.delete(port));
});

function broadcast(msg) {
    for (const p of progressPorts) {
        try { p.postMessage(msg); } catch { progressPorts.delete(p); }
    }
}

function abbreviateNumber(n) {
    const units = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
    for (const [v, s] of units) if (Math.abs(n) >= v) return (n / v < 10 ? (n / v).toFixed(1) : Math.round(n / v)) + s;
    return n.toString();
}

/* ==================== HELPERS ==================== */
function reverseDomain(d) { return d.toLowerCase().split('.').reverse().join('.'); }

const COMMON_TLDS = new Set(['com', 'org', 'net', 'co.uk', 'de', 'ru', 'cn', 'xyz', 'top', 'info', 'club', 'online', 'shop', 'site', 'store', 'tech', 'live', 'app']);
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

function cacheSet(key, value) {
    if (DOMAIN_CACHE.size >= MAX_CACHE) {
        DOMAIN_CACHE.delete(DOMAIN_CACHE.keys().next().value);
    }
    DOMAIN_CACHE.set(key, value);
}

/* ==================== WHITELIST ==================== */
let cachedWhitelist = null;
let cachedVersion = -1;
async function getFullWhitelist() {
    if (cachedWhitelist && cachedVersion === whitelistVersion) return cachedWhitelist;
    const { whitelist = [] } = await chrome.storage.local.get('whitelist');
    cachedWhitelist = new Set([...DEFAULT_WHITELIST, ...whitelist]);
    cachedVersion = whitelistVersion;
    return cachedWhitelist;
}

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.whitelist) {
        whitelistVersion++;
        cachedWhitelist = null;
        DOMAIN_CACHE.clear();  // NUCLEAR CACHE INVALIDATION
        console.log('[OverPhish] Whitelist changed → cache nuked');
    }
});

/* ==================== INDEXEDDB ==================== */
function openDB() {
    return new Promise((res, rej) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = e => e.target.result.createObjectStore(STORE_NAME);
        req.onsuccess = e => { db = e.target.result; res(); };
        req.onerror = e => rej(e.target.error);
    });
}

async function addDomains(domains) {
    if (!db) await openDB();
    if (db) {
        db.onerror = async (e) => {
            console.error('[OverPhish] IndexedDB error → recovering', e);
            await clearDB();
            await fetchBlocklist(true);
            await buildFastStructures();
        };
    }
    return new Promise(res => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        domains.forEach(d => store.put(true, d));
        tx.oncomplete = res;
    });
}

async function clearDB() {
    if (!db) await openDB();
    if (db) {
        db.onerror = async (e) => {
            console.error('[OverPhish] IndexedDB error → recovering', e);
            await clearDB();
            await fetchBlocklist(true);
            await buildFastStructures();
        };
    }
    return new Promise(res => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).clear();
        tx.oncomplete = res;
    });
}

/* ==================== BLOCK CHECK ==================== */
async function isDomainBlocked(hostname) {
    if (!hostname) return false;

    const cacheKey = hostname;

    // Allow-once
    const allowData = await chrome.storage.session.get(`allow_${hostname}`);
    const allowUntil = allowData[`allow_${hostname}`];
    if (allowUntil) {
        if (Date.now() < allowUntil) return false;
        await chrome.storage.session.remove(`allow_${hostname}`);
    }

    // Whitelist
    const wl = await getFullWhitelist();
    const reg = getRegistrableDomain(hostname);
    if (wl.has(hostname) || (reg && wl.has(reg))) {
        cacheSet(cacheKey, false);
        return false;
    }

    if (DOMAIN_CACHE.has(cacheKey)) return DOMAIN_CACHE.get(cacheKey);

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

    const blocked = USE_TRIE && trie ? trie.searchSuffix(rev) : await slowCheck(rev);
    cacheSet(cacheKey, blocked);
    return blocked;
}

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

/* ==================== BLOCKLIST FETCH ==================== */
async function fetchBlocklist(force = false) {
    const meta = await chrome.storage.local.get(BLOCKLIST_META_KEY);
    const savedMeta = meta[BLOCKLIST_META_KEY] || { size: 0, lastUpdate: 0 };
    const now = Date.now();

    // Force update every 7 days no matter what + on first install
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
    try {
        const response = await fetch(`${BLOCKLIST_URL}?t=${now}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

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
                broadcast({ action: 'progress', current: received });
            }
        }

        const txt = await new Blob(chunks).text();
        const domains = txt.split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#'))
            .map(reverseDomain);

        broadcast({ action: 'phase', phase: 'indexing' });
        await clearDB();
        const chunk = 5000;
        for (let i = 0; i < domains.length; i += chunk) {
            await addDomains(domains.slice(i, i + chunk));
            broadcast({ action: 'progress', current: i + chunk, total: domains.length });
        }

        const newMeta = {
            size: domains.length,
            lastUpdate: now,
            version: (savedMeta.version || 0) + 1
        };

        await chrome.storage.local.set({ [BLOCKLIST_META_KEY]: newMeta });

        stats.blocklistSize = newMeta.size;
        stats.lastUpdate = newMeta.lastUpdate;

        chrome.action.setBadgeText({ text: abbreviateNumber(domains.length) });
        chrome.action.setBadgeBackgroundColor({ color: '#1a73e8' });
        broadcast({ action: 'phase', phase: 'ready' });
        broadcast({ action: 'blocklistUpdated', size: domains.length });
    } catch (e) {
        console.error('[OverPhish] fetch failed:', e);
        setTimeout(() => fetchBlocklist(true), fetchRetryDelay = Math.min(fetchRetryDelay * 2, MAX_RETRY_DELAY));
    }
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/* ==================== FAST STRUCTURES ==================== */
async function buildFastStructures() {
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

    bloom = new BloomFilter(domains.length * 2, 0.01);
    domains.forEach(d => bloom.add(d));

    if (USE_TRIE) {
        trie = new DomainTrie();
        domains.forEach(d => trie.insert(d));
    }
    console.log('[OverPhish] Bloom + Trie ready');
}

/* ==================== DNR BLOCKING ==================== */
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
    if (details.frameId !== 0) return;

    let hostname = '';
    try { hostname = new URL(details.url).hostname.replace(/^www\./, ''); }
    catch { return; }

    const blocked = await isDomainBlocked(hostname);
    if (!blocked) return;

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

    const blockedPageUrl = chrome.runtime.getURL('blocked/blocked.html') + '?url=' + encodeURIComponent(details.url);
    const escaped = hostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = `^https?://([^/]*\\.)?${escaped}(/.*)?$`;

    try {
        await chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: [1],
            addRules: [{
                id: 1,
                priority: 1,
                action: { type: "block" },
                condition: {
                    regexFilter: regex,
                    resourceTypes: ["main_frame", "sub_frame"]
                }
            }]
        });

        chrome.tabs.update(details.tabId, { url: blockedPageUrl });

        setTimeout(() => {
            chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [1] }).catch(() => { });
        }, 3000);
    } catch (err) {
        console.error('[OverPhish] DNR failed:', err);
        chrome.tabs.update(details.tabId, { url: blockedPageUrl });
    }
}, { url: [{ schemes: ["http", "https"] }] });

chrome.webNavigation.onErrorOccurred.addListener((details) => {
    if (details.frameId === 0 && details.error.includes("net::ERR_BLOCKED_BY_CLIENT")) {
        chrome.tabs.update(details.tabId, {
            url: chrome.runtime.getURL('blocked/blocked.html') + '?url=' + encodeURIComponent(details.url)
        });
    }
}, { url: [{ schemes: ["http", "https"] }] });

/* ==================== MESSAGING ==================== */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'allowOnce' || msg.action === 'allowOnceFromContent') {
        (async () => {
            let hostname = msg.hostname;
            if (!hostname && msg.url) {
                try { hostname = new URL(msg.url).hostname.replace(/^www\./, ''); }
                catch { sendResponse({ ok: false }); return; }
            }
            if (!hostname) { sendResponse({ ok: false }); return; }

            const until = Date.now() + 5 * 60 * 1000;
            await chrome.storage.session.set({ [`allow_${hostname}`]: until });
            DOMAIN_CACHE.delete(hostname);

            if (sender.tab?.url?.includes('blocked/blocked.html')) {
                chrome.tabs.update(sender.tab.id, { url: msg.url || sender.tab.url.split('?')[0] });
            }
            sendResponse({ ok: true });
        })();
        return true;
    }

    if (msg.action === 'whitelist' || msg.action === 'whitelistManual') {
        (async () => {
            let domain = msg.domain || msg.hostname;
            if (msg.url && !domain) {
                try { domain = new URL(msg.url).hostname.replace(/^www\./, ''); }
                catch { }
            }
            if (!domain) {
                sendResponse({ ok: false });
                return;
            }

            // === NEVER store default domains in user whitelist ===
            const { whitelist = [] } = await chrome.storage.local.get('whitelist');
            const cleanExisting = whitelist.filter(d => !DEFAULT_WHITELIST.has(d));

            if (!DEFAULT_WHITELIST.has(domain)) {
                cleanExisting.push(domain);
            }

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
            const domain = msg.domain;
            const { whitelist = [] } = await chrome.storage.local.get('whitelist');
            const updated = whitelist.filter(d => d !== domain && !DEFAULT_WHITELIST.has(d));
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
chrome.runtime.onInstalled.addListener(() => init());
chrome.runtime.onStartup.addListener(() => init());

async function init() {
    await openDB();
    if (db) {
        db.onerror = async (e) => {
            console.error('[OverPhish] IndexedDB error → recovering', e);
            await clearDB();
            await fetchBlocklist(true);
            await buildFastStructures();
        };
    }

    const meta = await chrome.storage.local.get(BLOCKLIST_META_KEY);
    const savedMeta = meta[BLOCKLIST_META_KEY] || { size: 0, lastUpdate: 0 };

    const dbCount = await new Promise(res => {
        const tx = db.transaction(STORE_NAME);
        tx.objectStore(STORE_NAME).count().onsuccess = e => res(e.target.result);
    });

    // If DB empty or corrupted → force full refresh
    if (dbCount === 0 || dbCount !== savedMeta.size) {
        console.log('[OverPhish] Blocklist missing or corrupted → forcing update');
        await fetchBlocklist(true);
    } else {
        stats.blocklistSize = savedMeta.size;
        stats.lastUpdate = savedMeta.lastUpdate;
        chrome.action.setBadgeText({ text: abbreviateNumber(savedMeta.size) });
        chrome.action.setBadgeBackgroundColor({ color: '#1a73e8' });
    }

    await buildFastStructures();

    const saved = await chrome.storage.local.get(STATS_KEY);
    if (saved[STATS_KEY]) {
        const { blocked, today, todayStr } = saved[STATS_KEY];
        stats.blocked = blocked || 0;
        stats.today = (new Date().toDateString() === todayStr) ? (today || 0) : 0;
    }

    // Auto-update every 6 hours
    setInterval(() => fetchBlocklist(false), MAX_AGE);
    startKeepAlive();
}