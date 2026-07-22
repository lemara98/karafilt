// Karafilt — Spotify playback bridge (MAIN world, open.spotify.com only)
//
// Spotify's web player never attaches its <audio> element to the DOM, so the
// isolated-world content script can't find it. This script runs in the page's
// MAIN world at document_start — before Spotify's app code — and wraps
// document.createElement to capture the media element the moment Spotify
// creates it. It then relays playback state (currentTime / duration / paused)
// to the isolated world via window.postMessage, and accepts play/pause/seek
// control messages back. No page data beyond playback timing ever leaves the
// page; the lyrics themselves are fetched elsewhere.
//
// Protocol (all messages carry source === window):
//   MAIN → isolated : {type:"KFL_SPOTIFY_MEDIA_STATE", currentTime, duration, paused, ts}
//                     {type:"KFL_SPOTIFY_PONG", hooked:true, hasMedia}
//   isolated → MAIN : {type:"KFL_SPOTIFY_PING"}
//                     {type:"KFL_SPOTIFY_CONTROL", action:"play"|"pause"|"seekTo"|"seekRelative", seconds}
(function () {
  "use strict";
  if (window.__kflSpotifyBridge) return;
  window.__kflSpotifyBridge = true;

  const captured = new Set();
  let active = null; // the element that most recently produced playback events

  function postState(el) {
    if (!el) return;
    try {
      window.postMessage(
        {
          type: "KFL_SPOTIFY_MEDIA_STATE",
          currentTime: el.currentTime || 0,
          duration: isFinite(el.duration) ? el.duration : 0,
          paused: !!el.paused,
          ts: performance.now(),
        },
        window.location.origin
      );
    } catch (e) {
      /* never break the page */
    }
  }

  function markActive(el) {
    active = el;
    postState(el);
  }

  // timeupdate fires ~4 Hz while playing; the isolated side interpolates
  // between updates. play/pause/seeked keep the paused flag honest, and
  // "emptied"/"loadstart" fire when Spotify swaps the source (next song, ad),
  // resetting the clock immediately instead of a stale interpolation.
  const EVENTS = ["timeupdate", "play", "playing", "pause", "seeked", "durationchange", "loadstart", "emptied"];
  function register(el) {
    if (!el || captured.has(el)) return;
    captured.add(el);
    for (const ev of EVENTS) {
      el.addEventListener(ev, () => markActive(el), { passive: true });
    }
    if (!active) markActive(el);
  }

  // Spotify creates its media element via document.createElement; wrap it.
  // Also wrap the Audio constructor as a belt-and-braces second path.
  const origCreate = Document.prototype.createElement;
  Document.prototype.createElement = function (tagName, options) {
    const el = origCreate.call(this, tagName, options);
    try {
      const t = String(tagName).toLowerCase();
      if (t === "audio" || t === "video") register(el);
    } catch (e) {
      /* never break the page */
    }
    return el;
  };
  const OrigAudio = window.Audio;
  if (typeof OrigAudio === "function") {
    window.Audio = function (src) {
      const el = src === undefined ? new OrigAudio() : new OrigAudio(src);
      try {
        register(el);
      } catch (e) {
        /* never break the page */
      }
      return el;
    };
    window.Audio.prototype = OrigAudio.prototype;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || typeof event.data.type !== "string") return;
    if (event.data.type === "KFL_SPOTIFY_PING") {
      try {
        window.postMessage(
          { type: "KFL_SPOTIFY_PONG", hooked: true, hasMedia: captured.size > 0 },
          window.location.origin
        );
      } catch (e) { /* ignore */ }
      if (active) postState(active);
      return;
    }
    if (event.data.type === "KFL_SPOTIFY_CONTROL") {
      const el = active;
      if (!el) return;
      const { action, seconds } = event.data;
      try {
        if (action === "play") {
          const p = el.play();
          if (p && p.catch) p.catch(() => {});
        } else if (action === "pause") {
          el.pause();
        } else if (action === "seekTo" && isFinite(seconds)) {
          el.currentTime = Math.max(0, seconds);
        } else if (action === "seekRelative" && isFinite(seconds)) {
          el.currentTime = Math.max(0, (el.currentTime || 0) + seconds);
        }
      } catch (e) { /* seeking may be refused mid-load; harmless */ }
    }
  });
})();
