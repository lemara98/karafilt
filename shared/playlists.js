// Karafilt — account-synced song playlists (side panel "Playlists" tab).
//
// The server owns the data: named lists + songs live in Supabase behind the
// 0041 RPCs, reached through the service worker (PLAYLISTS_GET /
// PLAYLISTS_MUTATE → /api/playlists, cookie session) so playlists follow the
// Karafilt account across browsers and reinstalls. Two things stay local in
// chrome.storage.local:
//
//   kfPlaylistsCache  — the last successful GET, served when the network (or
//                       session) is down so the tab still renders; mutations
//                       are refused offline, never queued.
//   kfPlaylistsActive — the "default target" playlist id for the one-tap
//                       + Add button: a per-device preference, not data.
//
// The exported surface matches what sidepanel.js consumes:
//   load() → { activeId, lists:[{id,name,createdAt,items:[{videoKey,title,url,addedAt}]}],
//              stale?: true, signedOut?: true }
//   createList/renameList/deleteList/setActive/addSong/removeSong
//
// Songs are keyed by deriveVideoKey() (shared/video-key.js), same as ratings
// and usage reporting; the server dedupes per list on that key.

(function () {
  const CACHE_KEY = "kfPlaylistsCache";
  const ACTIVE_KEY = "kfPlaylistsActive";
  const NAME_MAX = 60;

  function sendMessage(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          // Surface a dead worker/port as a network-ish failure.
          if (chrome.runtime.lastError || !res) resolve({ ok: false, error: "port" });
          else resolve(res);
        });
      } catch {
        resolve({ ok: false, error: "port" });
      }
    });
  }

  // Tolerates anything previously cached: a malformed blob degrades to "no
  // playlists" rather than throwing into the panel's render path.
  function normalizeLists(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((l) => l && typeof l === "object" && typeof l.id === "string")
      .map((l) => ({
        id: l.id,
        name: String(l.name || "Untitled").slice(0, NAME_MAX),
        createdAt: l.createdAt || "",
        items: (Array.isArray(l.items) ? l.items : [])
          .filter((it) => it && typeof it.videoKey === "string" && it.videoKey)
          .map((it) => ({
            videoKey: it.videoKey,
            title: String(it.title || "").slice(0, 300),
            url: typeof it.url === "string" ? it.url : "",
            addedAt: it.addedAt || "",
          })),
      }));
  }

  async function readLocal() {
    const got = await chrome.storage.local.get({ [CACHE_KEY]: null, [ACTIVE_KEY]: null });
    return { cached: got[CACHE_KEY], activeId: got[ACTIVE_KEY] };
  }

  function withActive(lists, activeId) {
    const valid = lists.some((l) => l.id === activeId) ? activeId : lists[0]?.id ?? null;
    return { activeId: valid, lists };
  }

  // Fetch from the server; fall back to the cached copy (marked stale) when
  // the network or session is unavailable.
  async function load() {
    const { cached, activeId } = await readLocal();
    const res = await sendMessage({ type: "PLAYLISTS_GET" });
    if (res.ok && res.data) {
      const lists = normalizeLists(res.data.lists);
      await chrome.storage.local.set({ [CACHE_KEY]: { lists } });
      return withActive(lists, activeId);
    }
    const fallback = withActive(normalizeLists(cached && cached.lists), activeId);
    if (res.status === 401) fallback.signedOut = true;
    else fallback.stale = true;
    return fallback;
  }

  // Cache-only read for hot paths (the per-song card refresh) — no network.
  async function loadCached() {
    const { cached, activeId } = await readLocal();
    return withActive(normalizeLists(cached && cached.lists), activeId);
  }

  async function mutate(body) {
    const res = await sendMessage({ type: "PLAYLISTS_MUTATE", body });
    if (!res.ok && !res.data) {
      return { ok: false, result: res.status === 401 ? "signed_out" : "network" };
    }
    return res.data || { ok: false, result: "network" };
  }

  async function createList(name) {
    const res = await mutate({ action: "create", name });
    if (!res.ok || !res.id) {
      throw new Error(res.result === "too_many" ? "Too many playlists" : "Couldn't save");
    }
    await chrome.storage.local.set({ [ACTIVE_KEY]: res.id }); // just-created → default target
    return { id: res.id, name, items: [] };
  }

  async function renameList(id, name) {
    const res = await mutate({ action: "rename", id, name });
    return res.ok ? { id } : null;
  }

  async function deleteList(id) {
    await mutate({ action: "delete", id });
    const { activeId } = await readLocal();
    if (activeId === id) await chrome.storage.local.set({ [ACTIVE_KEY]: null });
    return load();
  }

  async function setActive(id) {
    await chrome.storage.local.set({ [ACTIVE_KEY]: id });
    return load();
  }

  // Adds to `listId`, or to the active list when omitted. Returns
  // { added, list, reason } like the panel expects; `list` carries the name
  // for the status line ("Added to X ✓").
  async function addSong(song, listId) {
    if (!song || !song.videoKey) return { added: false, list: null, reason: "no_song" };
    const state = await load();
    const target = listId || state.activeId;
    const list = state.lists.find((l) => l.id === target);
    if (!list) return { added: false, list: null, reason: "no_list" };
    const res = await mutate({
      action: "add",
      id: list.id,
      videoKey: song.videoKey,
      title: song.title || "",
      url: song.url || "",
    });
    if (res.ok) {
      if (listId) await chrome.storage.local.set({ [ACTIVE_KEY]: listId }); // picked → new default
      await load(); // refresh the cache with the server's view
      return { added: true, list, reason: null };
    }
    return { added: false, list, reason: res.result || "network" };
  }

  async function removeSong(listId, videoKey) {
    await mutate({ action: "remove", id: listId, videoKey });
    return load();
  }

  globalThis.KarafiltPlaylists = {
    KEY: CACHE_KEY, // sidepanel.js watches this storage key for cross-window repaints
    NAME_MAX,
    load,
    loadCached,
    createList,
    renameList,
    deleteList,
    setActive,
    addSong,
    removeSong,
  };
})();
