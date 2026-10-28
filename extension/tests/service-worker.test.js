import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const workerSource = await readFile(new URL("../src/service-worker.js", import.meta.url), "utf8");

function makeWorker({ stored = {}, fetchImpl = async () => new Response("{}", { status: 200 }), tabs = {} } = {}) {
  const listeners = [];
  const chrome = {
    runtime: {
      id: "a".repeat(32),
      getURL(path) { return `chrome-extension://${this.id}/${path}`; },
      onMessage: { addListener(listener) { listeners.push(listener); } },
    },
    tabs: { async query() { return Object.values(tabs); } },
    storage: {
      local: {
        async get(keys) { return Object.fromEntries(keys.filter((key) => key in stored).map((key) => [key, stored[key]])); },
        async set(values) { Object.assign(stored, values); },
        async remove(keys) { keys.forEach((key) => delete stored[key]); },
        setAccessLevel() {},
      },
    },
  };
  vm.runInNewContext(workerSource, { chrome, fetch: fetchImpl, URL, Response, btoa, TextEncoder, crypto: globalThis.crypto });
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

test("extension messages are accepted only from the built-in options page or popup", async () => {
  const worker = makeWorker();
  assert.deepEqual(await worker.message({ type: "status" }, { id: worker.chrome.runtime.id, url: "https://www.youtube.com/" }), { ignored: true });
  const popupSender = { id: worker.chrome.runtime.id, url: worker.chrome.runtime.getURL("popup/popup.html") };
  assert.equal((await worker.message({ type: "status" }, popupSender)).ok, true);
  assert.deepEqual(await worker.message({ type: "revoke" }, popupSender), { ignored: true });
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

test("a restarted service worker reuses persisted credentials and revalidates them with the backend", async () => {
  const stored = {
    focusRewardsExtensionToken: "T".repeat(43), focusRewardsExtensionExpiresAt: Date.now() + 60_000,
    focusRewardsConvexSiteUrl: "https://focus.convex.site",
  };
  let requests = 0;
  const fetchImpl = async () => { requests += 1; return response({ email: "owner@example.com", expiresAt: stored.focusRewardsExtensionExpiresAt }); };
  const first = makeWorker({ stored, fetchImpl });
  const second = makeWorker({ stored, fetchImpl });
  assert.equal((await first.message({ type: "status" })).signedIn, true);
  assert.equal((await second.message({ type: "status" })).signedIn, true);
  assert.equal(requests, 2);
});

test("locally expired credentials are removed without presenting an authenticated state", async () => {
  const stored = { focusRewardsExtensionToken: "T".repeat(43), focusRewardsExtensionExpiresAt: Date.now() - 1, focusRewardsConvexSiteUrl: "https://focus.convex.site" };
  const worker = makeWorker({ stored, fetchImpl: async () => { throw new Error("should not request"); } });
  assert.equal((await worker.message({ type: "status" })).signedIn, false);
  assert.equal(stored.focusRewardsExtensionToken, undefined);
});

test("network failure preserves credentials while server denial removes revoked credentials", async () => {
  const stored = { focusRewardsExtensionToken: "T".repeat(43), focusRewardsExtensionExpiresAt: Date.now() + 60_000, focusRewardsConvexSiteUrl: "https://focus.convex.site" };
  const network = makeWorker({ stored, fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal((await network.message({ type: "status" })).kind, "network");
  assert.equal(typeof stored.focusRewardsExtensionToken, "string");
  const denied = makeWorker({ stored, fetchImpl: async () => response({}, 401) });
  assert.equal((await denied.message({ type: "status" })).signedIn, false);
  assert.equal(stored.focusRewardsExtensionToken, undefined);
});

test("bearer credential is used for online validation and explicit server revocation", async () => {
  const token = "T".repeat(43);
  const stored = { focusRewardsExtensionToken: token, focusRewardsExtensionExpiresAt: Date.now() + 60_000, focusRewardsConvexSiteUrl: "https://focus.convex.site" };
  const calls = [];
  const worker = makeWorker({ stored, fetchImpl: async (url, init) => { calls.push({ url, init }); return response({ email: "owner@example.com" }); } });
  await worker.message({ type: "status" });
  await worker.message({ type: "revoke" });
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${token}`);
  assert.equal(calls[1].init.method, "DELETE");
  assert.equal(stored.focusRewardsExtensionToken, undefined);
});

test("explicit logout retains the credential when revocation fails and clears it after confirmed success", async () => {
  const stored = { focusRewardsExtensionToken: "T".repeat(43), focusRewardsExtensionExpiresAt: Date.now() + 60_000, focusRewardsConvexSiteUrl: "https://focus.convex.site" };
  const worker = makeWorker({ stored, fetchImpl: async () => response({}, 503) });
  assert.equal((await worker.message({ type: "revoke" })).kind, "network");
  assert.equal(typeof stored.focusRewardsExtensionToken, "string");
  const confirmed = makeWorker({ stored, fetchImpl: async () => response({}) });
  assert.equal((await confirmed.message({ type: "revoke" })).revoked, true);
  assert.equal(stored.focusRewardsExtensionToken, undefined);
});

test("pricing rates are read from the authenticated server and flexible usage stays disabled", async () => {
  const stored = { focusRewardsExtensionToken: "T".repeat(43), focusRewardsExtensionExpiresAt: Date.now() + 60_000, focusRewardsConvexSiteUrl: "https://focus.convex.site" };
  const worker = makeWorker({ stored, fetchImpl: async () => response({ standardCoinsPerMinute: 1.2, shortsCoinsPerMinute: 1.4, flexibleCoinsPerMinute: 1.6, flexibleUsageEnabled: true }) });
  const sender = { id: worker.chrome.runtime.id, url: worker.chrome.runtime.getURL("popup/popup.html") };
  const result = await worker.message({ type: "youtube-pricing-rates" }, sender);
  assert.equal(result.ok, true);
  assert.equal(result.flexibleUsageEnabled, false);
  assert.equal(stored.focusRewardsYouTubePricingRates.flexibleUsageEnabled, false);
});

test("standard video purchase retries reuse the saved transaction key after a lost response", async () => {
  const stored = { focusRewardsExtensionToken: "T".repeat(43), focusRewardsExtensionExpiresAt: Date.now() + 60_000, focusRewardsConvexSiteUrl: "https://focus.convex.site" };
  const keys = [];
  let statusCode = 503;
  const fetchImpl = async (_url, init) => {
    keys.push(JSON.parse(init.body).idempotencyKey);
    return statusCode === 503 ? response({ error: "temporarily unavailable" }, 503) : response({ success: true, price: 3, expiresAt: Date.now() + 60_000 });
  };
  const worker = makeWorker({ stored, fetchImpl });
  const sender = { id: worker.chrome.runtime.id, url: "https://www.youtube.com/watch?v=abcdefghijk", tab: { id: 2 } };
  const purchase = { type: "youtube-purchase", videoId: "abcdefghijk", contentType: "youtube_video", durationSeconds: 60, quoteId: "quote-id", idempotencyKey: "caller-key-00000001" };
  assert.equal((await worker.message(purchase, sender)).kind, "network");
  statusCode = 200;
  assert.equal((await worker.message({ ...purchase, idempotencyKey: "caller-key-00000002" }, sender)).ok, true);
  assert.equal(keys[0], keys[1]);
});

test("Shorts purchase retries reuse the same durable idempotency key until the server confirms the result", async () => {
  const stored = { focusRewardsExtensionToken: "T".repeat(43), focusRewardsExtensionExpiresAt: Date.now() + 60_000, focusRewardsConvexSiteUrl: "https://focus.convex.site" };
  const keys = [];
  let statusCode = 503;
  const worker = makeWorker({ stored, fetchImpl: async (_url, init) => {
    keys.push(JSON.parse(init.body).idempotencyKey);
    return statusCode === 503 ? response({ error: "temporarily unavailable" }, 503) : response({ success: true, price: 3, expiresAt: Date.now() + 60_000 });
  } });
  const sender = { id: worker.chrome.runtime.id, url: "https://www.youtube.com/shorts/abcdefghijk", tab: { id: 4 } };
  assert.equal((await worker.message({ type: "youtube-shorts-time", minutes: 5, idempotencyKey: "caller-key-00000001" }, sender)).kind, "network");
  assert.equal(stored.focusRewardsPendingShortsPurchase.idempotencyKey, keys[0]);
  assert.equal((await worker.message({ type: "youtube-shorts-time", minutes: 10, idempotencyKey: "caller-key-00000002" }, sender)).kind, "pending-purchase");
  statusCode = 200;
  const retry = await worker.message({ type: "youtube-shorts-time", minutes: 5, idempotencyKey: "caller-key-00000003" }, sender);
  assert.equal(retry.ok, true);
  assert.equal(keys[0], keys[1]);
  assert.equal(stored.focusRewardsPendingShortsPurchase, undefined);
});

test("flexible start retries after service-worker restart reuse the durable operation keys", async () => {
  const stored = {
    focusRewardsExtensionToken: "T".repeat(43),
    focusRewardsExtensionExpiresAt: Date.now() + 60_000,
    focusRewardsConvexSiteUrl: "https://focus.convex.site",
  };
  const requestBodies = [];
  let statusCode = 503;
  const fetchImpl = async (_url, init) => {
    requestBodies.push(JSON.parse(init.body));
    return statusCode === 503
      ? response({ error: "temporarily unavailable" }, 503)
      : response({ sessionId: "session-id", ownerTabId: 12, status: "active", sequence: 1, ownershipEpoch: 1,
        latestOperationKey: requestBodies.at(-1).operationKey, leaseStartedAt: Date.now(), leaseExpiresAt: Date.now() + 10_000,
        authorizedMs: 0, chargedCoins: 0, reservedCoins: 1, availableCoins: 9, rateCoinsPerMinute: 1.6, serverTime: Date.now() });
  };
  const sender = { id: "a".repeat(32), url: "https://www.youtube.com/shorts/abcdefghijk", tab: { id: 12 } };
  const beforeRestart = makeWorker({ stored, fetchImpl });
  const first = await beforeRestart.message({ type: "youtube-flexible-start" }, sender);
  assert.equal(first.kind, "network");
  const pending = structuredClone(stored.focusRewardsFlexibleUsagePending["12"]);
  assert.equal(typeof pending.startKey, "string");
  assert.equal(typeof pending.operationKey, "string");
  assert.match(pending.recoveryToken, /^[a-f0-9]{64}$/);

  statusCode = 200;
  const afterRestart = makeWorker({ stored, fetchImpl });
  const retry = await afterRestart.message({ type: "youtube-flexible-start" }, sender);
  assert.equal(retry.ok, true);
  assert.deepEqual(requestBodies[0], requestBodies[1]);
  assert.equal(requestBodies[1].startKey, pending.startKey);
  assert.equal(requestBodies[1].operationKey, pending.operationKey);
  assert.equal(stored.focusRewardsFlexibleUsagePending["12"], undefined);
  assert.equal(stored.focusRewardsFlexibleUsageState["12"].sessionId, "session-id");
});

test("a flexible state request after restart recovers the server lease without inventing one", async () => {
  const stored = {
    focusRewardsExtensionToken: "T".repeat(43),
    focusRewardsExtensionExpiresAt: Date.now() + 60_000,
    focusRewardsConvexSiteUrl: "https://focus.convex.site",
    focusRewardsFlexibleUsagePending: { "12": { type: "youtube-flexible-start", ownerTabId: 12, siteUrl: "https://focus.convex.site", startKey: "durable-start-key-00000001", operationKey: "durable-start-operation-01", recoveryToken: "a".repeat(64) } },
  };
  const requests = [];
  const worker = makeWorker({ stored, fetchImpl: async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith("/flexible/state")) return response({ session: { sessionId: "session-id", ownerTabId: 12, ownershipEpoch: 1,
      status: "active", sequence: 1, latestOperationKey: "durable-start-operation-01", leaseExpiresAt: Date.now() + 10_000,
      chargedCoins: 0, reservedCoins: 1 }, activeElsewhere: true, rateCoinsPerMinute: 1.6, serverTime: Date.now() });
    return response({ sessionId: "session-id", ownerTabId: 99, ownershipEpoch: 2, status: "active", sequence: 1, recovered: true,
      latestOperationKey: JSON.parse(init.body).operationKey, leaseExpiresAt: Date.now() + 10_000, chargedCoins: 0,
      reservedCoins: 1, availableCoins: 9, rateCoinsPerMinute: 1.6, serverTime: Date.now() });
  } });
  const sender = { id: worker.chrome.runtime.id, url: "https://www.youtube.com/shorts/abcdefghijk", tab: { id: 99 } };
  const result = await worker.message({ type: "youtube-flexible-state" }, sender);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.recovered, true);
  assert.equal(result.ownershipEpoch, 2);
  assert.equal(requests[0].url, "https://focus.convex.site/extension/youtube/flexible/state");
  assert.equal(requests[1].url, "https://focus.convex.site/extension/youtube/flexible/recover");
  assert.equal(JSON.parse(requests[1].init.body).expectedEpoch, 1);
  assert.equal(JSON.parse(requests[1].init.body).recoveryToken, "a".repeat(64));
  assert.equal(requests[1].init.headers.Authorization, "Bearer " + "T".repeat(43));
  assert.equal(stored.focusRewardsFlexibleUsagePending.recovery, undefined);
  assert.equal(stored.focusRewardsFlexibleUsageOwner.ownerTabId, 99);
  assert.equal(stored.focusRewardsFlexibleUsageState["99"].sessionId, "session-id");
});

test("a lost recovery response survives service-worker restart and retries the same fenced operation", async () => {
  const recovery = { siteUrl: "https://focus.convex.site", ownerTabId: 99, type: "youtube-flexible-recover",
    sessionId: "session-id", expectedEpoch: 1, recoveryToken: "c".repeat(64), operationKey: "recovery-operation-stable-0001" };
  const stored = {
    focusRewardsExtensionToken: "T".repeat(43),
    focusRewardsExtensionExpiresAt: Date.now() + 60_000,
    focusRewardsConvexSiteUrl: "https://focus.convex.site",
    focusRewardsFlexibleUsageOwner: { siteUrl: "https://focus.convex.site", ownerTabId: 12, sessionId: "session-id",
      ownershipEpoch: 1, recoveryToken: recovery.recoveryToken },
    focusRewardsFlexibleUsagePending: { recovery },
  };
  const bodies = [];
  let recoveryCommitted = false;
  let loseFirstResponse = true;
  const fetchImpl = async (url, init) => {
    if (url.endsWith("/flexible/recover")) {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (loseFirstResponse) {
        loseFirstResponse = false;
        recoveryCommitted = true;
        return response({ error: "response lost after commit" }, 503);
      }
      assert.equal(recoveryCommitted, true);
      return response({ sessionId: "session-id", ownerTabId: 99, ownershipEpoch: 2, status: "active", sequence: 1,
        latestOperationKey: body.operationKey, leaseExpiresAt: Date.now() + 8_000, chargedCoins: 0, reservedCoins: 1,
        availableCoins: 9, rateCoinsPerMinute: 1.6, serverTime: Date.now(), recovered: true });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const sender = { id: "a".repeat(32), url: "https://www.youtube.com/shorts/abcdefghijk", tab: { id: 99 } };
  const beforeRestart = makeWorker({ stored, fetchImpl });
  const first = await beforeRestart.message({ type: "youtube-flexible-state" }, sender);
  assert.equal(first.kind, "network");
  const durableOperation = structuredClone(stored.focusRewardsFlexibleUsagePending.recovery);
  assert.equal(durableOperation.operationKey, recovery.operationKey);

  const afterRestart = makeWorker({ stored, fetchImpl });
  const result = await afterRestart.message({ type: "youtube-flexible-state" }, sender);
  assert.equal(result.ok, true);
  assert.equal(result.recovered, true);
  assert.equal(result.ownershipEpoch, 2);
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0], bodies[1]);
  assert.equal(bodies[1].operationKey, recovery.operationKey);
  assert.equal(bodies[1].expectedEpoch, 1);
  assert.equal(bodies[1].sessionId, "session-id");
  assert.equal(stored.focusRewardsFlexibleUsagePending.recovery, undefined);
  assert.equal(stored.focusRewardsFlexibleUsageOwner.ownershipEpoch, 2);
  assert.equal(stored.focusRewardsFlexibleUsageState["99"].sessionId, "session-id");
});

test("pairing accepts only trusted hosted Convex or the exact local Convex site origin", async () => {
  const worker = makeWorker({ fetchImpl: async (url) => {
    assert.equal(url, "http://127.0.0.1:3211/extension/redeem");
    return response({ token: "L".repeat(43), expiresAt: Date.now() + 60_000, email: "local@example.com" });
  } });
  const code = "c".repeat(32);
  assert.equal((await worker.message({ type: "pair", siteUrl: "http://127.0.0.1:3212", code })).kind, "input");
  assert.equal((await worker.message({ type: "pair", siteUrl: "http://untrusted.localhost:3211", code })).kind, "input");
  assert.equal((await worker.message({ type: "pair", siteUrl: "http://focus.convex.site", code })).kind, "input");
  assert.equal((await worker.message({ type: "pair", siteUrl: "https://attacker.example/", code })).kind, "input");
  assert.equal((await worker.message({ type: "pair", siteUrl: "https://focus.convex.site", code: "short" })).kind, "input");
  const paired = await worker.message({ type: "pair", siteUrl: "http://127.0.0.1:3211", code });
  assert.equal(paired.ok, true);
  assert.equal(worker.stored.focusRewardsConvexSiteUrl, "http://127.0.0.1:3211");
});
