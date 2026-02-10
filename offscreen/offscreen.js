// offscreen/offscreen.js
console.log('[OverPhish Offscreen] Document active - heartbeat started');

// Send heartbeat to background every 15 seconds to prove we're alive
setInterval(() => {
    chrome.runtime.sendMessage({ action: 'offscreen_heartbeat' })
        .catch(err => console.warn('[Offscreen] Heartbeat send failed:', err));
}, 15000);

// Listen for shutdown signal from background (clean exit)
chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'close_offscreen') {
        console.log('[OverPhish Offscreen] Received close signal');
    }
});