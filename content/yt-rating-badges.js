// yt-rating-badges.js — overlay Karafilt's community filter-rating on YouTube
// video thumbnails, so users see how well vocal removal works on a song BEFORE
// opening it. Read-only DOM overlay: it scans thumbnail links, batches the video
// keys to the service worker (which fetches public aggregate stats), and paints a
// small "★ 4.2" badge on rated videos. No network from the page itself.
//
// Opt out by setting localStorage.kflNoBadges = "1".
(() => {
  "use strict";

  // Only run in the top frame and only when not opted out.
  if (window.top !== window) return;
  let DEBUG = false;
  try {
    if (localStorage.getItem("kflNoBadges") === "1") return;
    DEBUG = localStorage.getItem("kflBadgeDebug") === "1";
  } catch {
    /* localStorage may be blocked; proceed */
  }
  const log = (...a) => {
    if (DEBUG) console.log("[KFL-badges]", ...a);
  };
  log("content script loaded on", location.href);

  // key -> { avg, count }. Includes negatives ({count:0}) so unrated videos
  // aren't refetched. Lives for the page session.
  const cache = new Map();
  const pending = new Set(); // keys currently in flight
  let scanScheduled = false;

  function videoIdFromHref(href) {
    if (!href) return null;
    try {
      const u = new URL(href, location.origin);
      if (u.hostname === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
      if (u.pathname === "/watch") return u.searchParams.get("v");
      const m = u.pathname.match(/^\/shorts\/([^/?#]+)/);
      if (m) return m[1];
    } catch {
      /* malformed href */
    }
    return null;
  }

  function thumbnailAnchors() {
    return document.querySelectorAll(
      'a#thumbnail[href], a.ytd-thumbnail[href], a[href^="/shorts/"]',
    );
  }

  function applyBadge(anchor, key) {
    // DOM nodes get recycled on scroll — if this anchor now points elsewhere,
    // drop the stale badge first.
    if (anchor.dataset.kflKey && anchor.dataset.kflKey !== key) {
      const old = anchor.querySelector(":scope > .kfl-rating-badge");
      if (old) old.remove();
      delete anchor.dataset.kflKey;
    }
    const stat = cache.get(key);
    if (!stat || stat.count < 1) return;
    if (
      anchor.dataset.kflKey === key &&
      anchor.querySelector(":scope > .kfl-rating-badge")
    ) {
      return; // already badged with the right value
    }
    if (getComputedStyle(anchor).position === "static") {
      anchor.style.position = "relative";
    }
    const badge = document.createElement("div");
    badge.className = "kfl-rating-badge";
    badge.textContent = "★ " + stat.avg.toFixed(1);
    badge.title =
      "Karafilt — vocal removal rated " +
      stat.avg.toFixed(1) +
      "/5 by " +
      stat.count +
      (stat.count === 1 ? " user" : " users");
    anchor.appendChild(badge);
    anchor.dataset.kflKey = key;
  }

  function fetchStats(keys) {
    // Chunk to the API's 100-key cap.
    for (let i = 0; i < keys.length; i += 100) {
      const chunk = keys.slice(i, i + 100);
      chunk.forEach((k) => pending.add(k));
      chrome.runtime.sendMessage(
        { type: "GET_FILTER_RATING_STATS", keys: chunk },
        (res) => {
          chunk.forEach((k) => pending.delete(k));
          if (chrome.runtime.lastError || !res || !res.ok) {
            // Leave keys uncached so a later scan can retry.
            return;
          }
          const stats = res.stats || {};
          for (const k of chunk) {
            cache.set(k, stats[k] || { avg: 0, count: 0 });
          }
          log(
            "fetched",
            chunk.length,
            "keys →",
            Object.keys(stats).length,
            "rated:",
            stats,
          );
          paintAll();
        },
      );
    }
  }

  // Paint every currently-visible thumbnail from cache (no fetching).
  function paintAll() {
    for (const a of thumbnailAnchors()) {
      const id = videoIdFromHref(a.getAttribute("href"));
      if (!id) continue;
      applyBadge(a, "yt:" + id);
    }
  }

  function scan() {
    scanScheduled = false;
    const toFetch = [];
    for (const a of thumbnailAnchors()) {
      const id = videoIdFromHref(a.getAttribute("href"));
      if (!id) continue;
      const key = "yt:" + id;
      if (cache.has(key)) {
        applyBadge(a, key);
      } else if (!pending.has(key) && !toFetch.includes(key)) {
        toFetch.push(key);
      }
    }
    log("scan: anchors with new keys to fetch =", toFetch.length);
    if (toFetch.length) fetchStats(toFetch);
  }

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    setTimeout(scan, 350); // debounce bursts of DOM mutations
  }

  // React to lazy-loaded thumbnails and infinite scroll.
  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // YouTube is a SPA — re-scan after in-app navigation.
  window.addEventListener("yt-navigate-finish", scheduleScan);

  scheduleScan();
})();
