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
        listeners.messages ??= [];
        listeners.messages.push(message);
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
    console,
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
    this.paused = true;
    this.listeners = {};
  }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key] ?? null; }
  remove() {
    this.isConnected = false;
    const parent = this.parentNode ?? this.parentElement;
    if (parent?.children) parent.children = parent.children.filter((child) => child !== this);
    this.parentElement = null;
    this.parentNode = null;
  }
  replaceChildren(...children) { this.children = children; }
  append(...children) { this.children.push(...children); }
  prepend(...children) { this.children.unshift(...children); }
  insertBefore(child, reference) { const index = this.children.indexOf(reference); this.children.splice(index < 0 ? this.children.length : index, 0, child); }
  querySelector(selector) {
    if (selector.startsWith("button")) return this.children.find((node) => node.tag === "button" && (!selector.includes(":not") || node.className !== "fr-youtube-cancel")) ?? null;
    return this.children.find((node) => node.className === "fr-youtube-message") ?? null;
  }
  querySelectorAll() { return []; }
  addEventListener(type, callback) { this[`on${type}`] = callback; this.listeners[type] = [...(this.listeners[type] ?? []), callback]; }
  dispatchEvent(type) { for (const callback of this.listeners[type] ?? []) callback({ target: this }); }
  focus() { this.focused = true; }
  play() { this.paused = false; this.playCalls = (this.playCalls ?? 0) + 1; return Promise.resolve(); }
  pause() { this.paused = true; this.pauseCalls = (this.pauseCalls ?? 0) + 1; }
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
      badge.parentNode = this;
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
      else if (node.className === "fr-youtube-playlist-total") navigation.playlistTotal = node;
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
      if (selector === "h1.ytd-watch-metadata") return navigation.title ? { textContent: navigation.title } : null;
      if (selector === "ytd-shorts") return navigation.onShorts ? { prepend(panel) { navigation.panel = panel; panel.isConnected = true; panel.parentElement = this; } } : null;
      if (selector === "ytd-reel-video-renderer") return navigation.onShorts ? { prepend(panel) { navigation.panel = panel; panel.isConnected = true; panel.parentElement = this; }, querySelector() { return navigation.player ?? null; }, getAttribute(name) { return name === "video-id" ? navigation.activeVideoId ?? null : null; } } : null;
      if (selector === "ytd-reel-video-renderer[is-active]") return navigation.activeRenderers?.[0] ?? (navigation.onShorts ? { prepend(panel) { navigation.panel = panel; panel.isConnected = true; panel.parentElement = this; }, querySelector() { return navigation.player ?? null; }, getAttribute(name) { return name === "video-id" ? navigation.activeVideoId ?? null : null; } } : null);
      if (selector === "ytd-reel-video-renderer[is-active] h2" || selector === "ytd-reel-video-renderer[is-active] #overlay h2") return null;
      if (selector === "#center") return navigation.searchArea;
      if (selector === "#search") return navigation.searchForm;
      if (selector === ".fr-youtube-balance") return navigation.balance?.isConnected ? navigation.balance : null;
      if (selector === ".fr-youtube-brand") return navigation.brand?.isConnected ? navigation.brand : null;
      if (selector === ".fr-youtube-playlist-total") return navigation.playlistTotal?.isConnected ? navigation.playlistTotal : navigation.playlistHeader?.children?.find((node) => node.className === "fr-youtube-playlist-total") ?? null;
      if (selector === ".ytp-time-duration") return navigation.onVideo ? { get textContent() { return navigation.duration; } } : null;
      if (selector === ".fr-youtube-purchase") return navigation.panel?.isConnected ? navigation.panel : null;
      if (selector === "ytd-player video.html5-main-video") return null;
      if (selector === "video.html5-main-video") return navigation.player ?? null;
      if (selector === "ytd-player #movie_player, ytd-shorts #movie_player, #shorts-player") return navigation.youtubePlayer ?? null;
      if (selector === "#end #buttons" || selector === "ytd-masthead #end") return navigation.nav;
      if (selector === "#center #search") return navigation.searchForm;
      if (selector === "ytd-masthead #center") return navigation.searchArea;
      return null;
    },
    createElement(tag) { return new FakeBadge(tag); },
    querySelectorAll(selector) {
      if (selector === "ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer, ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer, ytd-reel-shelf-renderer") return cards;
      if (selector === "video.html5-main-video, ytd-shorts video, ytd-reel-video-renderer[is-active] video, #shorts-player video, ytd-shorts #player-container video, ytd-reel-video-renderer[is-active] #player-container video") return navigation.players ?? (navigation.player ? [navigation.player] : []);
      if (selector === "video.html5-main-video, video") return navigation.shadowPlayers ?? [];
      if (selector === "#movie_player, #shorts-player") return navigation.shadowApis ?? [];
      if (selector === "*") return [];
      if (selector === "ytd-reel-video-renderer[is-active]") return navigation.activeRenderers ?? (navigation.onShorts && navigation.activeRenderer ? [navigation.activeRenderer] : navigation.player ? [{ querySelector() { return navigation.player; }, getAttribute(name) { return name === "video-id" ? navigation.activeVideoId ?? null : null; } }] : []);
      if (selector === "ytd-shorts, ytd-reel-video-renderer") return navigation.onShorts || navigation.hasReelRenderer ? [{}] : [];
      if (selector === "ytd-reel-video-renderer") return navigation.hasReelRenderer ? [{}] : [];
      if (selector === "ytd-player #movie_player, ytd-shorts #movie_player, #shorts-player") return navigation.youtubePlayer ?? null;
      if (selector === "#secondary") return navigation.onWatch ? {} : null;
      if (selector === ".fr-youtube-playlist-total") return navigation.playlistTotal?.isConnected ? navigation.playlistTotal : navigation.playlistHeader?.children?.find((node) => node.className === "fr-youtube-playlist-total") ?? null;
      if (selector === "ytd-playlist-header-renderer #primary") return navigation.playlistHeader ?? null;
      if (selector === "ytd-playlist-header-renderer #play-button, ytd-playlist-header-renderer #primary ytd-playlist-play-button-renderer, ytd-playlist-header-renderer #primary button") return navigation.playButton ?? null;
      if (selector === ".fr-youtube-purchase") return navigation.panel?.isConnected ? [navigation.panel] : [];
      if (selector === ".fr-youtube-reminder") return body.children.filter((node) => node.className === "fr-youtube-reminder" && node.isConnected);
      if (selector === ".fr-youtube-purchase, .fr-youtube-balance, .fr-youtube-brand") return [navigation.panel, navigation.balance, navigation.brand].filter((node) => node?.isConnected);
      if (selector === ".fr-youtube-price") return cards.flatMap((card) => card.querySelectorAll(selector));
      if (selector === ".fr-youtube-playlist-total") return navigation.playlistTotal?.isConnected ? [navigation.playlistTotal] : navigation.playlistHeader?.children?.filter((node) => node.className === "fr-youtube-playlist-total") ?? [];
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
  navigation.activeVideoId = "lmnopqrstuv";
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
  const navigation = { onShorts: true, duration: "0:30", panel: null, activeVideoId: "abcdefghijk", player: { currentTime: 600, paused: false, style: {} } };
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
  navigation.activeVideoId = "abcdefghijk";
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
  navigation.activeVideoId = "lmnopqrstuv";
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
  const navigation = { onShorts: true, duration: "0:30", panel: null, activeVideoId: "abcdefghijk" };
  const document = makeDocument([], listeners, navigation);
  const content = loadContentScript(document, {}, listeners, {
    status: { ok: true, signedIn: true, email: "member@example.com" },
    "youtube-pricing-rates": { ok: true, standardCoinsPerMinute: 1.2, shortsCoinsPerMinute: 1.4, flexibleCoinsPerMinute: 1.6 },
    "youtube-balance": { ok: true, coins: 50, shortsExpiresAt: Date.now() + 300_000, serverTime: Date.now() },
    "youtube-entitlement": { ok: true, unlocked: true, expiresAt: Date.now() + 300_000, serverTime: Date.now() },
  });
  content.setLocation("/shorts/abcdefghijk", "abcdefghijk");
  navigation.activeVideoId = "abcdefghijk";
  listeners["document:yt-navigate-finish"]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(navigation.rootClasses.has("fr-youtube-blocked"), false);
  assert.equal(document.querySelector(".fr-youtube-purchase"), null);
});

test("pauses the actual active Shorts video while entitlement is unknown or denied", async () => {
  const listeners = {};
  const player = new FakeBadge("video");
  player.paused = false;
  const navigation = { onShorts: true, activeVideoId: "abcdefghijk", player, players: [player], panel: null };
  const document = makeDocument([], listeners, navigation);
  const content = loadContentScript(document, {}, listeners, {
    status: { ok: true, signedIn: true },
    "youtube-pricing-rates": { ok: true, standardCoinsPerMinute: 1.2, shortsCoinsPerMinute: 1.4, flexibleCoinsPerMinute: 1.6 },
    "youtube-balance": { ok: true, coins: 30, shortsExpiresAt: null },
    "youtube-entitlement": { ok: true, unlocked: false },
  });
  content.setLocation("/shorts/abcdefghijk", "abcdefghijk");
  listeners["document:yt-navigate-finish"]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(player.paused, true);
  assert.equal(document.documentElement.classList.contains("fr-youtube-blocked"), true);
  assert.ok(player.pauseCalls >= 1);
  const pauseCalls = player.pauseCalls ?? 0;
  listeners["document:play"]({ target: player });
  assert.equal(player.paused, true);
  assert.ok((player.pauseCalls ?? 0) >= pauseCalls);
  assert.ok(document.querySelector(".fr-youtube-purchase"));
});

test("retains account-wide Shorts access across rapid Short changes without reopening the gate", async () => {
  const listeners = {};
  const now = Date.now();
  const player = new FakeBadge("video");
  player.paused = false;
  const navigation = { onShorts: true, activeVideoId: "abcdefghijk", player, players: [player], panel: null };
  const document = makeDocument([], listeners, navigation);
  let entitlementCalls = 0;
  const content = loadContentScript(document, {}, listeners, {
    status: { ok: true, signedIn: true, email: "member@example.com" },
    "youtube-pricing-rates": { ok: true, standardCoinsPerMinute: 1.2, shortsCoinsPerMinute: 1.4, flexibleCoinsPerMinute: 1.6 },
    "youtube-balance": { ok: true, coins: 30, shortsExpiresAt: now + 300_000, serverTime: now },
    "youtube-entitlement": () => { entitlementCalls += 1; return { ok: true, unlocked: true, expiresAt: now + 300_000, serverTime: now }; },
  }, { Date: class extends Date { static now() { return now; } } });
  content.setLocation("/shorts/abcdefghijk", "abcdefghijk");
  listeners["document:yt-navigate-finish"]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(document.documentElement.classList.contains("fr-youtube-blocked"), false);
  assert.equal(document.querySelector(".fr-youtube-purchase"), null);
  const initialPauseCalls = player.pauseCalls ?? 0;
  for (const videoId of ["lmnopqrstuv", "abcdefghijk", "lmnopqrstuv"]) {
    content.setLocation(`/shorts/${videoId}`, videoId);
    navigation.activeVideoId = videoId;
    listeners["document:yt-navigate-finish"]();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(document.documentElement.classList.contains("fr-youtube-blocked"), false);
    assert.equal(document.querySelector(".fr-youtube-purchase"), null);
  }
  assert.equal(entitlementCalls, 1);
  assert.equal(player.pauseCalls ?? 0, initialPauseCalls);
});

test("does not show or pause through transient Shorts renderer gaps after an authorized session", async () => {
  const listeners = {};
  const now = Date.now();
  const player = new FakeBadge("video");
  player.paused = false;
  const navigation = { onShorts: true, hasReelRenderer: true, activeVideoId: "abcdefghijk", player, players: [player], panel: null };
  const document = makeDocument([], listeners, navigation);
  const content = loadContentScript(document, {}, listeners, {
    status: { ok: true, signedIn: true, email: "member@example.com" },
    "youtube-pricing-rates": { ok: true, standardCoinsPerMinute: 1.2, shortsCoinsPerMinute: 1.4, flexibleCoinsPerMinute: 1.6 },
    "youtube-balance": { ok: true, coins: 30, shortsExpiresAt: now + 300_000, serverTime: now },
    "youtube-entitlement": { ok: true, unlocked: true, expiresAt: now + 300_000, serverTime: now },
  }, { Date: class extends Date { static now() { return now; } } });
  content.setLocation("/shorts/abcdefghijk", "abcdefghijk");
  listeners["document:yt-navigate-finish"]();
  await new Promise((resolve) => setImmediate(resolve));
  const pauseCalls = player.pauseCalls ?? 0;
  navigation.activeVideoId = null;
  navigation.activeRenderers = [];
  player.paused = false;
  player.dispatchEvent("play");
  listeners["document:play"]({ target: player });
  listeners.mutationObserver([]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(document.documentElement.classList.contains("fr-youtube-blocked"), false);
  assert.equal(document.querySelector(".fr-youtube-purchase"), null);
  assert.equal(player.paused, false);
  assert.equal(player.pauseCalls ?? 0, pauseCalls);

  navigation.activeVideoId = "lmnopqrstuv";
  navigation.activeRenderers = [{ getAttribute(name) { return name === "video-id" ? "lmnopqrstuv" : null; }, querySelector() { return player; } }];
  navigation.players = [player];
  listeners["document:yt-navigate-finish"]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(document.documentElement.classList.contains("fr-youtube-blocked"), false);
  assert.equal(player.pauseCalls ?? 0, pauseCalls);
});

test("blocks and pauses an unauthorized Shorts transition after the new active video identity appears", async () => {
  const listeners = {};
  const player = new FakeBadge("video");
  player.paused = false;
  const navigation = { onShorts: true, hasReelRenderer: true, activeVideoId: "abcdefghijk", player, players: [player], panel: null };
  const document = makeDocument([], listeners, navigation);
  let entitlementCalls = 0;
  const content = loadContentScript(document, {}, listeners, {
    status: { ok: true, signedIn: true, email: "member@example.com" },
    "youtube-pricing-rates": { ok: true, standardCoinsPerMinute: 1.2, shortsCoinsPerMinute: 1.4, flexibleCoinsPerMinute: 1.6 },
    "youtube-balance": { ok: true, coins: 30, shortsExpiresAt: null },
    "youtube-entitlement": () => { entitlementCalls += 1; return { ok: true, unlocked: false }; },
  });
  content.setLocation("/shorts/abcdefghijk", "abcdefghijk");
  listeners["document:yt-navigate-finish"]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(player.paused, true);
  assert.ok(document.querySelector(".fr-youtube-purchase"));
  const pauseCalls = player.pauseCalls;
  navigation.activeVideoId = null;
  navigation.activeRenderers = [];
  listeners.mutationObserver([]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(document.querySelector(".fr-youtube-purchase")?.hidden, true);
  assert.equal(player.pauseCalls, pauseCalls);
  navigation.activeVideoId = "lmnopqrstuv";
  navigation.activeRenderers = [{ getAttribute(name) { return name === "video-id" ? "lmnopqrstuv" : null; }, querySelector() { return player; } }];
  player.paused = false;
  listeners["document:yt-navigate-finish"]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(player.paused, true);
  assert.equal(document.querySelector(".fr-youtube-purchase")?.dataset.contentKey, "youtube_short:lmnopqrstuv");
  assert.equal(entitlementCalls, 2);
});

test("guards late-added Shorts players in an open YouTube shadow root while allowing an authorized player", async () => {
  const listeners = {};
  const now = Date.now();
  const player = new FakeBadge("video");
  const shadowRoot = {
    querySelectorAll(selector) {
      if (selector === "*") return [];
      if (selector === "video.html5-main-video, video") return [player];
      if (selector === "#movie_player, #shorts-player") return [];
      if (selector === "video") return [player];
      return [];
    },
  };
  const host = { shadowRoot, querySelectorAll() { return []; } };
  const navigation = { onShorts: true, hasReelRenderer: true, activeVideoId: "abcdefghijk", player: null, players: [], shadowPlayers: [player], panel: null };
  const document = makeDocument([], listeners, navigation);
  const originalQuery = document.querySelectorAll.bind(document);
  document.querySelectorAll = (selector) => selector === "ytd-shorts, ytd-reel-video-renderer" ? [host] : originalQuery(selector);
  const content = loadContentScript(document, {}, listeners, {
    status: { ok: true, signedIn: true, email: "member@example.com" },
    "youtube-pricing-rates": { ok: true, standardCoinsPerMinute: 1.2, shortsCoinsPerMinute: 1.4, flexibleCoinsPerMinute: 1.6 },
    "youtube-balance": { ok: true, coins: 30, shortsExpiresAt: now + 300_000, serverTime: now },
    "youtube-entitlement": { ok: true, unlocked: true, expiresAt: now + 300_000, serverTime: now },
  }, { Date: class extends Date { static now() { return now; } } });
  content.setLocation("/shorts/abcdefghijk", "abcdefghijk");
  listeners["document:yt-navigate-finish"]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(document.documentElement.classList.contains("fr-youtube-blocked"), false);
  player.paused = true;
  player.dispatchEvent("play");
  assert.equal(player.paused, false);
});

test("hides the purchase panel while a Shorts renderer identity is transitioning", async () => {
  const listeners = {};
  const player = new FakeBadge("video");
  const navigation = { onShorts: true, hasReelRenderer: true, activeVideoId: "abcdefghijk", player, players: [player], panel: null };
  const document = makeDocument([], listeners, navigation);
  const content = loadContentScript(document, {}, listeners, {
    status: { ok: true, signedIn: true },
    "youtube-pricing-rates": { ok: true, standardCoinsPerMinute: 1.2, shortsCoinsPerMinute: 1.4, flexibleCoinsPerMinute: 1.6 },
    "youtube-balance": { ok: true, coins: 30, shortsExpiresAt: null },
    "youtube-entitlement": { ok: true, unlocked: false },
  });
  content.setLocation("/shorts/abcdefghijk", "abcdefghijk");
  listeners["document:yt-navigate-finish"]();
  await new Promise((resolve) => setImmediate(resolve));
  const panel = document.querySelector(".fr-youtube-purchase");
  assert.ok(panel);
  navigation.activeVideoId = null;
  navigation.activeRenderers = [];
  listeners.mutationObserver([]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(panel.hidden, true);
  assert.equal(document.documentElement.classList.contains("fr-youtube-blocked"), true);
});

test("resumes the purchased standard video immediately only after backend success and not after navigation", async () => {
  const listeners = {};
  const player = new FakeBadge("video");
  player.paused = false;
  const navigation = { onVideo: true, duration: "5:00", title: "Current video", panel: null, player, players: [player] };
  const document = makeDocument([], listeners, navigation);
  let purchaseResult = { ok: true, expiresAt: Date.now() + 18 * 60 * 60_000, alreadyOwned: false };
  const content = loadContentScript(document, {}, listeners, {
    status: { ok: true, signedIn: true, email: "member@example.com" },
    "youtube-pricing-rates": { ok: true, standardCoinsPerMinute: 1.2, shortsCoinsPerMinute: 1.4, flexibleCoinsPerMinute: 1.6 },
    "youtube-balance": { ok: true, coins: 50, shortsExpiresAt: null, serverTime: Date.now() },
    "youtube-entitlement": { ok: true, unlocked: false },
    "youtube-quote": { ok: true, quoteId: "quote-1", price: 6, rateCoinsPerMinute: 1.2, entitlementHours: 18 },
    "youtube-purchase": () => purchaseResult,
  });
  content.setLocation("/watch", "abcdefghijk");
  listeners["document:yt-navigate-finish"]();
  await new Promise((resolve) => setImmediate(resolve));
  player.paused = true;
  const panel = document.querySelector(".fr-youtube-purchase");
  const purchase = panel.children.find((child) => child.tag === "button" && child.className !== "fr-youtube-cancel");
  await purchase.onclick();
  assert.equal(document.documentElement.classList.contains("fr-youtube-blocked"), false);
  assert.equal(player.paused, false);
  assert.equal(player.playCalls, 1);
  assert.equal(document.querySelector(".fr-youtube-purchase"), null);

  player.paused = true;
  navigation.panel = null;
  content.setLocation("/watch", "lmnopqrstuv");
  listeners["document:yt-navigate-finish"]();
  await new Promise((resolve) => setImmediate(resolve));
  const otherPanel = document.querySelector(".fr-youtube-purchase");
  const otherPurchase = otherPanel.children.find((child) => child.tag === "button" && child.className !== "fr-youtube-cancel");
  purchaseResult = { ok: false, kind: "rejected" };
  const playCount = player.playCalls;
  await otherPurchase.onclick();
  assert.equal(player.playCalls, playCount);
  assert.equal(document.documentElement.classList.contains("fr-youtube-blocked"), true);
});

test("adds estimated playlist and Watch Later prices and a deduplicated total only after server response", async () => {
  const cards = [
    makeCard({ duration: "5:00", href: "/watch?v=abcdefghijk" }),
    makeCard({ duration: "2:00", href: "/watch?v=lmnopqrstuv" }),
    makeCard({ duration: "5:00", href: "/watch?v=abcdefghijk" }),
    makeCard({ duration: null, href: "/watch?v=zyxwvutsrqp" }),
  ];
  const listeners = {};
  const header = { children: [], append(node) { this.children.push(node); node.parentElement = this; node.isConnected = true; } };
  const navigation = { onVideo: false, playlistHeader: header };
  const document = makeDocument(cards.map(({ card }) => card), listeners, navigation);
  const originalQuerySelector = document.querySelector.bind(document);
  document.querySelector = (selector) => selector === "ytd-playlist-header-renderer #primary" ? header : originalQuerySelector(selector);
  const content = loadContentScript(document, {}, listeners, {
    status: { ok: true, signedIn: true, email: "member@example.com" },
    "youtube-pricing-rates": { ok: true, standardCoinsPerMinute: 1.2, shortsCoinsPerMinute: 1.4, flexibleCoinsPerMinute: 1.6 },
    "youtube-estimates": (message) => ({ ok: true, serverTime: Date.now(), videos: message.videos.map(({ videoId }) => ({ videoId, unlocked: videoId === "lmnopqrstuv", estimatedPrice: videoId === "abcdefghijk" ? 6 : null, expiresAt: null })) }),
  });
  content.setLocation("/playlist", null);
  listeners["document:yt-navigate-finish"]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cards[0].badgeList.find((badge) => badge.isConnected)?.textContent, "◈ ca. 6 Coins");
  assert.equal(cards[1].badgeList.find((badge) => badge.isConnected)?.textContent, "✓ Freigeschaltet");
  assert.equal(cards[2].badgeList.find((badge) => badge.isConnected)?.textContent, "◈ ca. 6 Coins");
  assert.equal(cards[3].badgeList.filter((badge) => badge.isConnected).length, 0);
  const total = document.querySelector(".fr-youtube-playlist-total");
  assert.match(total.textContent, /Playlist estimate only: 6 Coins/);
  assert.match(total.textContent, /incomplete \(1 unpriced\)/);
  assert.match(total.textContent, /no batch purchase/);

  navigation.playlistHeader = null;
  const watchLaterDocument = makeDocument(cards.slice(0, 2).map(({ card }) => card), listeners, navigation);
  const watchLaterContent = loadContentScript(watchLaterDocument, {}, listeners, {
    status: { ok: true, signedIn: true },
    "youtube-estimates": (message) => ({ ok: true, videos: message.videos.map(({ videoId }) => ({ videoId, unlocked: false, estimatedPrice: 6, expiresAt: null })) }),
  });
  watchLaterContent.setLocation("/playlist", null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cards[0].badgeList.find((badge) => badge.isConnected)?.textContent, "◈ ca. 6 Coins");
  assert.equal(cards[1].badgeList.find((badge) => badge.isConnected)?.textContent, "◈ ca. 6 Coins");
});

test("filters Shorts in the right recommendation rail and prices eligible standard recommendations", async () => {
  const short = makeCard({ duration: "0:30", href: "/shorts/abcdefghijk" });
  const normal = makeCard({ duration: "5:00", href: "/watch?v=lmnopqrstuv" });
  short.card.closest = (selector) => selector === "#secondary" ? {} : null;
  normal.card.closest = (selector) => selector === "#secondary" ? {} : null;
  const listeners = {};
  const navigation = { onWatch: true };
  const content = loadContentScript(makeDocument([short.card, normal.card], listeners, navigation), {}, listeners, {
    status: { ok: true, signedIn: true },
    "youtube-estimates": (message) => ({ ok: true, videos: message.videos.map(({ videoId }) => ({ videoId, unlocked: false, estimatedPrice: 6, expiresAt: null })) }),
  });
  content.setLocation("/watch", "abcdefghijk");
  listeners["document:yt-navigate-finish"]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(short.cardClasses.has("fr-youtube-filtered-short"), true);
  assert.equal(normal.cardClasses.has("fr-youtube-filtered-short"), false);
  assert.equal(normal.badgeList.find((badge) => badge.isConnected)?.textContent, "◈ 6 Coins");
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
