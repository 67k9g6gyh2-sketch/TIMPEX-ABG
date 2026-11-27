// Tests on the shipped files: service-worker cache isolation, build sync, API-key and image privacy.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

function loadSW(existing) {
  const store = new Set(existing), handlers = {};
  const caches = {
    keys: async () => [...store],
    delete: async (k) => store.delete(k),
    open: async (k) => { store.add(k); return { addAll: async () => {}, put: async () => {}, match: async () => undefined }; },
  };
  const self = { addEventListener: (t, fn) => { handlers[t] = fn; }, skipWaiting: () => {}, clients: { claim: async () => {} }, location: { origin: "https://example.github.io" } };
  const ctx = vm.createContext({ self, caches, URL, AbortController, setTimeout, clearTimeout, fetch: async () => { throw new Error("offline"); }, Response: { error: () => null }, console });
  vm.runInContext(read("sw.js"), ctx);
  return { store, handlers, ctx };
}

test("22. service worker deletes only this app's old caches", async () => {
  const before = ["timpex-gasvent-v16-3", "timpex-gasvent-v16-2", "timpex-gasvent-v16-1", "timpex-gasvent-v16", "timpex-gasvent-v15", "timpex-gasvent-v14", "timpex-gasvent-v9", "timpex-abg-v8", "abg-o2-v2",
    "timpex-rounds-v3", "timpex-drips-v2", "workbox-precache-v2", "other-app", "timpex-gasvent-extra"];
  const { store, handlers, ctx } = loadSW(before);
  assert.equal(vm.runInContext("CACHE", ctx), "timpex-gasvent-v16-3");   // v16.3 cache; older ones are removed
  let p; handlers.activate({ waitUntil: (x) => { p = x; } }); await p;
  const after = [...store].sort();
  assert.deepEqual(after, ["other-app", "timpex-drips-v2", "timpex-gasvent-extra", "timpex-gasvent-v16-3", "timpex-rounds-v3", "workbox-precache-v2"].sort());
});

test("index.html ships exactly the tested calculation engine (src/logic.js)", () => {
  const html = read("index.html"), logic = read("src/logic.js").trimEnd();
  assert.ok(html.includes(logic), "index.html is out of date: run python3 src/build.py");
});

test("index.html parses: every inline script compiles", () => {
  const html = read("index.html");
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((t) => t.trim());
  assert.ok(scripts.length >= 2);
  scripts.forEach((code, i) => { assert.doesNotThrow(() => new vm.Script(code, { filename: "inline-" + i + ".js" })); });
  assert.doesNotThrow(() => new vm.Script(read("sw.js")));
});

test("13 (privacy). API key is never written to storage; images need explicit consent", () => {
  const html = read("index.html");
  // The only stored item is the install-banner "dismissed" flag; nothing to do with the API key
  const sets = [...html.matchAll(/(local|session)Storage\.setItem\(([^)]*)\)/g)].map((m) => m[2]);
  assert.deepEqual(sets, ['KEY, "1"'], "unexpected storage writes: " + sets.join(" | "));
  assert.match(html, /var KEY = "abgO2.installDismissed";/);
  assert.match(html, /localStorage\.removeItem\(AIK\)/, "a key saved by v12–v14 is removed");
  assert.ok(!/i-aikeep/.test(html), "the 'Remember the key' option is gone");
  assert.match(html, /id="i-aiconsent"/);
  assert.match(html, /id="i-aiconsent2"/);
  // the photo-read request is guarded by the consent checkbox
  const run = html.slice(html.indexOf('$("ai-run").addEventListener'), html.indexOf('$("ai-run").addEventListener') + 1200);
  assert.ok(run.indexOf('i-aiconsent') > -1 && run.indexOf('i-aiconsent') < run.indexOf("fetch("), "consent is checked before fetch");
  // choosing a Values-screen photo only shows it; sending happens from the Send button
  const ch = html.slice(html.indexOf('$("mv-ai-file").addEventListener("change"'), html.indexOf("function sendFill"));
  assert.ok(ch.length > 0 && !/fetch\(/.test(ch), "file choice does not call fetch");
  assert.match(ch, /i-aiconsent2/);
});

test("the only network destination is the Anthropic API, used by the two AI buttons", () => {
  const html = read("index.html");
  const urls = [...html.matchAll(/fetch\(\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(urls.length >= 1);
  urls.forEach((u) => assert.equal(u, "https://api.anthropic.com/v1/messages"));
});
