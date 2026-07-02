// Karafilt — Party bridge (content script, injected on /party pages only).
//
// Relays messages between the host player page and the extension service worker
// so the page can read filter status and control the filter (mode / removal)
// WITHOUT needing the extension id or externally_connectable. The page posts
// { source: "karafilt-party", type, value, reqId }; we forward to the SW and
// post the reply back as { source: "karafilt-party-ext", reqId, response }.
// (The page can never START the filter — that's still a user gesture on the
// extension: the right-click menu or Ctrl+Shift+K.)
(function () {
  // Injected both by manifest content_scripts and programmatically after an
  // extension reload (injectIntoOpenTabs) — never register the relay twice.
  if (window.__karafiltPartyBridgeLoaded) return;
  window.__karafiltPartyBridgeLoaded = true;

  const FROM_PAGE = "karafilt-party";
  const TO_PAGE = "karafilt-party-ext";
  const ALLOWED = new Set([
    "PARTY_PING",
    "PARTY_GET_STATUS",
    "PARTY_SET_MODE",
    "PARTY_SET_MIX",
  ]);

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== FROM_PAGE || !ALLOWED.has(msg.type)) return;
    const reqId = msg.reqId;
    try {
      chrome.runtime.sendMessage({ type: msg.type, value: msg.value }, (response) => {
        void chrome.runtime.lastError; // SW asleep / no handler → response undefined
        window.postMessage(
          { source: TO_PAGE, reqId, response: response ?? null },
          location.origin,
        );
      });
    } catch {
      // chrome.runtime is gone — this bridge belongs to a reloaded/removed
      // extension instance. Stay silent so a freshly injected live bridge
      // (or the page's own timeout) settles the request instead of this
      // instant null masquerading as "extension not installed".
    }
  });

  // Announce presence so the page can detect the extension immediately.
  window.postMessage({ source: TO_PAGE, type: "READY" }, location.origin);
})();
