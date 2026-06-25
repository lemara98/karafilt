// deriveVideoKey — normalize a tab URL to a stable per-song key. YouTube
// collapses to the video id (survives playlist/timestamp params); everything
// else uses host + path. Shared so the side panel (ratings, usage metadata) and
// the service worker (usage timing, which runs even with the panel closed) key
// songs identically. Exposed on globalThis: loaded via <script> in the side
// panel and via importScripts() in the service worker.
(function () {
  function deriveVideoKey(url) {
    if (!url) return null;
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, "");
      if (/(^|\.)youtube\.com$/.test(host)) {
        const v = u.searchParams.get("v");
        if (v) return "yt:" + v;
      }
      if (host === "youtu.be") {
        const id = u.pathname.slice(1).split("/")[0];
        if (id) return "yt:" + id;
      }
      return host + u.pathname.replace(/\/+$/, "");
    } catch {
      return null;
    }
  }
  globalThis.deriveVideoKey = deriveVideoKey;
})();
