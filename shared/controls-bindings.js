// Shared wiring for the karaoke filter UI. sidepanel/sidepanel.html includes
// this script and calls bindKaraokeControls(els) with its DOM element
// references. Settings changes persist via chrome.storage so surfaces stay
// coherent across reopens.
//
// Karafilt requires a signed-in account: an auth gate covers the whole surface
// until the GET_ACCOUNT_STATUS probe reports the user is signed in on the site.

(function () {
  const MODE_HINTS = {
    basic: "Fast center-channel cancellation",
    stft: "Frequency-selective, preserves bass & stereo",
    stft_deep: "Aggressive — also removes center backing vocals (thinner mix)",
  };

  const DEFAULTS = {
    mode: "stft",
    mix: 100,
    websiteUrl: "https://karafilt.com",
  };

  // Detect which fields a caller actually rendered. Some surfaces may omit
  // inputs; the binder must handle missing elements gracefully.
  function has(els, key) {
    return els && els[key] != null;
  }

  window.bindKaraokeControls = function bindKaraokeControls(els) {
    let isActive = false;
    let signedIn = false;
    // Surfaces pinned to a specific tab (the side panel) supply els.getTabId
    // so Start/Stop always target that tab. Without it, fall back to tracking
    // the active tab (legacy popup behaviour).
    const getFixedTabId = typeof els.getTabId === "function" ? els.getTabId : null;
    // Cached active tab id, refreshed on tab activation. Having this
    // synchronously available lets the click handler call
    // chrome.tabCapture.getMediaStreamId without any preceding await — Chrome
    // requires both an unbroken user gesture AND an explicit targetTabId.
    let cachedTabId = null;
    async function refreshTabId() {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        cachedTabId = (tab && tab.id) || null;
      } catch {
        cachedTabId = null;
      }
    }
    if (!getFixedTabId) {
      refreshTabId();
      chrome.tabs.onActivated.addListener(refreshTabId);
      chrome.tabs.onUpdated.addListener((_id, info) => {
        if (info.status === "complete") refreshTabId();
      });
    }

    // ── Auth gate ─────────────────────────────────────────────────────────
    // Covers the surface until signed in. The "Sign in" button opens the
    // website login in a popup window via the service worker, which returns the
    // user here and broadcasts ACCOUNT_CHANGED on success.
    let loginUrl = "https://karafilt.com/login";

    function applyGate() {
      if (has(els, "authGate")) {
        els.authGate.style.display = signedIn ? "none" : "";
      }
      if (has(els, "toggleBtn")) {
        els.toggleBtn.disabled = !signedIn;
      }
    }

    function refreshAuthGate() {
      chrome.runtime.sendMessage({ type: "GET_ACCOUNT_STATUS" }, (acc) => {
        if (chrome.runtime.lastError) return;
        // `disabled` (no Website URL configured) shouldn't happen with the
        // default site, but if it does, don't lock the user out.
        signedIn = !acc || acc.disabled ? true : !!acc.signedIn;
        if (acc && acc.loginUrl) loginUrl = acc.loginUrl;
        applyGate();
      });
    }

    if (has(els, "authGateSignIn")) {
      els.authGateSignIn.addEventListener("click", () => {
        chrome.runtime.sendMessage({
          type: "OPEN_LOGIN",
          loginUrl,
          returnTabId: getFixedTabId ? getFixedTabId() : cachedTabId,
        });
      });
    }

    // ── UI helpers ────────────────────────────────────────────────────────
    function setActiveUI(active) {
      isActive = active;
      if (active) {
        if (els.btnLabel) els.btnLabel.textContent = "Stop Filtering";
        if (els.playIcon) els.playIcon.style.display = "none";
        if (els.stopIcon) els.stopIcon.style.display = "";
        if (els.toggleBtn) els.toggleBtn.classList.add("active");
        if (els.statusText) els.statusText.textContent = "Filtering";
        if (els.statusEl) els.statusEl.classList.add("active");
      } else {
        if (els.btnLabel) els.btnLabel.textContent = "Start Filtering";
        if (els.playIcon) els.playIcon.style.display = "";
        if (els.stopIcon) els.stopIcon.style.display = "none";
        if (els.toggleBtn) els.toggleBtn.classList.remove("active");
        if (els.statusText) els.statusText.textContent = "Ready";
        if (els.statusEl) els.statusEl.classList.remove("active");
      }
    }

    // Countdown UI removed — keep the overlay hidden in case stale CSS shows it.
    if (has(els, "countdownOverlay")) els.countdownOverlay.style.display = "none";

    // ── Wire event handlers ───────────────────────────────────────────────
    if (has(els, "toggleBtn")) {
      els.toggleBtn.addEventListener("click", async () => {
        if (!signedIn) { applyGate(); return; }
        if (!isActive) {
          let tabId = getFixedTabId ? getFixedTabId() : cachedTabId;
          if (tabId == null) {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            tabId = tab && tab.id != null ? tab.id : null;
          }
          if (tabId == null) {
            if (els.statusText) els.statusText.textContent = "No active tab";
            return;
          }

          if (els.statusText) els.statusText.textContent = "Starting...";

          // Let the SERVICE WORKER acquire the stream id (no streamId sent). The
          // SW holds the extension's activeTab grant from the action that opened
          // the side panel, so it captures the CURRENT tab directly — no
          // screen-share picker. If the grant is missing, the SW returns an
          // error and we point at the no-picker paths.
          const response = await chrome.runtime.sendMessage({
            type: "START_CAPTURE",
            tabId,
            mode: els.modeSelect ? els.modeSelect.value : DEFAULTS.mode,
          });

          if (response && response.success) {
            setActiveUI(true);
          } else if (els.statusText) {
            els.statusText.textContent =
              "Couldn't start — press Ctrl+Shift+K, or right-click the page → Filter this tab";
          }
        } else {
          chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
          setActiveUI(false);
        }
      });
    }

    if (has(els, "modeSelect")) {
      els.modeSelect.addEventListener("change", () => {
        const mode = els.modeSelect.value;
        if (els.modeHint) els.modeHint.textContent = MODE_HINTS[mode] || "";
        chrome.storage.local.set({ mode });
        chrome.runtime.sendMessage({ type: "SET_MODE", value: mode });
      });
    }

    if (has(els, "mixSlider")) {
      els.mixSlider.addEventListener("input", () => {
        const value = els.mixSlider.value / 100;
        if (els.mixValue) els.mixValue.textContent = els.mixSlider.value + "%";
        chrome.storage.local.set({ mix: parseInt(els.mixSlider.value, 10) });
        chrome.runtime.sendMessage({ type: "SET_MIX", value });
      });
    }

    if (has(els, "settingsToggle") && has(els, "settingsPanel")) {
      els.settingsToggle.addEventListener("click", () => {
        const isOpen = els.settingsPanel.style.display !== "none";
        els.settingsPanel.style.display = isOpen ? "none" : "";
        els.settingsToggle.classList.toggle("open", !isOpen);
      });
    }

    // Account site URL. The service worker reads this from storage to probe the
    // signed-in session (/api/me) and to open the login page. Defaults to
    // karafilt.com; only self-hosters of the site need to change it.
    if (has(els, "websiteUrlInput")) {
      els.websiteUrlInput.addEventListener("change", () => {
        chrome.storage.local.set({ websiteUrl: els.websiteUrlInput.value.trim() });
      });
    }

    // ── Initial state from storage + active capture state ─────────────────
    chrome.storage.local.get(DEFAULTS, (settings) => {
      if (els.modeSelect) els.modeSelect.value = settings.mode;
      if (els.mixSlider) els.mixSlider.value = settings.mix;
      if (els.mixValue) els.mixValue.textContent = settings.mix + "%";
      if (els.websiteUrlInput) els.websiteUrlInput.value = settings.websiteUrl;
      if (els.modeHint) els.modeHint.textContent = MODE_HINTS[settings.mode] || "";

      chrome.runtime.sendMessage({ type: "GET_STATE" }, (response) => {
        if (response && response.isActive) {
          setActiveUI(true);
        }
      });
    });

    refreshAuthGate();
    // The user may sign in/out on karafilt.com while this surface is open.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") refreshAuthGate();
    });

    // ── Cross-surface state coherence ─────────────────────────────────────
    // When the popup AND side panel are both visible, a setting changed in
    // one surface should reflect in the other. chrome.storage.onChanged fires
    // in every extension page when local storage mutates.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.mode && els.modeSelect && document.activeElement !== els.modeSelect) {
        els.modeSelect.value = changes.mode.newValue;
        if (els.modeHint) els.modeHint.textContent = MODE_HINTS[changes.mode.newValue] || "";
      }
      if (changes.mix && els.mixSlider && document.activeElement !== els.mixSlider) {
        els.mixSlider.value = changes.mix.newValue;
        if (els.mixValue) els.mixValue.textContent = changes.mix.newValue + "%";
      }
      if (changes.websiteUrl && els.websiteUrlInput && document.activeElement !== els.websiteUrlInput) {
        els.websiteUrlInput.value = changes.websiteUrl.newValue;
        refreshAuthGate();
      }
    });

    // ── Capture-state + account broadcasts from the service worker ────────
    chrome.runtime.onMessage.addListener((message, sender) => {
      if (sender && sender.tab) return;
      if (message.type === "CAPTURE_STATE") {
        // Broadcast from the SW so popup + side panel agree on Start/Stop
        // even when the OTHER surface initiated the change.
        setActiveUI(!!message.isActive);
      } else if (message.type === "ACCOUNT_CHANGED") {
        refreshAuthGate();
      }
    });

    return { setActiveUI };
  };
})();
