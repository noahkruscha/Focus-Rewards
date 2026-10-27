import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const popupSource = await readFile(new URL("../popup/popup.js", import.meta.url), "utf8");
const popupHtml = await readFile(new URL("../popup/popup.html", import.meta.url), "utf8");

function element() {
  return {
    dataset: {},
    value: "",
    textContent: "",
    hidden: false,
    disabled: false,
    listeners: {},
    addEventListener(type, callback) { this.listeners[type] = callback; },
  };
}

function setup({ status = { ok: true, signedIn: true, email: "member@example.com", expiresAt: Date.now() + 60_000 }, rates = { ok: true, standardCoinsPerMinute: 1.2, shortsCoinsPerMinute: 1.4, flexibleCoinsPerMinute: 1.6 }, save = { ok: true, standardCoinsPerMinute: 2, shortsCoinsPerMinute: 3.5, flexibleCoinsPerMinute: 1.6 } } = {}) {
  const elements = new Map();
  const card = element();
  const pricing = element();
  pricing.hidden = true;
  const document = {
    querySelector(selector) {
      if (selector === ".account-card") return card;
      if (selector === ".pricing-controls") return pricing;
      return null;
    },
    getElementById(id) {
      if (!elements.has(id)) {
        const node = element();
        if (id === "save-rates") node.disabled = true;
        elements.set(id, node);
      }
      return elements.get(id);
    },
  };
  const messages = [];
  const chrome = {
    runtime: {
      openOptionsPage() {},
      sendMessage(message, callback) {
        messages.push(message);
        const result = message.type === "status" ? status
          : message.type === "youtube-pricing-rates" ? rates
            : message.type === "youtube-pricing-save" ? save
              : { ok: false };
        const request = Promise.resolve(result);
        if (callback) request.then(callback);
        return request;
      },
    },
  };
  vm.runInNewContext(popupSource, { document, chrome, Date, Number, String });
  return { elements, card, pricing, messages };
}

test("popup loads saved account rates and keeps flexible usage read-only", async () => {
  assert.match(popupHtml, /id="flexible-rate-value"[^>]*aria-readonly="true"/);
  const app = setup();
  app.elements.get("save-rates").disabled = true;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(app.pricing.hidden, false);
  assert.equal(app.elements.get("standard-rate").value, "1.2");
  assert.equal(app.elements.get("shorts-rate").value, "1.4");
  assert.equal(app.elements.get("flexible-rate-value").value, "1,6");
  assert.equal(app.elements.get("save-rates").disabled, true);
});

test("popup saves changed standard and Shorts rates only after server confirmation", async () => {
  const app = setup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  app.elements.get("standard-rate").value = "2";
  app.elements.get("standard-rate").listeners.input();
  app.elements.get("shorts-rate").value = "3.5";
  app.elements.get("shorts-rate").listeners.input();
  await app.elements.get("save-rates").listeners.click();
  assert.equal(app.elements.get("pricing-status").textContent, "Preise vom Server gespeichert. Neue Schätzungen verwenden die aktualisierten Tarife.");
  assert.deepEqual(JSON.parse(JSON.stringify(app.messages.find((message) => message.type === "youtube-pricing-save").rates)), {
    standardCoinsPerMinute: 2,
    shortsCoinsPerMinute: 3.5,
    expectedStandard: 1.2,
    expectedShorts: 1.4,
  });
});

test("popup hides rates when disconnected and reports save rejection without claiming success", async () => {
  const disconnected = setup({ status: { ok: true, signedIn: false } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(disconnected.pricing.hidden, true);

  const rejected = setup({ save: { ok: false, kind: "conflict", message: "Pricing changed in another session." } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  rejected.elements.get("standard-rate").value = "2";
  rejected.elements.get("standard-rate").listeners.input();
  await rejected.elements.get("save-rates").listeners.click();
  assert.equal(rejected.elements.get("pricing-status").textContent, "Pricing changed in another session.");
  assert.notEqual(rejected.elements.get("pricing-status").textContent, "Preise vom Server gespeichert. Neue Schätzungen verwenden die aktualisierten Tarife.");
});
