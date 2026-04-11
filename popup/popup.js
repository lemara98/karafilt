const toggleBtn = document.getElementById("toggle");
const btnLabel = toggleBtn.querySelector(".btn-label");
const playIcon = toggleBtn.querySelector(".play-icon");
const stopIcon = toggleBtn.querySelector(".stop-icon");
const mixSlider = document.getElementById("mix");
const mixValue = document.getElementById("mix-value");
const modeSelect = document.getElementById("mode");
const statusEl = document.getElementById("status");
const statusDot = statusEl.querySelector(".status-dot");
const statusText = statusEl.querySelector(".status-text");
const modeHint = document.getElementById("mode-hint");
const aiOptions = document.getElementById("ai-options");
const aiModelSelect = document.getElementById("ai-model");
const modelHint = document.getElementById("model-hint");

let isActive = false;

// Sync state with service worker on popup open
chrome.runtime.sendMessage({ type: "GET_STATE" }, (response) => {
  if (response && response.isActive) {
    isActive = true;
    setActiveUI(true);
  }
});

const MODE_HINTS = {
  basic: "Fast center-channel cancellation",
  stft: "Frequency-selective, preserves bass & stereo",
  ai: "Neural network separation — requires local server",
  ai2: "Two-pass AI, removes backing vocals too",
};

function isAIMode(mode) {
  return mode === "ai" || mode === "ai2";
}

function setActiveUI(active) {
  if (active) {
    btnLabel.textContent = "Stop Filtering";
    playIcon.style.display = "none";
    stopIcon.style.display = "";
    toggleBtn.classList.add("active");
    statusText.textContent = "Filtering";
    statusEl.classList.add("active");
  } else {
    btnLabel.textContent = "Start Filtering";
    playIcon.style.display = "";
    stopIcon.style.display = "none";
    toggleBtn.classList.remove("active");
    statusText.textContent = "Ready";
    statusEl.classList.remove("active");
  }
}

function updateAIOptionsVisibility() {
  aiOptions.style.display = isAIMode(modeSelect.value) ? "" : "none";
}

modeSelect.addEventListener("change", () => {
  modeHint.textContent = MODE_HINTS[modeSelect.value] || "";
  updateAIOptionsVisibility();
  chrome.runtime.sendMessage({ type: "SET_MODE", value: modeSelect.value });
  if (isAIMode(modeSelect.value)) {
    chrome.runtime.sendMessage({ type: "SET_AI_MODEL", value: aiModelSelect.value });
  }
});
modeHint.textContent = MODE_HINTS[modeSelect.value];
updateAIOptionsVisibility();

aiModelSelect.addEventListener("change", () => {
  chrome.runtime.sendMessage({ type: "SET_AI_MODEL", value: aiModelSelect.value });
});

// Fetch available models from the server and populate the dropdown
function loadAvailableModels() {
  chrome.runtime.sendMessage({ type: "GET_AI_MODELS" }, (response) => {
    if (!response || !response.success) {
      modelHint.textContent = "Server not running — start backend/server.py";
      return;
    }

    const models = response.models;
    const currentVal = aiModelSelect.value;
    aiModelSelect.innerHTML = "";

    const demucsModels = [];
    const separatorModels = [];
    for (const [key, info] of Object.entries(models)) {
      if (info.backend === "demucs") {
        demucsModels.push({ key, label: info.label });
      } else {
        separatorModels.push({ key, label: info.label });
      }
    }

    if (demucsModels.length > 0) {
      const group = document.createElement("optgroup");
      group.label = "Demucs";
      for (const m of demucsModels) {
        const opt = document.createElement("option");
        opt.value = m.key;
        opt.textContent = m.label;
        group.appendChild(opt);
      }
      aiModelSelect.appendChild(group);
    }

    if (separatorModels.length > 0) {
      const group = document.createElement("optgroup");
      group.label = "Audio Separator";
      for (const m of separatorModels) {
        const opt = document.createElement("option");
        opt.value = m.key;
        opt.textContent = m.label;
        group.appendChild(opt);
      }
      aiModelSelect.appendChild(group);
    }

    if (currentVal && aiModelSelect.querySelector(`option[value="${currentVal}"]`)) {
      aiModelSelect.value = currentVal;
    }

    const total = demucsModels.length + separatorModels.length;
    modelHint.textContent = `${total} model${total !== 1 ? "s" : ""} available`;
  });
}

loadAvailableModels();

toggleBtn.addEventListener("click", async () => {
  if (!isActive) {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (!tab) {
      statusText.textContent = "No active tab";
      return;
    }

    statusText.textContent = "Starting...";

    const response = await chrome.runtime.sendMessage({
      type: "START_CAPTURE",
      tabId: tab.id,
      mode: modeSelect.value,
      aiModel: isAIMode(modeSelect.value) ? aiModelSelect.value : undefined,
    });

    if (response && response.success) {
      isActive = true;
      setActiveUI(true);
    } else {
      statusText.textContent = response ? response.error : "Unknown error";
    }
  } else {
    chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
    isActive = false;
    setActiveUI(false);
  }
});

mixSlider.addEventListener("input", () => {
  const value = mixSlider.value / 100;
  mixValue.textContent = mixSlider.value + "%";
  chrome.runtime.sendMessage({ type: "SET_MIX", value: value });
});
