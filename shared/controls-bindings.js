// Shared wiring for the karaoke filter UI. Both popup/popup.html and
// sidepanel/sidepanel.html include this script and call bindKaraokeControls(els)
// with their own DOM element references. Any setting changed in one surface
// flows to the other via chrome.storage.onChanged so they stay coherent.

(function () {
  const MODE_HINTS = {
    basic: "Fast center-channel cancellation",
    stft: "Frequency-selective, preserves bass & stereo",
    ai: "Neural network separation — requires server",
    ai2: "Two-pass AI, removes backing vocals too",
  };

  const AI_STATUS_LABELS = {
    idle: null,
    connecting: "Connecting to server...",
    recording: "STFT Preview — recording audio...",
    processing: "Sending audio to AI...",
    buffering: "Buffering AI output...",
    ai_active: "AI Active",
    stft_preview: "STFT Preview — waiting for AI...",
    fallback: "STFT Fallback — server disconnected",
    error: "Connection error",
    no_server: "No AI server configured — set one in Settings",
  };

  const DEFAULTS = {
    mode: "stft",
    mix: 100,
    aiModel: "htdemucs",
    serverUrl: "",
    apiKey: "",
    websiteUrl: "https://karafilt.com",
  };

  function isAIMode(mode) {
    return mode === "ai" || mode === "ai2";
  }

  // Detect which fields a caller actually rendered. Some surfaces (e.g. a
  // future minimal popup) may omit settings inputs; the binder must handle
  // missing elements gracefully.
  function has(els, key) {
    return els && els[key] != null;
  }

  window.bindKaraokeControls = function bindKaraokeControls(els) {
    let isActive = false;
    // Cached active tab id, refreshed on tab activation. Having this
    // synchronously available lets the click handler call
    // chrome.tabCapture.getMediaStreamId without any preceding await — Chrome
    // requires both an unbroken user gesture AND an explicit targetTabId,
    // so we can't get the id via tabs.query inside the handler (that await
    // breaks the gesture chain).
    let cachedTabId = null;
    async function refreshTabId() {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        cachedTabId = (tab && tab.id) || null;
      } catch {
        cachedTabId = null;
      }
    }
    refreshTabId();
    chrome.tabs.onActivated.addListener(refreshTabId);
    chrome.tabs.onUpdated.addListener((_id, info) => {
      if (info.status === "complete") refreshTabId();
    });

    // ── UI helpers ────────────────────────────────────────────────────────
    function updateAIStatus(status, detail) {
      if (!has(els, "aiStatusEl")) return;
      // "gated" carries its own message from the service worker (sign in /
      // verify email / subscribe / trial ended) rather than a fixed label.
      const label = status === "gated" ? detail : AI_STATUS_LABELS[status];
      if (!label) {
        els.aiStatusEl.style.display = "none";
        return;
      }
      els.aiStatusEl.style.display = "";
      els.aiStatusEl.className = "ai-status " + status;
      if (status === "buffering" && detail) {
        els.aiStatusText.textContent = `Buffering AI output (${detail.received}/${detail.needed})...`;
      } else if (status === "processing" && detail) {
        els.aiStatusText.textContent = `Sending audio to AI (chunk ${detail.sent})...`;
      } else {
        els.aiStatusText.textContent = label;
      }
    }

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

    function updateAIOptionsVisibility() {
      if (!has(els, "aiOptions") || !has(els, "modeSelect")) return;
      els.aiOptions.style.display = isAIMode(els.modeSelect.value) ? "" : "none";
    }

    function loadAvailableModels(restoreModel) {
      if (!has(els, "aiModelSelect")) return;
      chrome.runtime.sendMessage({ type: "GET_AI_MODELS" }, (response) => {
        if (!response || !response.success) {
          if (els.modelHint) els.modelHint.textContent = "Server not reachable — check settings";
          return;
        }
        const models = response.models;
        const currentVal = restoreModel || els.aiModelSelect.value;
        els.aiModelSelect.innerHTML = "";

        const demucsModels = [];
        const separatorModels = [];
        for (const [key, info] of Object.entries(models)) {
          if (info.backend === "demucs") demucsModels.push({ key, label: info.label });
          else separatorModels.push({ key, label: info.label });
        }

        function appendGroup(label, items) {
          if (items.length === 0) return;
          const group = document.createElement("optgroup");
          group.label = label;
          for (const m of items) {
            const opt = document.createElement("option");
            opt.value = m.key;
            opt.textContent = m.label;
            group.appendChild(opt);
          }
          els.aiModelSelect.appendChild(group);
        }
        appendGroup("Demucs", demucsModels);
        appendGroup("Audio Separator", separatorModels);

        if (currentVal && els.aiModelSelect.querySelector(`option[value="${currentVal}"]`)) {
          els.aiModelSelect.value = currentVal;
        }
        const total = demucsModels.length + separatorModels.length;
        if (els.modelHint) {
          els.modelHint.textContent = `${total} model${total !== 1 ? "s" : ""} available`;
        }
      });
    }

    // Countdown UI removed — keep the overlay hidden in case stale CSS shows it.
    if (has(els, "countdownOverlay")) els.countdownOverlay.style.display = "none";

    // ── Wire event handlers ───────────────────────────────────────────────
    if (has(els, "toggleBtn")) {
      els.toggleBtn.addEventListener("click", async () => {
        if (!isActive) {
          let tabId = cachedTabId;
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
          // screen-share picker. (Restores the pre-ec1e570 behaviour.) If the
          // grant is missing, the SW returns an error and we point at the
          // no-picker paths (keyboard shortcut / right-click menu).
          const response = await chrome.runtime.sendMessage({
            type: "START_CAPTURE",
            tabId,
            mode: els.modeSelect ? els.modeSelect.value : DEFAULTS.mode,
            aiModel: (els.modeSelect && isAIMode(els.modeSelect.value) && els.aiModelSelect)
              ? els.aiModelSelect.value
              : undefined,
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
        updateAIOptionsVisibility();
        chrome.storage.local.set({ mode });
        chrome.runtime.sendMessage({ type: "SET_MODE", value: mode });
        if (isAIMode(mode) && els.aiModelSelect) {
          chrome.runtime.sendMessage({ type: "SET_AI_MODEL", value: els.aiModelSelect.value });
        }
      });
    }

    if (has(els, "aiModelSelect")) {
      els.aiModelSelect.addEventListener("change", () => {
        const aiModel = els.aiModelSelect.value;
        chrome.storage.local.set({ aiModel });
        chrome.runtime.sendMessage({ type: "SET_AI_MODEL", value: aiModel });
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

    if (has(els, "serverUrlInput")) {
      els.serverUrlInput.addEventListener("change", () => {
        const url = els.serverUrlInput.value.trim();
        chrome.storage.local.set({ serverUrl: url });
        chrome.runtime.sendMessage({ type: "SET_SERVER_URL", value: url });
      });
    }

    if (has(els, "apiKeyInput")) {
      els.apiKeyInput.addEventListener("change", () => {
        const key = els.apiKeyInput.value.trim();
        chrome.storage.local.set({ apiKey: key });
        chrome.runtime.sendMessage({ type: "SET_API_KEY", value: key });
      });
    }

    // Website URL (Pro account). The service worker reads this from storage when
    // an AI mode is started, to fetch a filter token. Empty = local-only / no Pro.
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
      if (els.serverUrlInput) els.serverUrlInput.value = settings.serverUrl;
      if (els.apiKeyInput) els.apiKeyInput.value = settings.apiKey;
      if (els.websiteUrlInput) els.websiteUrlInput.value = settings.websiteUrl;
      if (els.modeHint) els.modeHint.textContent = MODE_HINTS[settings.mode] || "";
      updateAIOptionsVisibility();

      loadAvailableModels(settings.aiModel);

      chrome.runtime.sendMessage({ type: "GET_STATE" }, (response) => {
        if (response && response.isActive) {
          setActiveUI(true);
          if (response.aiStatus) {
            updateAIStatus(response.aiStatus.status, response.aiStatus.detail);
          }
        }
      });
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
        updateAIOptionsVisibility();
      }
      if (changes.mix && els.mixSlider && document.activeElement !== els.mixSlider) {
        els.mixSlider.value = changes.mix.newValue;
        if (els.mixValue) els.mixValue.textContent = changes.mix.newValue + "%";
      }
      if (changes.aiModel && els.aiModelSelect && document.activeElement !== els.aiModelSelect) {
        if (els.aiModelSelect.querySelector(`option[value="${changes.aiModel.newValue}"]`)) {
          els.aiModelSelect.value = changes.aiModel.newValue;
        }
      }
      if (changes.serverUrl && els.serverUrlInput && document.activeElement !== els.serverUrlInput) {
        els.serverUrlInput.value = changes.serverUrl.newValue;
      }
      if (changes.apiKey && els.apiKeyInput && document.activeElement !== els.apiKeyInput) {
        els.apiKeyInput.value = changes.apiKey.newValue;
      }
      if (changes.websiteUrl && els.websiteUrlInput && document.activeElement !== els.websiteUrlInput) {
        els.websiteUrlInput.value = changes.websiteUrl.newValue;
      }
    });

    // ── AI status + capture-state broadcast listener ──────────────────────
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === "AI_STATUS") {
        updateAIStatus(message.status, message.detail);
      } else if (message.type === "CAPTURE_STATE") {
        // Broadcast from the SW so popup + side panel agree on Start/Stop
        // even when the OTHER surface initiated the change.
        setActiveUI(!!message.isActive);
      } else if (message.type === "AI_LAG") {
        // AI playback-lag (seconds) from the offscreen doc, re-broadcast by the
        // SW. The side panel uses it to shift the lyric highlight; the popup
        // simply never defines the hook.
        if (typeof window.onAILagUpdate === "function") {
          window.onAILagUpdate(message.lagSeconds);
        }
      }
    });

    return { setActiveUI, updateAIStatus };
  };
})();
