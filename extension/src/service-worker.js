(() => {
  "use strict";

  const TOKEN_KEY = "focusRewardsExtensionToken";
  const EXPIRY_KEY = "focusRewardsExtensionExpiresAt";
  const ENDPOINT_KEY = "focusRewardsConvexSiteUrl";
  const OPTIONS_URL = chrome.runtime.getURL("options/options.html");
  const POPUP_URL = chrome.runtime.getURL("popup/popup.html");

  function normalizeSiteUrl(value) {
    if (typeof value !== "string") return null;
    try {
      const url = new URL(value.trim());
      if (url.protocol !== "https:" || !/^(?:[a-z0-9-]+\.)+convex\.site$/i.test(url.hostname)) return null;
      if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) return null;
      return url.origin;
    } catch {
      return null;
    }
  }

  function sendJson(url, init) {
    return fetch(url, { ...init, cache: "no-store", redirect: "error" }).then(async (response) => {
      let body = {};
      try { body = await response.json(); } catch { /* handled as an empty response */ }
      return { response, body };
    });
  }

  async function getCredential() {
    const values = await chrome.storage.local.get([TOKEN_KEY, EXPIRY_KEY, ENDPOINT_KEY]);
    if (typeof values[TOKEN_KEY] !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(values[TOKEN_KEY]) || typeof values[EXPIRY_KEY] !== "number") return null;
    const siteUrl = normalizeSiteUrl(values[ENDPOINT_KEY]);
    if (!siteUrl) return null;
    return { token: values[TOKEN_KEY], expiresAt: values[EXPIRY_KEY], siteUrl };
  }

  async function clearCredential() {
    await chrome.storage.local.remove([TOKEN_KEY, EXPIRY_KEY]);
  }

  async function pair(message) {
    const siteUrl = normalizeSiteUrl(message.siteUrl);
    const code = typeof message.code === "string" ? message.code.trim() : "";
    if (!siteUrl) return { ok: false, kind: "input", message: "Enter a valid HTTPS Convex site URL ending in .convex.site." };
    if (!/^[A-Za-z0-9_-]{32}$/.test(code)) return { ok: false, kind: "input", message: "The pairing code is invalid." };
    const { response, body } = await sendJson(`${siteUrl}/extension/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!response.ok || typeof body.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.token) || typeof body.expiresAt !== "number" || body.expiresAt <= Date.now() || body.expiresAt > Date.now() + 30 * 86400000) {
      return { ok: false, kind: "rejected", message: typeof body.error === "string" ? body.error : "The server rejected this pairing code." };
    }
    await chrome.storage.local.set({ [TOKEN_KEY]: body.token, [EXPIRY_KEY]: body.expiresAt, [ENDPOINT_KEY]: siteUrl });
    return { ok: true, email: typeof body.email === "string" ? body.email : null, expiresAt: body.expiresAt, siteUrl };
  }

  async function status() {
    const credential = await getCredential();
    if (!credential) return { ok: true, signedIn: false };
    if (credential.expiresAt <= Date.now()) {
      await clearCredential();
      return { ok: true, signedIn: false, reason: "expired-or-revoked" };
    }
    const { response, body } = await sendJson(`${credential.siteUrl}/extension/me`, {
      method: "GET",
      headers: { Authorization: `Bearer ${credential.token}` },
    });
    if (response.status === 401) {
      await clearCredential();
      return { ok: true, signedIn: false, reason: "expired-or-revoked" };
    }
    if (!response.ok) return { ok: false, kind: "network", message: "Could not check the extension session." };
    return { ok: true, signedIn: true, email: typeof body.email === "string" ? body.email : null, expiresAt: body.expiresAt };
  }

  async function youtubeRequest(type, message) {
    const credential = await getCredential();
    if (!credential || credential.expiresAt <= Date.now()) {
      if (credential) await clearCredential();
      return { ok: false, kind: "unauthorized", error: "SESSION_REQUIRED" };
    }
    const headers = { Authorization: `Bearer ${credential.token}` };
    if (type === "youtube-pricing-rates") {
      const response = await sendJson(`${credential.siteUrl}/extension/youtube/pricing-rates`, { method: "GET", headers });
      if (response.response.status === 401) {
        await clearCredential();
        return { ok: false, kind: "unauthorized", error: "SESSION_REQUIRED" };
      }
      const rates = response.body;
      if (!response.response.ok || ![rates.standardCoinsPerMinute, rates.shortsCoinsPerMinute, rates.flexibleCoinsPerMinute]
        .every((rate) => Number.isFinite(rate) && rate > 0 && rate <= 100 && Math.abs(rate * 100 - Math.round(rate * 100)) < 1e-8)) {
        return { ok: false, kind: response.response.status === 503 ? "network" : "rejected", message: "The server returned invalid pricing settings." };
      }
      return { ok: true, ...rates, flexibleUsageEnabled: rates.flexibleUsageEnabled === true };
    }
    if (type === "youtube-quote") {
      const response = await sendJson(`${credential.siteUrl}/extension/youtube/quote`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: message.videoId, contentType: message.contentType, durationSeconds: message.durationSeconds }),
      });
      if (response.response.status === 401) {
        await clearCredential();
        return { ok: false, kind: "unauthorized", error: "SESSION_REQUIRED" };
      }
      if (response.response.status === 503) return { ok: false, kind: "network", error: "NETWORK_ERROR" };
      if (!response.response.ok || typeof response.body.quoteId !== "string" || !Number.isSafeInteger(response.body.price) || !Number.isFinite(response.body.rateCoinsPerMinute) || !Number.isSafeInteger(response.body.entitlementDays)) {
        return { ok: false, kind: "rejected", error: "QUOTE_REJECTED" };
      }
      return { ok: true, quoteId: response.body.quoteId, price: response.body.price, rateCoinsPerMinute: response.body.rateCoinsPerMinute, entitlementDays: response.body.entitlementDays };
    }
    if (type === "youtube-purchase") {
      const response = await sendJson(`${credential.siteUrl}/extension/youtube/purchase`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: message.videoId, contentType: message.contentType, durationSeconds: message.durationSeconds, idempotencyKey: message.idempotencyKey, quoteId: message.quoteId }),
      });
      if (response.response.status === 401) {
        await clearCredential();
        return { ok: false, kind: "unauthorized", error: "SESSION_REQUIRED" };
      }
      if (response.response.status === 402 && response.body.error === "INSUFFICIENT_COINS") return { ok: false, kind: "insufficient-coins" };
      if (response.response.status === 503) return { ok: false, kind: "network", error: "NETWORK_ERROR" };
      if (!response.response.ok || response.body.success !== true) return { ok: false, kind: "rejected", error: typeof response.body.error === "string" ? response.body.error : "PURCHASE_REJECTED" };
      return { ok: true, alreadyOwned: response.body.alreadyOwned === true, alreadyProcessed: response.body.alreadyProcessed === true, price: response.body.price, expiresAt: response.body.expiresAt };
    }
    if (type === "youtube-entitlement") {
      const params = new URLSearchParams({ videoId: message.videoId, contentType: message.contentType });
      const response = await sendJson(`${credential.siteUrl}/extension/youtube/entitlement?${params}`, { method: "GET", headers });
      if (response.response.status === 401) {
        await clearCredential();
        return { ok: false, kind: "unauthorized", error: "SESSION_REQUIRED" };
      }
      if (!response.response.ok) return { ok: false, kind: "network", error: "NETWORK_ERROR" };
      return { ok: true, unlocked: response.body.unlocked === true, expiresAt: response.body.expiresAt ?? null, durationSeconds: response.body.durationSeconds ?? null };
    }
    return { ok: false, kind: "input", error: "UNKNOWN_ACTION" };
  }

  async function revoke() {
    const credential = await getCredential();
    if (!credential) return { ok: true, signedIn: false };
    const { response } = await sendJson(`${credential.siteUrl}/extension/me`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${credential.token}` },
    });
    if (response.status === 401) {
      await clearCredential();
      return { ok: true, signedIn: false };
    }
    if (!response.ok) return { ok: false, kind: "network", message: "Could not revoke the extension session. The saved credential is retained so you can retry." };
    await clearCredential();
    return { ok: true, signedIn: false, revoked: true };
  }

  chrome.storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!sender.id || sender.id !== chrome.runtime.id || !message || typeof message.type !== "string") return false;
    const fromOptions = sender.url === OPTIONS_URL;
    const fromPopup = sender.url === POPUP_URL;
    const fromYouTubePage = sender.tab !== undefined && typeof sender.url === "string"
      && /^https:\/\/www\.youtube\.com\//.test(sender.url);
    if (fromOptions) {
      const request = message.type === "pair" ? pair(message)
        : message.type === "status" ? status()
          : message.type === "revoke" ? revoke()
            : Promise.resolve({ ok: false, kind: "input", message: "Unknown extension action." });
      request.then(sendResponse).catch(() => sendResponse({ ok: false, kind: "network", message: "The request failed. Check your connection and try again." }));
      return true;
    }
    if (fromPopup && message.type === "status") {
      status().then(sendResponse).catch(() => sendResponse({ ok: false, kind: "network", message: "The extension session could not be checked." }));
      return true;
    }
    if (!fromYouTubePage || !["status", "youtube-quote", "youtube-purchase", "youtube-entitlement", "youtube-pricing-rates"].includes(message.type)) return false;
    const request = message.type === "status" ? status() : youtubeRequest(message.type, message);
    request.then(sendResponse).catch(() => sendResponse({ ok: false, kind: "network", message: "The request failed. Check your connection and try again." }));
    return true;
  });
})();
