// deriveVideoKey — normalize a tab URL to a stable per-song key. YouTube
// collapses to the video id (survives playlist/timestamp params), Spotify
// track pages to the track id; everything else uses host + path. Shared so
// the side panel (ratings, usage metadata) and the service worker (usage
// timing, which runs even with the panel closed) key songs identically.
// NOTE: on open.spotify.com the tab URL usually reflects what's being
// BROWSED, not what's PLAYING — the per-song "sp:<id>" key for the playing
// track comes from the site adapter (content/site-adapters.js), which reads
// the now-playing widget. This URL branch only covers direct /track/ pages.
// Exposed on globalThis: loaded via <script> in the side panel and via
// importScripts() in the service worker.
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
      if (host === "open.spotify.com") {
        const m = u.pathname.match(/\/track\/([0-9A-Za-z]{22})(?:[/?]|$)/);
        if (m) return "sp:" + m[1];
      }
      return host + u.pathname.replace(/\/+$/, "");
    } catch {
      return null;
    }
  }
  globalThis.deriveVideoKey = deriveVideoKey;
})();
