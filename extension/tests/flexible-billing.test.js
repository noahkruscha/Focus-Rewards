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
  async function message(value, sender = { id: chrome.runtime.id, url: "https://www.youtube.com/shorts/abcdefghijk", tab: { id: 12 } }) {
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

function localCredential() {
  return {
    focusRewardsExtensionToken: "T".repeat(43),
    focusRewardsExtensionExpiresAt: Date.now() + 60_000,
    focusRewardsConvexSiteUrl: "http://127.0.0.1:3211",
  };
}

test("local flexible pricing opt-in is accepted only for exact loopback Convex site URLs", async () => {
  const urls = ["http://127.0.0.1:3212", "http://evil.localhost:3211", "http://10.0.0.4:3211"];
  for (const siteUrl of urls) {
    const stored = { ...localCredential(), focusRewardsConvexSiteUrl: siteUrl };
    const worker = makeWorker({ stored, fetchImpl: async () => response({ flexibleUsageEnabled: true,
      standardCoinsPerMinute: 1.2, shortsCoinsPerMinute: 1.4, flexibleCoinsPerMinute: 1.6 }) });
    const result = await worker.message({ type: "youtube-pricing-rates" }, { id: worker.chrome.runtime.id,
      url: worker.chrome.runtime.getURL("popup/popup.html") });
    assert.equal(result.ok, false, `Unexpectedly accepted ${siteUrl}`);
  }

  const stored = localCredential();
  const worker = makeWorker({ stored, fetchImpl: async () => response({ flexibleUsageEnabled: true,
    standardCoinsPerMinute: 1.2, shortsCoinsPerMinute: 1.4, flexibleCoinsPerMinute: 1.6 }) });
  const local = await worker.message({ type: "youtube-pricing-rates" }, { id: worker.chrome.runtime.id,
    url: worker.chrome.runtime.getURL("popup/popup.html") });
  assert.equal(local.flexibleUsageEnabled, true);
});

test("concurrent flexible starts from tabs defer single-session enforcement to the atomic server", async () => {
  const stored = localCredential();
  const pendingResponses = [];
  const fetchImpl = (_url, init) => new Promise((resolve) => pendingResponses.push({ resolve, body: JSON.parse(init.body) }));
  const worker = makeWorker({ stored, fetchImpl });
  const senderOne = { id: worker.chrome.runtime.id, url: "https://www.youtube.com/shorts/abcdefghijk", tab: { id: 12 } };
  const senderTwo = { id: worker.chrome.runtime.id, url: "https://www.youtube.com/shorts/lmnopqrstuv", tab: { id: 24 } };
  const first = worker.message({ type: "youtube-flexible-start" }, senderOne);
  const second = worker.message({ type: "youtube-flexible-start" }, senderTwo);
  for (let attempt = 0; pendingResponses.length < 2 && attempt < 20; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(pendingResponses.length, 2);
  const winner = pendingResponses[0];
  winner.resolve(response({ sessionId: "session-1", ownerTabId: winner.body.ownerTabId, ownershipEpoch: 1, status: "active", sequence: 1,
    latestOperationKey: winner.body.operationKey, leaseStartedAt: Date.now(), leaseExpiresAt: Date.now() + 10_000,
    maxExpiresAt: Date.now() + 30 * 60_000, authorizedMs: 0, chargedCoins: 0, reservedCoins: 1,
    availableCoins: 9, rateCoinsPerMinute: 1.6, serverTime: Date.now(), flexibleUsageEnabled: true }));
  pendingResponses[1].resolve(response({ error: "Flexible session active in another tab." }, 409));
  const results = await Promise.all([first, second]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => result.kind === "rejected").length, 1);
  assert.equal(Object.keys(stored.focusRewardsFlexibleUsageState).length, 1);
});

test("flexible start control is user-triggered and the dashboard does not display an enabled tariff", async () => {
  const content = await readFile(new URL("../src/content.js", import.meta.url), "utf8");
  const dashboard = await readFile(new URL("../../src/pages/Dashboard.tsx", import.meta.url), "utf8");
  assert.match(content, /async function syncFlexibleState\(\{ allowCreate = false \} = \{\}\)/);
  assert.match(content, /if \(allowCreate && !state\.session && !state\.activeElsewhere\) await startFlexibleSession\(\)/);
  assert.match(content, /control\.addEventListener\("click", async \(\) => \{/);
  assert.match(dashboard, /flexibleRateInput/);
  assert.doesNotMatch(dashboard, /Flexible Usage.{0,80}(?:aktiviert|enabled)/i);
});
