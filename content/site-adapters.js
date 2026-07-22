// Karafilt — per-site adapters (isolated world)
//
// Some players can't be driven by the generic pipeline in lyrics-overlay.js
// (document.title parsing + DOM <video>/<audio> discovery). An adapter fills
// those gaps for a specific host; everything else keeps the generic path.
// Loaded via manifest content_scripts AFTER shared/song-match.js and BEFORE
// content/lyrics-overlay.js. Pure helpers are exported for the Node test
// harness (test/site-adapters.test.mjs); DOM-touching code never runs there.
//
// Spotify (open.spotify.com):
//  - the <audio> element is never attached to the DOM. Playback state comes
//    from content/spotify-bridge.js (MAIN world, hooks createElement) via
//    window.postMessage, exposed here as a "virtual media element" so the
//    overlay's time/seek/play logic works unchanged. If the bridge missed the
//    element (extension loaded after Spotify booted), fall back to reading
//    the progress-bar text at 1 Hz and interpolating.
//  - the tab URL doesn't change per song; identity comes from the now-playing
//    widget's /track/<id> link → videoKey "sp:<id>" (mirrors "yt:<id>").
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.KarafiltSiteAdapter = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // ── Pure helpers (Node-testable) ─────────────────────────────────────────
  function trackIdFromHref(href) {
    if (!href) return null;
    const m = String(href).match(/\/track\/([0-9A-Za-z]{22})(?:[/?#]|$)/);
    return m ? m[1] : null;
  }

  // "3:45" → 225, "1:02:03" → 3723, "-1:30" → -90 (sign preserved: Spotify can
  // display remaining time), anything else → null.
  function parseTimeText(text) {
    if (text == null) return null;
    const m = String(text).trim().match(/^(-?)(\d+):(\d{2})(?::(\d{2}))?$/);
    if (!m) return null;
    const sign = m[1] === "-" ? -1 : 1;
    const secs =
      m[4] !== undefined
        ? Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4])
        : Number(m[2]) * 60 + Number(m[3]);
    return sign * secs;
  }

  // Interpolated playhead: last known position plus wall-clock elapsed since
  // it was sampled (frozen while paused). Keeps the 200ms publish tick smooth
  // between ~4Hz bridge updates / 1Hz progress-bar ticks.
  function interpolate(lastTime, lastTs, paused, now) {
    if (!isFinite(lastTime)) return 0;
    if (paused) return lastTime;
    return lastTime + Math.max(0, (now - lastTs) / 1000);
  }

  // ── Spotify adapter ──────────────────────────────────────────────────────
  // All Spotify-internal selectors in one place — when Spotify's markup
  // drifts, this block is the only thing to fix. Every consumer degrades
  // gracefully (null hint → title parsing; no time source → status hint).
  const SPOTIFY_SEL = {
    widget: '[data-testid="now-playing-widget"]',
    trackLink: '[data-testid="context-item-link"]',
    artistLink: '[data-testid="context-item-info-artist"]',
    position: '[data-testid="playback-position"]',
    duration: '[data-testid="playback-duration"]',
    playPause: '[data-testid="control-button-playpause"]',
  };
  const BRIDGE_PING_MS = 500;
  const BRIDGE_PING_TRIES = 10; // ~5s before falling back to DOM polling
  const DOM_POLL_MS = 1000;
  const DOM_PAUSE_STALL_MS = 1600; // position text unchanged this long ⇒ paused

  function createSpotifyAdapter() {
    // Last known playback state; ts is performance.now() at sampling.
    let last = { time: 0, duration: 0, paused: true, ts: 0 };
    let haveState = false;
    let bridgeMode = false;
    let initDone = false;
    let statusHint = "";

    let domPollId = null;
    let domLastPosText = null;
    let domLastPosChangeTs = 0;

    function onBridgeState(d) {
      if (!bridgeMode) {
        bridgeMode = true;
        stopDomPolling(); // real media events beat 1Hz text scraping
      }
      last = {
        time: Number(d.currentTime) || 0,
        duration: isFinite(d.duration) && d.duration > 0 ? d.duration : last.duration,
        paused: !!d.paused,
        ts: performance.now(),
      };
      haveState = true;
      statusHint = "";
    }

    function domPoll() {
      const posEl = document.querySelector(SPOTIFY_SEL.position);
      if (!posEl) return;
      const posText = (posEl.textContent || "").trim();
      const pos = parseTimeText(posText);
      if (pos == null || pos < 0) return;
      const now = performance.now();
      if (posText !== domLastPosText) {
        domLastPosText = posText;
        domLastPosChangeTs = now;
        let duration = last.duration;
        const durEl = document.querySelector(SPOTIFY_SEL.duration);
        const durRaw = durEl ? parseTimeText(durEl.textContent) : null;
        // A leading "-" means Spotify is showing time REMAINING.
        if (durRaw != null) duration = durRaw < 0 ? pos - durRaw : durRaw;
        last = { time: pos, duration, paused: false, ts: now };
        haveState = true;
        statusHint = "";
      } else if (!last.paused && now - domLastPosChangeTs > DOM_PAUSE_STALL_MS) {
        last = { time: pos, duration: last.duration, paused: true, ts: now };
      }
    }

    function startDomPolling() {
      if (domPollId != null || bridgeMode) return;
      domPollId = setInterval(domPoll, DOM_POLL_MS);
      domPoll();
      // Bridge unreachable AND no readable progress bar → tell the user the
      // one thing that fixes it (a reload lets the bridge hook in first).
      setTimeout(() => {
        if (!haveState && document.querySelector(SPOTIFY_SEL.widget)) {
          statusHint = "Reload the Spotify tab to enable lyrics sync";
        }
      }, 3000);
    }

    function stopDomPolling() {
      if (domPollId != null) {
        clearInterval(domPollId);
        domPollId = null;
      }
    }

    function control(action, seconds) {
      if (bridgeMode) {
        try {
          window.postMessage({ type: "KFL_SPOTIFY_CONTROL", action, seconds }, window.location.origin);
        } catch (e) { /* ignore */ }
        return;
      }
      // DOM fallback: only play/pause are possible (one toggle button), and
      // only when it would actually change state. Seeking is unsupported.
      if (action === "play" || action === "pause") {
        const wantPlay = action === "play";
        if (wantPlay !== last.paused) return;
        const btn = document.querySelector(SPOTIFY_SEL.playPause);
        if (btn) btn.click();
      }
    }

    // Quacks enough like an HTMLMediaElement for the overlay's time/seek/
    // play logic (currentTime/duration/paused/play/pause) to work unchanged.
    const virtualMedia = {
      isVirtual: true,
      get currentTime() {
        return interpolate(last.time, last.ts, last.paused, performance.now());
      },
      set currentTime(v) {
        if (!isFinite(v)) return;
        control("seekTo", Math.max(0, v));
        last = { time: Math.max(0, v), duration: last.duration, paused: last.paused, ts: performance.now() };
      },
      get duration() {
        return last.duration > 0 ? last.duration : NaN;
      },
      get paused() {
        return last.paused;
      },
      play() {
        control("play");
        return Promise.resolve();
      },
      pause() {
        control("pause");
      },
    };

    function getWidget() {
      return document.querySelector(SPOTIFY_SEL.widget);
    }

    return {
      init() {
        if (initDone) return;
        initDone = true;
        window.addEventListener("message", (event) => {
          if (event.source !== window || !event.data) return;
          if (event.data.type === "KFL_SPOTIFY_MEDIA_STATE") onBridgeState(event.data);
        });
        // Ping the MAIN-world bridge; PONG alone isn't proof of a captured
        // element (the hook may have installed after Spotify created its
        // audio), so only MEDIA_STATE counts. No state after ~5s → DOM mode.
        let pings = 0;
        const pingId = setInterval(() => {
          if (bridgeMode || ++pings > BRIDGE_PING_TRIES) {
            clearInterval(pingId);
            if (!bridgeMode) startDomPolling();
            return;
          }
          try {
            window.postMessage({ type: "KFL_SPOTIFY_PING" }, window.location.origin);
          } catch (e) { /* ignore */ }
        }, BRIDGE_PING_MS);
      },

      // Exact {metaTrack, metaArtist} from the now-playing bar — feeds
      // SM.parseTitle as its trusted hint, so candidate #0 is exact and the
      // tab-title format stops mattering. null → caller parses the title.
      getSongHint() {
        const widget = getWidget();
        if (!widget) return null;
        const trackEl = widget.querySelector(SPOTIFY_SEL.trackLink);
        const track = trackEl ? (trackEl.textContent || "").trim() : "";
        if (!track) return null;
        const artists = Array.from(widget.querySelectorAll(SPOTIFY_SEL.artistLink))
          .map((a) => (a.textContent || "").trim())
          .filter(Boolean);
        return {
          metaTrack: track,
          metaArtist: artists.join(", "),
          author: artists[0] || "",
        };
      },

      // The PLAYING track's id from the widget link (the tab URL reflects
      // what's being browsed, not played). Podcasts/episodes → null.
      getTrackId() {
        const widget = getWidget();
        if (!widget) return null;
        const trackEl = widget.querySelector(SPOTIFY_SEL.trackLink);
        return trackEl ? trackIdFromHref(trackEl.getAttribute("href")) : null;
      },

      getVideoKey() {
        const id = this.getTrackId();
        return id ? "sp:" + id : null;
      },

      // Composite so a title tick without a widget update (or vice versa)
      // still moves the key exactly once per real song change.
      getSongKey() {
        const id = this.getTrackId();
        if (!id) return null;
        const SM = (typeof globalThis !== "undefined" && globalThis.KarafiltSongMatch) || null;
        const title = SM ? SM.cleanTitle(document.title) : document.title;
        return "sp:" + id + "|" + title;
      },

      // Nothing playing (or a podcast) → don't fire lyric lookups.
      shouldFetch() {
        return !!this.getTrackId();
      },

      getVirtualMedia() {
        return haveState ? virtualMedia : null;
      },

      getStatusHint() {
        return statusHint;
      },

      // Song changes surface as mutations inside the now-playing widget
      // (Spotify renders it late, so observe body until it appears). The
      // <title> observer in lyrics-overlay.js stays as an independent signal.
      watchSongChanges(cb) {
        const attach = () => {
          const widget = getWidget();
          if (!widget) return false;
          const obs = new MutationObserver(cb);
          obs.observe(widget, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ["href"],
          });
          return true;
        };
        if (attach()) return;
        const bodyObs = new MutationObserver(() => {
          if (attach()) {
            bodyObs.disconnect();
            cb();
          }
        });
        bodyObs.observe(document.body || document.documentElement, {
          childList: true,
          subtree: true,
        });
      },
    };
  }

  function forHost(hostname) {
    if (hostname === "open.spotify.com") return createSpotifyAdapter();
    return null; // YouTube and everything else: generic pipeline
  }

  return { forHost, trackIdFromHref, parseTimeText, interpolate };
});
