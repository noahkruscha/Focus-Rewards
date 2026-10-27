import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const workerSource = await readFile(new URL("../src/service-worker.js", import.meta.url), "utf8");

function makeWorker({ stored, fetchImpl }) {
  let listener;
  const extensionId = "a".repeat(32);
  const chrome = {
    runtime: { id: extensionId, getURL: (path) => `chrome-extension://${extensionId}/${path}`, onMessage: { addListener(fn) { listener = fn; } } },
    storage: { local: {
      async get(keys) { return Object.fromEntries(keys.filter((key) => key in stored).map((key) => [key, stored[key]])); },
      async set(values) { Object.assign(stored, values); },
      async remove(keys) { keys.forEach((key) => delete stored[key]); },
      setAccessLevel() {},
    } },
  };
  vm.runInNewContext(workerSource, { chrome, fetch: fetchImpl, URL, URLSearchParams, Response, btoa, TextEncoder, crypto: globalThis.crypto });
  const youtubeSender = { id: extensionId, url: "https://www.youtube.com/watch?v=abcdefghijk", tab: { id: 1 } };
  const send = (message, sender = youtubeSender) => new Promise((resolve) => {
    const keepOpen = listener(message, sender, resolve);
    if (!keepOpen) resolve({ ignored: true });
  });
  return { send, youtubeSender, extensionId };
}

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status });

function authenticatedStorage() {
  return {
    focusRewardsExtensionToken: "T".repeat(43),
    focusRewardsExtensionExpiresAt: Date.now() + 60_000,
    focusRewardsConvexSiteUrl: "https://focus.convex.site",
  };
}

test("purchase omits client prices and preserves idempotency key after a network retry", async () => {
  const calls = [];
  let failFirstPurchase = true;
  const worker = makeWorker({ stored: authenticatedStorage(), fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (!url.includes("/purchase")) return jsonResponse({ error: "unused" }, 500);
    if (failFirstPurchase) {
      failFirstPurchase = false;
      throw new Error("network disconnected");
    }
    return jsonResponse({ success: true, price: 36, expiresAt: Date.now() + 30 * 86400000, alreadyProcessed: true });
  } });
  const request = {
    type: "youtube-purchase",    videoId: "abcdefghijk", contentType: "youtube_video", durationSeconds: 900,
    idempotencyKey: "stable-idempotency-key-01", quoteId: "quote-from-server", price: 1,
  };
  assert.equal((await worker.send(request)).kind, "network");
  assert.equal((await worker.send(request)).alreadyProcessed, true);
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[1].init.body).price, undefined);
  assert.equal(JSON.parse(calls[1].init.body).quoteId, request.quoteId);
  assert.equal(JSON.parse(calls[1].init.body).idempotencyKey, request.idempotencyKey);
  assert.equal(calls[1].init.headers.Authorization, `Bearer ${"T".repeat(43)}`);
});

test("invalid requests and unknown routes are not reported as successful", async () => {
  const worker = makeWorker({ stored: authenticatedStorage(), fetchImpl: async () => jsonResponse({ error: "service unavailable" }, 503) });
  const badSender = { id: worker.extensionId, url: "https://example.com/", tab: { id: 2 } };
  assert.notEqual((await worker.send({ type: "youtube-purchase" }, badSender)).ok, true);
  const failed = await worker.send({
    type: "youtube-purchase", videoId: "abcdefghijk", contentType: "youtube_short", durationSeconds: 30,
    idempotencyKey: "stable-idempotency-key-02",
  });
  assert.equal(failed.kind, "network");
  assert.notEqual(failed.ok, true);
});
