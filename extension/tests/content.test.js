import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const pricingSource = await readFile(new URL("../src/pricing.js", import.meta.url), "utf8");
const contentSource = await readFile(new URL("../src/content.js", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));

function registerListener(listeners, key, callback) {
  listeners.registrationCounts ??= {};
  listeners.registrationCounts[key] = (listeners.registrationCounts[key] ?? 0) + 1;
  const previous = listeners[key];
  listeners[key] = previous ? (...args) => { previous(...args); callback(...args); } : callback;
}

function loadContentScript(document, storage = {}, listeners = {}, responseByType = {}, clock = {}) {
  let pathname = "/feed/home";
  let videoId = null;
  let timerId = 0;
  const window = {
    setTimeout(callback, delay = 0) { const id = ++timerId; listeners.timeouts ??= new Map(); listeners.timeouts.set(id, callback); if (delay <= 120) queueMicrotask(callback); return id; },
    clearTimeout(id) { listeners.timeouts?.delete(id); },
    setInterval(callback) { const id = ++timerId; listeners.intervals ??= new Map(); listeners.intervals.set(id, callback); return id; },
    clearInterval(id) { listeners.intervals?.delete(id); },
    addEventListener(type, callback) { registerListener(listeners, `window:${type}`, callback); },
    FocusRewardsPricing: undefined,
    open() {},
    innerWidth: 1200,
  };
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        if (message.type in responseByType) callback(typeof responseByType[message.type] === "function" ? responseByType[message.type](message) : responseByType[message.type]);
        else if (message.type === "youtube-quote") callback({ ok: true, quoteId: "quote-1", price: 12, rateCoinsPerMinute: 1.2, entitlementHours: 18 });
        else if (message.type === "youtube-pricing-rates") callback({ ok: true, standardCoinsPerMinute: 1.2, shortsCoinsPerMinute: 1.4, flexibleCoinsPerMinute: 1.6, flexibleUsageEnabled: false });
        else callback({ ok: true, signedIn: false });
      },
      getURL(path) { return `chrome-extension://extension-id/${path}`; },
    },
    storage: {
      sync: { get(defaults, callback) { callback({ ...defaults, ...storage }); } },
      onChanged: { addListener(callback) { registerListener(listeners, "storage", callback); } },
    },
  };
  const context = vm.createContext({
    window,
    document,
    chrome,
    location: { get pathname() { return pathname; }, get href() { return `https://www.youtube.com${pathname === "/watch" ? `?v=${videoId}` : pathname.startsWith("/shorts/") ? pathname : "/feed/home"}`; }, origin: "https://www.youtube.com" },
    URL,
    Date: clock.Date ?? Date,
    crypto: globalThis.crypto,
    MutationObserver: class {
      constructor(callback) { this.callback = callback; listeners.mutationObserver = callback; listeners.observerCount = (listeners.observerCount ?? 0) + 1; }
      observe() {}
    },
  });
  vm.runInContext(pricingSource, context);
  window.FocusRewardsPricing = context.FocusRewardsPricing;
  vm.runInContext(contentSource, context);
  return { listeners, setLocation(nextPath, nextVideoId) { pathname = nextPath; videoId = nextVideoId; } };
}

class FakeBadge {
  constructor(tag = "span") {
    this.tag = tag;
    this.children = [];
    this.className = "";
    this.textContent = "";
    this.dataset = {};
    this.attributes = {};
    this.parentElement = null;
    this.nextElementSibling = null;
    this.isConnected = true;
  }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key] ?? null; }
  remove() { this.isConnected = false; this.parentElement = null; if (this.parentNode?.children) this.parentNode.children = this.parentNode.children.filter((child) => child !== this); }
  replaceChildren(...children) { this.children = children; }
  append(...children) { this.children.push(...children); }
  insertBefore(child, reference) { const index = this.children.indexOf(reference); this.children.splice(index < 0 ? this.children.length : index, 0, child); }
  querySelector(selector) {
    if (selector.startsWith("button")) return this.children.find((node) => node.tag === "button" && (!selector.includes(":not") || node.className !== "fr-youtube-cancel")) ?? null;
    return this.children.find((node) => node.className === "fr-youtube-message") ?? null;
  }
  querySelectorAll() { return []; }
  addEventListener(type, callback) { this[`on${type}`] = callback; }
  focus() { this.focused = true; }
}

function makeCard({ duration = "5:00", href = "/watch?v=regular", live = false } = {}) {
  const menu = { parentElement: null };
  const row = {
    children: [],
    insertBefore(badge, reference) {
      const existingIndex = this.children.indexOf(badge);
      if (existingIndex >= 0) this.children.splice(existingIndex, 1);
      const index = this.children.indexOf(reference);
      this.children.splice(index < 0 ? 0 : index, 0, badge);
      badge.parentElement = this;
      badge.nextElementSibling = reference;
      badge.isConnected = true;
    },
  };
  menu.parentElement = row;
  row.children.push(menu);
  const durationNode = duration === null ? [] : [{ textContent: duration, getAttribute() { return ""; } }];
  if (live) durationNode.push({ textContent: "LIVE", getAttribute() { return ""; } });
  const links = [{ href: `https://www.youtube.com${href}`, getAttribute() { return href; } }];

  const cardClasses = new Set();
  const card = {
    classList: { add(name) { cardClasses.add(name); }, remove(name) { cardClasses.delete(name); }, contains(name) { return cardClasses.has(name); } },
    closest() { return null; },
    querySelector(selector) {
      if (selector === "ytd-menu-renderer") return menu;
      if (selector.includes('button[aria-label*="More"]') || selector.includes('button[aria-label*="Options"]')) return null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === ".fr-youtube-price") return row.children.filter((badge) => badge.className === "fr-youtube-price" && badge.isConnected);
      if (selector === "a[href]") return links;
      if (selector.includes("thumbnail-overlay-time-status") || selector.includes("badge-supported")) return durationNode;
      return [];
    },
  };
  return { card, row, cardClasses, get badgeList() { return row.children.filter((badge) => badge.className === "fr-youtube-price"); } };
}

function makeDocument(cards, listeners = {}, navigation = {}) {
  const body = {
    children: [],
    append(node) {
      this.children.push(node);
      node.parentElement = this;
      node.parentNode = this;
      node.isConnected = true;
      if (node.className === "fr-youtube-purchase") navigation.panel = node;
      else if (node.className === "fr-youtube-balance") navigation.balance = node;
      else if (node.className === "fr-youtube-brand") navigation.brand = node;
    },
    appendChild(node) { this.append(node); return node; },
  };
  const rootClasses = new Set();
  navigation.rootClasses = rootClasses;
  return {
    body,
    documentElement: { classList: { add(name) { rootClasses.add(name); }, remove(name) { rootClasses.delete(name); }, contains(name) { return rootClasses.has(name); } } },
    querySelector(selector) {
      if (selector === "ytd-watch-flexy") return navigation.onVideo ? { prepend(panel) { navigation.panel = panel; panel.isConnected = true; panel.parentElement = this; } } : null;
      if (selector === "ytd-shorts" || selector === "ytd-reel-video-renderer") return navigation.onShorts ? { prepend(panel) { navigation.panel = panel; panel.isConnected = true; panel.parentElement = this; } } : null;
      if (selector === "#center") return navigation.searchArea;
      if (selector === "#search") return navigation.searchForm;
      if (selector === ".fr-youtube-balance") return navigation.balance?.isConnected ? navigation.balance : null;
      if (selector === ".fr-youtube-brand") return navigation.brand?.isConnected ? navigation.brand : null;
      if (selector === ".ytp-time-duration") return navigation.onVideo ? { get textContent() { return navigation.duration; } } : null;
      if (selector === ".fr-youtube-purchase") return navigation.panel?.isConnected ? navigation.panel : null;
      if (selector === "ytd-player video.html5-main-video") return null;
      if (selector === "#end #buttons" || selector === "ytd-masthead #end") return navigation.nav;
      if (selector === "#center #search") return navigation.searchForm;
      if (selector === "ytd-masthead #center") return navigation.searchArea;
      return null;
    },
    createElement(tag) { return new FakeBadge(tag); },
    querySelectorAll(selector) {
      if (selector === "ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer") return cards;
      if (selector === ".fr-youtube-purchase") return navigation.panel?.isConnected ? [navigation.panel] : [];
      if (selector === ".fr-youtube-reminder") return body.children.filter((node) => node.className === "fr-youtube-reminder" && node.isConnected);
      if (selector === ".fr-youtube-purchase, .fr-youtube-balance, .fr-youtube-brand") return [navigation.panel, navigation.balance, navigation.brand].filter((node) => node?.isConnected);
      if (selector === ".fr-youtube-price") return cards.flatMap((card) => card.querySelectorAll(selector));
      return [];
    },
    addEventListener(type, callback) { registerListener(listeners, `document:${type}`, callback); },
  };
}

test("injects YouTube content only on YouTube and limits backend hosts to Convex sites", () => {
  assert.deepEqual(manifest.content_scripts.flatMap((script) => script.matches), ["https://www.youtube.com/*"]);
  assert.deepEqual(manifest.host_permissions, ["https://www.youtube.com/*", "https://*.convex.site/*"]);
});

test("adds one estimate in the options row and remains duplicate-safe after repeated scans", async () => {
  const video = makeCard();
  const listeners = {};
  const document = makeDocument([video.card], listeners);
  loadContentScript(document, {}, listeners);
  await new Promise((resolve) => setImmediate(resolve));
  listeners.mutationObserver([]);
  await new Promise((resolve) => setImmediate(resolve));
  const badges = video.badgeList.filter((badge) => badge.isConnected);
  assert.equal(badges.length, 1);
  assert.equal(badges[0].textContent, "◈ 6 Coins");
  assert.equal(badges[0].parentElement, video.row);
  assert.equal(badges[0].nextElementSibling, video.row.children.at(-1));
  assert.match(badges[0].getAttribute("title"), /Geschätzter Wert/);
  assert.equal(video.badgeList.filter((badge) => badge.isConnected).length, 1);
});

test("updates incrementally loaded cards and supports YouTube SPA navigation", async () => {
  const cards = [];
  const listeners = {};
  const navigation = { onVideo: false, duration: "10:00" };
  const document = makeDocument(cards, listeners, navigation);
  const content = loadContentScript(document, {}, listeners);
  content.setLocation("/watch", "abcdefghijk");
  navigation.onVideo = true;
  const first = makeCard({ duration: "10:00" });
  cards.push(first.card);
  listeners["window:popstate"]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(first.badgeList.filter((badge) => badge.isConnected)[0].textContent, "◈ 12 Coins");
  const next = makeCard({ duration: "15:00" });
  cards.push(next.card);
  listeners.mutationObserver([]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(next.badgeList.filter((badge) => badge.isConnected)[0].textContent, "◈ 18 Coins");
  navigation.duration = "20:00";
  const navigated = makeCard({ duration: "20:00" });
  cards.push(navigated.card);
  listeners["document:yt-navigate-finish"]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(navigated.badgeList.filter((badge) => badge.isConnected)[0].textContent, "◈ 24 Coins");
});

test("uses separate rates, hides Shorts cards on browsing surfaces, and leaves standard videos visible", async () => {
  const regular = makeCard({ duration: "5:00", href: "/watch?v=abcdefghijk" });
  const short = makeCard({ duration: "5:00", href: "/shorts/abcdefghijk" });
  const listeners = {};
  loadContentScript(makeDocument([regular.card, short.card], listeners), {}, listeners);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(regular.badgeList.find((badge) => badge.isConnected)?.textContent, "◈ 6 Coins");
  assert.equal(short.badgeList.find((badge) => badge.isConnected)?.textContent, "◈ 7 Coins");
  assert.equal(regular.cardClasses.has("fr-youtube-filtered-short"), false);
  assert.equal(short.cardClasses.has("fr-youtube-filtered-short"), true);
});

test("omits unknown-duration and live cards and removes stale badges", () => {
  const document = makeDocument([]);
  const cards = [makeCard({ document, duration: null }), makeCard({ document, href: "/shorts/clip", duration: "0:30" }), makeCard({ document, live: true, duration: "LIVE" })];
  const cardsDocument = makeDocument(cards.map((item) => item.card));
  loadContentScript(cardsDocument);
  assert.ok(cards.every((item) => item.badgeList.filter((badge) => badge.isConnected).length === 0));
});

test("renders the inline purchase panel on watch and Shorts routes, reopens after dismissal, and stays absent on the homepage", async () => {
  const listeners = {};
  const navigation = { onVideo: false, duration: "5:00", panel: null };
  const document = makeDocument([], listeners, navigation);
  const content = loadContentScript(document, {}, listeners);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(document.querySelector(".fr-youtube-purchase"), null);

  content.setLocation("/watch", "abcdefghijk");
  navigation.onVideo = true;
  listeners["document:yt-navigate-finish"]();
  await new Promise((resolve) => setImmediate(resolve));
  const watchPanel = document.querySelector(".fr-youtube-purchase");
  assert.ok(watchPanel);
  assert.equal(watchPanel.dataset.contentKey, "youtube_video:abcdefghijk");
  assert.equal(watchPanel.querySelector("button").textContent, "Konto verbinden");
  assert.ok(watchPanel.children.some((child) => child.className === "fr-youtube-cancel"));
  assert.ok(watchPanel.children.some((child) => child.className === "fr-youtube-video-title"));

  watchPanel.remove();
  listeners["window:popstate"]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(document.querySelector(".fr-youtube-purchase"));

  content.setLocation("/shorts/lmnopqrstuv", "lmnopqrstuv");
  navigation.panel = null;
  navigation.onVideo = false;
  navigation.onShorts = true;
  navigation.duration = "0:30";
  listeners["document:yt-navigate-finish"]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(document.querySelector(".fr-youtube-purchase")?.dataset.contentKey, "youtube_short:lmnopqrstuv");
  assert.equal(listeners.registrationCounts["document:yt-navigate-finish"], 1);
  assert.equal(listeners.registrationCounts["window:popstate"], 1);
  assert.equal(listeners.observerCount, 1);
});

test("rechecks a transient entitlement network failure before allowing a purchase", async () => {
  const listeners = {};
  const navigation = { onVideo: true, duration: "5:00", panel: null };
  const document = makeDocument([], listeners, navigation);
  let entitlementCalls = 0;
  const content = loadContentScript(document, {}, listeners, {
    status: { ok: true, signedIn: true, email: "member@example.com" },
    "youtube-pricing-rates": { ok: true, standardCoinsPerMinute: 1.2, shortsCoinsPerMinute: 1.4, flexibleCoinsPerMinute: 1.6 },
    "youtube-balance": { ok: true, coins: 50, shortsExpiresAt: null },
    "youtube-entitlement": () => {
      entitlementCalls += 1;
      return entitlementCalls === 1 ? { ok: false, kind: "network" } : { ok: true, unlocked: false };
    },
    "youtube-quote": { ok: true, quoteId: "quote-1", price: 6, rateCoinsPerMinute: 1.2, entitlementHours: 18 },
  });
  content.setLocation("/watch", "abcdefghijk");
  listeners["document:yt-navigate-finish"]();
  await new Promise((resolve) => setImmediate(resolve));
  const panel = document.querySelector(".fr-youtube-purchase");
  const action = panel.children.find((child) => child.tag === "button" && child.className !== "fr-youtube-cancel");
  assert.equal(panel.dataset.entitlementError, "network");
  assert.equal(action.textContent, "Zugang erneut prüfen");
  await action.onclick();
  assert.equal(entitlementCalls, 2);
  assert.equal(action.textContent, "Für 6 Coins freischalten · 18 Stunden");
  assert.equal(document.documentElement.classList.contains("fr-youtube-blocked"), true);
});

test("remains blocked while entitlement confirmation is unavailable", async () => {
  const listeners = {};
  const navigation = { onVideo: true, duration: "5:00", panel: null };
  const document = makeDocument([], listeners, navigation);
  const content = loadContentScript(document, {}, listeners, {
    status: { ok: true, signedIn: true },
    "youtube-pricing-rates": { ok: true, standardCoinsPerMinute: 1.2, shortsCoinsPerMinute: 1.4, flexibleCoinsPerMinute: 1.6 },
    "youtube-balance": { ok: true, coins: 50, shortsExpiresAt: null },
    "youtube-entitlement": { ok: false, kind: "network" },
    "youtube-quote": { ok: true, quoteId: "quote-1", price: 6, rateCoinsPerMinute: 1.2, entitlementHours: 18 },
  });
  content.setLocation("/watch", "abcdefghijk");
  listeners["document:yt-navigate-finish"]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(navigation.rootClasses.has("fr-youtube-blocked"), true);
  assert.match(document.querySelector(".fr-youtube-purchase")?.children.find((child) => child.className === "fr-youtube-message")?.textContent ?? "", /Wiedergabe bleibt gesperrt/);
});

test("keeps a standard video blocked until its entitlement is confirmed by the server", async () => {
  const listeners = {};
  const navigation = { onVideo: true, duration: "5:00", panel: null };
  const document = makeDocument([], listeners, navigation);
  const content = loadContentScript(document, {}, listeners, {
    status: { ok: true, signedIn: true, email: "member@example.com" },
    "youtube-pricing-rates": { ok: true, standardCoinsPerMinute: 1.2, shortsCoinsPerMinute: 1.4, flexibleCoinsPerMinute: 1.6, flexibleUsageEnabled: false },
    "youtube-balance": { ok: true, coins: 50, shortsExpiresAt: null },
    "youtube-entitlement": { ok: true, unlocked: false },
    "youtube-quote": { ok: true, quoteId: "quote-1", price: 6, rateCoinsPerMinute: 1.2, entitlementHours: 18 },
  });
  content.setLocation("/watch", "abcdefghijk");
  listeners["document:yt-navigate-finish"]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(navigation.rootClasses.has("fr-youtube-blocked"), true);
  assert.equal(document.querySelector(".fr-youtube-purchase")?.dataset.contentKey, "youtube_video:abcdefghijk");
  assert.equal(document.querySelector(".fr-youtube-purchase")?.getAttribute("role"), "dialog");
});

test("shows one reminder at each ten minutes of Shorts playback without resetting across Short navigation", async () => {
  const listeners = {};
  const now = Date.now();
  const navigation = { onShorts: true, duration: "0:30", panel: null, player: { currentTime: 600, paused: false, style: {} } };
  const document = makeDocument([], listeners, navigation);
  document.hidden = false;
  const originalQuerySelector = document.querySelector.bind(document);
  document.querySelector = (query) => {
    if (query === "video.html5-main-video") return navigation.player;
    return originalQuerySelector(query);
  };
  const clockNow = { value: now };
  class FakeDate extends Date { static now() { return clockNow.value; } }
  const content = loadContentScript(document, {}, listeners, {
    status: { ok: true, signedIn: true, email: "member@example.com" },
    "youtube-pricing-rates": { ok: true, standardCoinsPerMinute: 1.2, shortsCoinsPerMinute: 1.4, flexibleCoinsPerMinute: 1.6 },
    "youtube-balance": { ok: true, coins: 50, shortsExpiresAt: null, serverTime: now },
    "youtube-entitlement": { ok: true, unlocked: true, expiresAt: now + 60 * 60_000, serverTime: now },
  }, { Date: FakeDate });
  content.setLocation("/shorts/abcdefghijk", "abcdefghijk");
  listeners["document:yt-navigate-finish"]();
  await new Promise((resolve) => setImmediate(resolve));
  let intervalCallback = [...listeners.intervals.values()][0];
  assert.equal(typeof intervalCallback, "function");
  intervalCallback();
  assert.equal(document.querySelectorAll(".fr-youtube-reminder").length, 0);
  clockNow.value = now + 10 * 60_000;
  intervalCallback();
  assert.equal(document.querySelectorAll(".fr-youtube-reminder").length, 1);
  content.setLocation("/shorts/lmnopqrstuv", "lmnopqrstuv");
  navigation.panel = null;
  listeners["document:yt-navigate-finish"]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(listeners.intervals.size, 1);
  intervalCallback = [...listeners.intervals.values()][0];
  clockNow.value += 5_000;
  intervalCallback();
  assert.equal(document.querySelectorAll(".fr-youtube-reminder").length, 1);
});

test("allows playback only after the server confirms an active entitlement", async () => {
  const listeners = {};
  const navigation = { onShorts: true, duration: "0:30", panel: null };
  const document = makeDocument([], listeners, navigation);
  const content = loadContentScript(document, {}, listeners, {
    status: { ok: true, signedIn: true, email: "member@example.com" },
    "youtube-pricing-rates": { ok: true, standardCoinsPerMinute: 1.2, shortsCoinsPerMinute: 1.4, flexibleCoinsPerMinute: 1.6 },
    "youtube-balance": { ok: true, coins: 50, shortsExpiresAt: null, serverTime: Date.now() },
    "youtube-entitlement": { ok: true, unlocked: true, expiresAt: Date.now() + 300_000, serverTime: Date.now() },
  });
  content.setLocation("/shorts/abcdefghijk", "abcdefghijk");
  listeners["document:yt-navigate-finish"]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(navigation.rootClasses.has("fr-youtube-blocked"), false);
  assert.equal(document.querySelector(".fr-youtube-purchase"), null);
});

test("preference changes remove estimates and prevent rescanning until enabled", async () => {
  const video = makeCard();
  const document = makeDocument([video.card]);
  const { listeners } = loadContentScript(document);
  await new Promise((resolve) => setImmediate(resolve));
  listeners.storage({ youtubePriceIndicatorEnabled: { newValue: false } }, "sync");
  assert.equal(video.badgeList.filter((badge) => badge.isConnected).length, 0);
  listeners["window:popstate"]();
  assert.equal(video.badgeList.filter((badge) => badge.isConnected).length, 0);
  listeners.storage({ youtubePriceIndicatorEnabled: { newValue: true } }, "sync");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(video.badgeList.filter((badge) => badge.isConnected).length, 1);
});
