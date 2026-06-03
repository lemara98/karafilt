// Popup is now a thin wiring layer over shared/controls-bindings.js. All the
// karaoke filter logic (start/stop, mode, mix, AI model, settings, countdown,
// AI status, storage sync) lives in the shared module.

const $ = (id) => document.getElementById(id);

const toggleBtn = $("toggle");
const statusEl = $("status");

$("open-lyrics-panel").addEventListener("click", async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) await chrome.sidePanel.open({ tabId: tab.id });
    window.close();
  } catch (e) {
    console.error("Failed to open side panel:", e);
  }
});

window.bindKaraokeControls({
  toggleBtn,
  btnLabel: toggleBtn.querySelector(".btn-label"),
  playIcon: toggleBtn.querySelector(".play-icon"),
  stopIcon: toggleBtn.querySelector(".stop-icon"),
  statusEl,
  statusText: statusEl.querySelector(".status-text"),
  modeSelect: $("mode"),
  modeHint: $("mode-hint"),
  mixSlider: $("mix"),
  mixValue: $("mix-value"),
  aiOptions: $("ai-options"),
  aiModelSelect: $("ai-model"),
  modelHint: $("model-hint"),
  aiStatusEl: $("ai-status"),
  aiStatusText: $("ai-status").querySelector(".ai-status-text"),
  settingsToggle: $("settings-toggle"),
  settingsPanel: $("settings-panel"),
  serverUrlInput: $("server-url"),
  apiKeyInput: $("api-key"),
  websiteUrlInput: $("website-url"),
  countdownOverlay: $("countdown-overlay"),
  countdownNumber: $("countdown-number"),
  countdownCancelBtn: $("countdown-cancel"),
});
