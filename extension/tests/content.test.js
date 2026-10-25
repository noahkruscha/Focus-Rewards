import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const pricingSource = await readFile(new URL("../src/pricing.js", import.meta.url), "utf8");
const contentSource = await readFile(new URL("../src/content.js", import.meta.url), "utf8");

function loadContentScript(document, storage = {}, listeners = {}) {
  let timerId = 0;
  const window = {
    setTimeout(callback) { const id = ++timerId; queueMicrotask(callback); return id; },
    clearTimeout() {},
    addEventListener(type, callback) { listeners[`window:${type}`] = callback; },
    FocusRewardsPricing: undefined,
  };
  const chrome = {
    storage: {
      sync: { get(defaults, callback) { callback({ ...defaults, ...storage }); } },
      onChanged: { addListener(callback) { listeners.storage = callback; } },
    },
  };
  const context = vm.createContext({
    window,
    document,
    chrome,
    MutationObserver: class {
      constructor(callback) { this.callback = callback; listeners.mutationObserver = callback; }
      observe() {}
    },
  });
  vm.runInContext(pricingSource, context);
  window.FocusRewardsPricing = context.FocusRewardsPricing;
  vm.runInContext(contentSource, context);
  return { listeners };
}

class FakeBadge {
  constructor() {
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
  remove() { this.isConnected = false; this.parentElement = null; }
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
  const links = [{ getAttribute() { return href; } }];

  const card = {
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
  return { card, row, get badgeList() { return row.children.filter((badge) => badge.className === "fr-youtube-price"); } };
}

function makeDocument(cards, listeners = {}) {
  return {
    documentElement: {},
    createElement(tag) { assert.equal(tag, "span"); return new FakeBadge(); },
    querySelectorAll(selector) {
      if (selector === "ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer") return cards;
      if (selector === ".fr-youtube-price") return cards.flatMap((card) => card.querySelectorAll(selector));
      return [];
    },
    addEventListener(type, callback) { listeners[`document:${type}`] = callback; },
  };
}

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
  assert.equal(badges[0].textContent, "◈ 6 coins");
  assert.equal(badges[0].parentElement, video.row);
  assert.equal(badges[0].nextElementSibling, video.row.children.at(-1));
  assert.match(badges[0].getAttribute("title"), /video duration/);
  assert.equal(video.badgeList.filter((badge) => badge.isConnected).length, 1);
});

test("updates incrementally loaded cards and supports YouTube SPA navigation", async () => {
  const cards = [];
  const listeners = {};
  const document = makeDocument(cards, listeners);
  loadContentScript(document, {}, listeners);
  const first = makeCard({ document, duration: "10:00" });
  cards.push(first.card);
  listeners["window:popstate"]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(first.badgeList.filter((badge) => badge.isConnected)[0].textContent, "◈ 12 coins");
  const next = makeCard({ document, duration: "15:00" });
  cards.push(next.card);
  listeners.mutationObserver([]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(next.badgeList.filter((badge) => badge.isConnected)[0].textContent, "◈ 18 coins");
  const navigated = makeCard({ document, duration: "20:00" });
  cards.push(navigated.card);
  listeners["document:yt-navigate-finish"]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(navigated.badgeList.filter((badge) => badge.isConnected)[0].textContent, "◈ 24 coins");
});

test("omits unknown-duration, Shorts, and live cards and removes stale badges", () => {
  const document = makeDocument([]);
  const cards = [makeCard({ document, duration: null }), makeCard({ document, href: "/shorts/clip", duration: "0:30" }), makeCard({ document, live: true, duration: "LIVE" })];
  const cardsDocument = makeDocument(cards.map((item) => item.card));
  loadContentScript(cardsDocument);
  assert.ok(cards.every((item) => item.badgeList.filter((badge) => badge.isConnected).length === 0));
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
