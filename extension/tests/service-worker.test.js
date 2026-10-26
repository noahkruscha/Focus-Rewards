import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const workerSource = await readFile(new URL("../src/service-worker.js", import.meta.url), "utf8");

function makeWorker({ stored = {}, fetchImpl = async () => new Response("{}", { status: 200 }) } = {}) {    const listeners = [];
  const chrome = {
    runtime: {
      id: "a".repeat(32),
      getURL(path) { return `chrome-extension://${this.id}/${path}`; },
      onMessage: { addListener(listener) { listeners.push(listener); } },
    },
    storage: {
      local: {
        async get(keys) { return Object.fromEntries(keys.filter((key) => key in stored).map((key) => [key, stored[key]])); },
        async set(values) { Object.assign(stored, values); },
        async remove(keys) { keys.forEach((key) => delete stored[key]); },
        setAccessLevel() {},
      },
    },
  };
  vm.runInNewContext(workerSource, {
    chrome,
    fetch: fetchImpl,
    URL,
    Response,
    btoa,
    TextEncoder,
    crypto: globalThis.crypto,
  });
  async function message(value, sender = { id: chrome.runtime.id, url: chrome.runtime.getURL("options/options.html") }) {
    return await new Promise((resolve) => {
      const keepOpen = listeners[0](value, sender, resolve);
      if (!keepOpen) resolve({ ignored: true });
    });
  }
  return { chrome, stored, message };
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("extension messages are accepted only from the built-in options page", async () => {
  const worker = makeWorker();
  assert.deepEqual(await worker.message({ type: "status" }, { id: worker.chrome.runtime.id, url: "https://www.youtube.com/" }), { ignored: true });
  assert.deepEqual(await worker.message({ type: "status" }, { id: "b".repeat(32), url: `chrome-extension://${"b".repeat(32)}/options/options.html` }), { ignored: true });
});

test("pairing validates the deployment, redeems the one-time code, and stores only the server credential", async () => {
  const token = "T".repeat(43);
  let outbound;
  const worker = makeWorker({ fetchImpl: async (url, init) => {
    outbound = { url, init };
    return response({ token, expiresAt: Date.now() + 30 * 86400000, email: "owner@example.com" });
  } });
  const result = await worker.message({ type: "pair", siteUrl: "https://focus.convex.site", code: "c".repeat(32) });
  assert.equal(result.ok, true);
  assert.equal(result.email, "owner@example.com");
  assert.equal(outbound.url, "https://focus.convex.site/extension/redeem");
  assert.deepEqual(JSON.parse(outbound.init.body), { code: "c".repeat(32) });
  assert.equal(worker.stored.focusRewardsExtensionToken, token);
  assert.equal(worker.stored.focusRewardsExtensionExpiresAt > Date.now(), true);
  assert.equal(worker.stored.focusRewardsConvexSiteUrl, "https://focus.convex.site");
});

test("malformed pairing responses do not create an authenticated state", async () => {
  const worker = makeWorker({ fetchImpl: async () => response({ token: "wrong" }) });
  const result = await worker.message({ type: "pair", siteUrl: "https://focus.convex.site", code: "c".repeat(32) });
  assert.equal(result.ok, false);
  assert.equal(worker.stored.focusRewardsExtensionToken, undefined);
});

test("network failure preserves credentials, while a server denial clears expired or revoked credentials", async () => {
  const stored = {
    focusRewardsExtensionToken: "T".repeat(43),
    focusRewardsExtensionExpiresAt: Date.now() + 60_000,
    focusRewardsConvexSiteUrl: "https://focus.convex.site",
  };
  let statusCode = 503;
  const worker = makeWorker({ stored, fetchImpl: async () => response({ error: "no" }, statusCode) });
  const offline = await worker.message({ type: "status" });
  assert.equal(offline.kind, "network");
  assert.equal(stored.focusRewardsExtensionToken, "T".repeat(43));
  statusCode = 401;
  const revoked = await worker.message({ type: "status" });
  assert.equal(revoked.reason, "expired-or-revoked");
  assert.equal(stored.focusRewardsExtensionToken, undefined);
});

test("bearer credential is used for online validation and explicit server revocation", async () => {
  const stored = {
    focusRewardsExtensionToken: "T".repeat(43),
    focusRewardsExtensionExpiresAt: Date.now() + 60_000,
    focusRewardsConvexSiteUrl: "https://focus.convex.site",
  };
  const calls = [];
  const worker = makeWorker({ stored, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return init.method === "DELETE" ? response({ revoked: true }) : response({ email: "friend@example.com", expiresAt: stored.focusRewardsExtensionExpiresAt });
  } });
  assert.equal((await worker.message({ type: "status" })).signedIn, true);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${"T".repeat(43)}`);
  const logout = await worker.message({ type: "revoke" });
  assert.equal(logout.revoked, true);
  assert.equal(calls[1].init.method, "DELETE");
  assert.equal(stored.focusRewardsExtensionToken, undefined);
});

test("pairing URL and code validation reject insecure or attacker-controlled endpoints", async () => {
  const worker = makeWorker({ fetchImpl: async () => { throw new Error("unexpected fetch"); } });
  assert.equal((await worker.message({ type: "pair", siteUrl: "http://focus.convex.site", code: "c".repeat(32) })).kind, "input");
  assert.equal((await worker.message({ type: "pair", siteUrl: "https://attacker.example/", code: "c".repeat(32) })).kind, "input");
  assert.equal((await worker.message({ type: "pair", siteUrl: "https://focus.convex.site", code: "short" })).kind, "input");
});
