// Custom mode picker. Progressively enhances the native <select> that drives
// the vocal-removal mode so we get rich option cards (icon + name + blurb +
// tag) instead of a flat browser dropdown — and so AI modes can be locked
// behind a Karafilt subscription/trial.
//
// The native <select> stays in the DOM as the single source of truth: this
// widget only mirrors it. Picking a card sets select.value and dispatches a
// real `change` event, so all of controls-bindings.js keeps working unchanged.
// External updates (storage sync from the other surface) come back through
// chrome.storage.onChanged and re-render the trigger.

(function () {
  // Per-mode presentation. Keys match the <option value="…"> in the markup.
  // `premium: true` marks a mode that needs an active subscription/trial.
  const ICONS = {
    bolt: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5z"/></svg>',
    wave: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 12h2.5M7 5v14M11.5 8v8M16 3v18M20.5 9v6M23 11h-.5"/></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8L12 2zM19 14l.9 2.6L22.5 17.5l-2.6.9L19 21l-.9-2.6L15.5 17.5l2.6-.9L19 14z"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>',
    caret: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>',
  };

  const MODE_META = {
    stft: { name: "Spectral", desc: "Balanced quality — keeps bass & stereo", tag: "Recommended", icon: "wave" },
    stft_deep: { name: "Spectral Deep", desc: "Strips center backing vocals too — thinner mix", tag: "Strong", icon: "wave" },
    basic: { name: "Basic", desc: "Quick center-channel removal", tag: "Fast", icon: "bolt" },
    ai: { name: "AI Separation", desc: "Neural network — the cleanest vocals", tag: "Best", icon: "spark", premium: true },
    ai2: { name: "AI + Deep Clean", desc: "Two-pass AI — removes backing vocals too", tag: "Pro", icon: "spark", premium: true },
  };

  function metaFor(value, fallbackLabel) {
    return MODE_META[value] || { name: fallbackLabel || value, desc: "", tag: "", icon: "wave" };
  }

  // Decide whether AI modes are available, from the account-status payload the
  // service worker returns for the side panel's account chip.
  //   disabled  → gating off (self-hosted / no Website URL): allow everything.
  //   otherwise → need a verified account on subscription or a live trial.
  function deriveAccess(acc) {
    if (!acc || acc.disabled) {
      return { allowed: true };
    }
    if (!acc.signedIn) {
      return { allowed: false, reason: "Sign in to unlock AI modes", url: acc.loginUrl, login: true };
    }
    if (acc.emailVerified === false) {
      return { allowed: false, reason: "Verify your email to unlock AI", url: acc.accountUrl };
    }
    if (acc.entitlement === "subscription") return { allowed: true };
    if (acc.entitlement === "trial" && (acc.trialSecondsRemaining || 0) > 0) return { allowed: true };
    return { allowed: false, reason: "Upgrade to unlock AI modes", url: acc.accountUrl };
  }

  function enhance(select) {
    if (!select || select.dataset.fancyReady) return;
    select.dataset.fancyReady = "1";

    const wrap = select.closest(".select-wrap") || select.parentElement;
    wrap.classList.add("fancy-host");

    // Snapshot the options (value + visible label) before we hide the select.
    const options = Array.from(select.options).map((o) => ({
      value: o.value,
      label: o.textContent.trim(),
    }));

    let access = { allowed: true }; // optimistic until the SW answers

    // ── Build the widget ────────────────────────────────────────────────
    const root = document.createElement("div");
    root.className = "fancy-select";

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "fs-trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");

    const menu = document.createElement("div");
    menu.className = "fs-menu";
    menu.setAttribute("role", "listbox");

    root.appendChild(trigger);
    root.appendChild(menu);
    wrap.appendChild(root);

    // Build the option cards once; lock state is toggled later.
    const cards = options.map((opt) => {
      const meta = metaFor(opt.value, opt.label);
      const card = document.createElement("button");
      card.type = "button";
      card.className = "fs-option";
      card.dataset.value = opt.value;
      card.setAttribute("role", "option");
      card.innerHTML = `
        <span class="fs-opt-icon">${ICONS[meta.icon] || ""}</span>
        <span class="fs-opt-body">
          <span class="fs-opt-head">
            <span class="fs-opt-name">${meta.name}</span>
            ${meta.tag ? `<span class="fs-opt-tag${meta.premium ? " premium" : ""}">${meta.tag}</span>` : ""}
          </span>
          <span class="fs-opt-desc">${meta.desc}</span>
        </span>
        <span class="fs-opt-state">
          <span class="fs-opt-check">${ICONS.check}</span>
          <span class="fs-opt-lock">${ICONS.lock}</span>
        </span>`;
      card.addEventListener("click", () => onPick(opt.value, meta));
      menu.appendChild(card);
      return { opt, meta, card };
    });

    // Upsell note shown inside the menu when AI is locked.
    const note = document.createElement("button");
    note.type = "button";
    note.className = "fs-note";
    note.addEventListener("click", goUpsell);
    menu.appendChild(note);

    function renderTrigger() {
      const value = select.value;
      const meta = metaFor(value, value);
      const locked = !!meta.premium && !access.allowed;
      trigger.classList.toggle("locked", locked);
      trigger.innerHTML = `
        <span class="fs-trigger-icon">${ICONS[meta.icon] || ""}</span>
        <span class="fs-trigger-text">
          <span class="fs-trigger-name">${meta.name}</span>
          <span class="fs-trigger-desc">${meta.desc}</span>
        </span>
        ${meta.tag ? `<span class="fs-opt-tag${meta.premium ? " premium" : ""}">${meta.tag}</span>` : ""}
        <span class="fs-caret">${ICONS.caret}</span>`;
    }

    function renderLocks() {
      let anyLocked = false;
      for (const { meta, card, opt } of cards) {
        const locked = !!meta.premium && !access.allowed;
        card.classList.toggle("locked", locked);
        card.classList.toggle("selected", opt.value === select.value);
        if (locked) anyLocked = true;
      }
      if (anyLocked && access.reason) {
        note.style.display = "";
        note.innerHTML = `<span class="fs-lock-icon">${ICONS.lock}</span><span>${access.reason}</span>`;
      } else {
        note.style.display = "none";
      }
    }

    function goUpsell() {
      // Route a locked interaction to sign-in (so the SW can return the user to
      // this tab) or to the account/upgrade page.
      if (access.login) {
        chrome.runtime.sendMessage({ type: "OPEN_LOGIN", loginUrl: access.url });
      } else if (access.url) {
        chrome.tabs.create({ url: access.url });
      }
      close();
    }

    function onPick(value, meta) {
      if (meta.premium && !access.allowed) {
        goUpsell();
        return;
      }
      if (select.value !== value) {
        select.value = value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
      renderTrigger();
      renderLocks();
      close();
    }

    // ── Open / close ────────────────────────────────────────────────────
    // The menu is position:fixed, so place it against the trigger's viewport
    // rect each time. Opens downward by default; flips up when there's more
    // room above, and caps its height to the available space (it scrolls).
    function positionMenu() {
      const margin = 8; // keep clear of the viewport edge
      const gap = 6; // space between trigger and menu
      const rect = trigger.getBoundingClientRect();
      menu.style.left = rect.left + "px";
      menu.style.width = rect.width + "px";
      menu.style.maxHeight = "none";
      const natural = menu.offsetHeight;
      const spaceBelow = window.innerHeight - rect.bottom - margin;
      const spaceAbove = rect.top - margin;
      if (spaceBelow >= natural || spaceBelow >= spaceAbove) {
        menu.style.bottom = "auto";
        menu.style.top = rect.bottom + gap + "px";
        menu.style.maxHeight = Math.max(80, spaceBelow - gap) + "px";
      } else {
        menu.style.top = "auto";
        menu.style.bottom = window.innerHeight - rect.top + gap + "px";
        menu.style.maxHeight = Math.max(80, spaceAbove - gap) + "px";
      }
    }
    function open() {
      renderLocks();
      root.classList.add("open");
      trigger.setAttribute("aria-expanded", "true");
      positionMenu();
      refreshAccess(); // re-check entitlement each time it's opened
      document.addEventListener("click", onDocClick, true);
      document.addEventListener("keydown", onKey, true);
      // Keep the fixed menu glued to the trigger as the panel scrolls/resizes.
      window.addEventListener("scroll", positionMenu, true);
      window.addEventListener("resize", positionMenu);
    }
    function close() {
      root.classList.remove("open");
      trigger.setAttribute("aria-expanded", "false");
      document.removeEventListener("click", onDocClick, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", positionMenu, true);
      window.removeEventListener("resize", positionMenu);
    }
    function onDocClick(e) {
      if (!root.contains(e.target)) close();
    }
    function onKey(e) {
      if (e.key === "Escape") close();
    }
    trigger.addEventListener("click", () => {
      root.classList.contains("open") ? close() : open();
    });

    // ── Entitlement lookup ──────────────────────────────────────────────
    function refreshAccess() {
      if (!chrome.runtime || !chrome.runtime.sendMessage) return;
      chrome.runtime.sendMessage({ type: "GET_ACCOUNT_STATUS" }, (acc) => {
        if (chrome.runtime.lastError) return;
        access = deriveAccess(acc);
        renderTrigger();
        renderLocks();
        if (root.classList.contains("open")) positionMenu();
      });
    }

    // ── Stay in sync with the native select / cross-surface storage ─────
    select.addEventListener("change", () => {
      renderTrigger();
      renderLocks();
    });
    if (chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        if (changes.mode) {
          // Sync the native select ourselves — our listener may run before
          // controls-bindings.js's, so don't rely on select.value being fresh.
          if (changes.mode.newValue != null) select.value = changes.mode.newValue;
          renderTrigger();
          renderLocks();
        }
        if (changes.websiteUrl) refreshAccess();
      });
    }
    // Account state changes broadcast by the service worker (sign-in/out).
    if (chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((message, sender) => {
        if (sender && sender.tab) return;
        if (message && message.type === "ACCOUNT_CHANGED") refreshAccess();
      });
    }

    renderTrigger();
    renderLocks();
    refreshAccess();
  }

  function init() {
    document.querySelectorAll("select[data-fancy-mode]").forEach(enhance);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.enhanceModeSelect = enhance;
})();
