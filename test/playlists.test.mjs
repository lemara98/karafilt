// Karafilt — playlists client module tests
//
//   node test/playlists.test.mjs
//
// Pure Node. The module is a thin client over the service worker's
// PLAYLISTS_GET / PLAYLISTS_MUTATE proxy (→ /api/playlists → 0041 RPCs), so
// the mock implements the server's semantics — dedupe, caps, status words —
// and the tests cover the client contract: response mapping, the local cache
// fallback, the active-list preference, and malformed-cache tolerance.

import assert from "node:assert";

// ── In-memory "server" with /api/playlists semantics ────────────────────────
let server;
function resetServer() {
  server = { lists: [], nextId: 1, mode: "ok" }; // mode: ok | network | signed_out
}
function uuid() {
  const n = String(server.nextId++).padStart(12, "0");
  return `00000000-0000-4000-8000-${n}`;
}
function handle(msg) {
  if (server.mode === "network") return { ok: false, error: "network" };
  if (server.mode === "signed_out") return { ok: false, status: 401 };
  if (msg.type === "PLAYLISTS_GET") {
    return { ok: true, data: { lists: structuredClone(server.lists) } };
  }
  const b = msg.body || {};
  const find = (id) => server.lists.find((l) => l.id === id);
  switch (b.action) {
    case "create": {
      if (server.lists.length >= 50) return { ok: true, data: { ok: false, result: "too_many" } };
      const id = uuid();
      server.lists.push({ id, name: b.name, createdAt: "now", items: [] });
      return { ok: true, data: { ok: true, id } };
    }
    case "rename": {
      const l = find(b.id);
      if (l) l.name = b.name;
      return { ok: true, data: { ok: !!l } };
    }
    case "delete": {
      const had = !!find(b.id);
      server.lists = server.lists.filter((l) => l.id !== b.id);
      return { ok: true, data: { ok: had } };
    }
    case "add": {
      const l = find(b.id);
      if (!l) return { ok: true, data: { ok: false, result: "no_list" } };
      if (l.items.length >= 500) return { ok: true, data: { ok: false, result: "full" } };
      if (l.items.some((i) => i.videoKey === b.videoKey))
        return { ok: true, data: { ok: false, result: "duplicate" } };
      l.items.push({ videoKey: b.videoKey, title: b.title, url: b.url, addedAt: "now" });
      return { ok: true, data: { ok: true, result: "added" } };
    }
    case "remove": {
      const l = find(b.id);
      if (l) l.items = l.items.filter((i) => i.videoKey !== b.videoKey);
      return { ok: true, data: { ok: !!l } };
    }
  }
  return { ok: false, status: 400 };
}

// ── chrome mock ─────────────────────────────────────────────────────────────
let store = {};
globalThis.chrome = {
  runtime: {
    lastError: null,
    sendMessage: (msg, cb) => setTimeout(() => cb(handle(msg)), 0),
  },
  storage: {
    local: {
      get: async (defaults) => {
        const out = {};
        for (const k of Object.keys(defaults))
          out[k] = k in store ? structuredClone(store[k]) : defaults[k];
        return out;
      },
      set: async (obj) => {
        for (const [k, v] of Object.entries(obj)) store[k] = structuredClone(v);
      },
    },
  },
};

await import("../shared/playlists.js");
const P = globalThis.KarafiltPlaylists;

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}
function reset() {
  resetServer();
  store = {};
}

const SONG = { videoKey: "yt:abc123", title: "Test Song", url: "https://www.youtube.com/watch?v=abc123" };

console.log("playlists (server-backed)");

await check("empty server loads as no playlists", async () => {
  reset();
  const state = await P.load();
  assert.deepStrictEqual(state.lists, []);
  assert.strictEqual(state.activeId, null);
});

await check("createList becomes the active (default) target", async () => {
  reset();
  const list = await P.createList("Karaoke Night");
  const state = await P.load();
  assert.strictEqual(state.activeId, list.id);
  assert.strictEqual(state.lists[0].name, "Karaoke Night");
});

await check("addSong targets the active list and maps duplicate", async () => {
  reset();
  await P.createList("A");
  const first = await P.addSong(SONG);
  assert.strictEqual(first.added, true);
  const dup = await P.addSong({ ...SONG, title: "Other spelling" });
  assert.strictEqual(dup.added, false);
  assert.strictEqual(dup.reason, "duplicate");
  const state = await P.load();
  assert.strictEqual(state.lists[0].items.length, 1);
});

await check("addSong with a picked list adds there and makes it default", async () => {
  reset();
  const a = await P.createList("A");
  await P.createList("B"); // B active
  const res = await P.addSong(SONG, a.id);
  assert.strictEqual(res.added, true);
  const state = await P.load();
  assert.strictEqual(state.activeId, a.id); // picked → new default
  assert.strictEqual(state.lists.find((l) => l.id === a.id).items.length, 1);
});

await check("addSong with no lists reports no_list", async () => {
  reset();
  const res = await P.addSong(SONG);
  assert.strictEqual(res.added, false);
  assert.strictEqual(res.reason, "no_list");
});

await check("server full/cap maps to reasons the panel shows", async () => {
  reset();
  const a = await P.createList("A");
  server.lists[0].items = Array.from({ length: 500 }, (_, i) => ({
    videoKey: `yt:v${i}`, title: "", url: "", addedAt: "now",
  }));
  const res = await P.addSong(SONG, a.id);
  assert.strictEqual(res.reason, "full");
  server.lists = Array.from({ length: 50 }, (_, i) => ({ id: uuid(), name: `L${i}`, createdAt: "now", items: [] }));
  await assert.rejects(() => P.createList("one too many"), /Too many playlists/);
});

await check("deleteList clears the default and falls back", async () => {
  reset();
  const a = await P.createList("A");
  const b = await P.createList("B"); // active
  const state = await P.deleteList(b.id);
  assert.strictEqual(state.lists.length, 1);
  assert.strictEqual(state.activeId, a.id);
});

await check("network failure falls back to the cached copy, marked stale", async () => {
  reset();
  await P.createList("A");
  await P.addSong(SONG);
  await P.load(); // warm the cache
  server.mode = "network";
  const state = await P.load();
  assert.strictEqual(state.stale, true);
  assert.strictEqual(state.lists[0].items[0].videoKey, "yt:abc123");
});

await check("401 marks signedOut instead of stale", async () => {
  reset();
  server.mode = "signed_out";
  const state = await P.load();
  assert.strictEqual(state.signedOut, true);
  assert.strictEqual(state.stale, undefined);
});

await check("mutations refused offline map to network reason", async () => {
  reset();
  await P.createList("A");
  await P.load();
  server.mode = "network";
  const res = await P.addSong(SONG);
  assert.strictEqual(res.added, false);
  assert.strictEqual(res.reason, "network");
});

await check("malformed cached blob degrades to empty, not a throw", async () => {
  reset();
  server.mode = "network";
  store[P.KEY] = { lists: "not-an-array" };
  const state = await P.load();
  assert.deepStrictEqual(state.lists, []);
  const cached = await P.loadCached();
  assert.deepStrictEqual(cached.lists, []);
});

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall good");
