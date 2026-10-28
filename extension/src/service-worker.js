(() => {
  "use strict";

  const TOKEN_KEY = "focusRewardsExtensionToken";
  const EXPIRY_KEY = "focusRewardsExtensionExpiresAt";
  const ENDPOINT_KEY = "focusRewardsConvexSiteUrl";
  const PENDING_SHORTS_PURCHASE_KEY = "focusRewardsPendingShortsPurchase";
  const PENDING_VIDEO_PURCHASE_KEY = "focusRewardsPendingVideoPurchase";
  const FLEXIBLE_STATE_KEY = "focusRewardsFlexibleUsageState";
  const FLEXIBLE_PENDING_KEY = "focusRewardsFlexibleUsagePending";
  const FLEXIBLE_OWNER_KEY = "focusRewardsFlexibleUsageOwner";
  const OPTIONS_URL = chrome.runtime.getURL("options/options.html");
  const POPUP_URL = chrome.runtime.getURL("popup/popup.html");

  function isLocalConvexSiteUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname) && url.port === "3211";
    } catch { return false; }
  }

  function normalizeSiteUrl(value) {
    if (typeof value !== "string") return null;
    try {
      const url = new URL(value.trim());
      const localConvexSite = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname) && url.port === "3211";
      const hostedConvexSite = url.protocol === "https:" && /^(?:[a-z0-9-]+\.)+convex\.site$/i.test(url.hostname);
      if (!localConvexSite && !hostedConvexSite) return null;
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
    if (!siteUrl) return { ok: false, kind: "input", message: "Enter an HTTPS *.convex.site URL or the local Convex site URL http://127.0.0.1:3211." };
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

  let shortsPurchaseInFlight = false;
  let videoPurchaseInFlight = false;
  const flexibleRequestsInFlight = new Map();
  const localFlexibleRateOptIn = true;

  async function youtubeRequest(type, message) {
    const credential = await getCredential();
    if (!credential || credential.expiresAt <= Date.now()) {
      if (credential) await clearCredential();
      return { ok: false, kind: "unauthorized", error: "SESSION_REQUIRED" };
    }
    const headers = { Authorization: `Bearer ${credential.token}` };
    if (type === "youtube-balance") {
      const response = await sendJson(`${credential.siteUrl}/extension/youtube/balance`, { method: "GET", headers });
      if (response.response.status === 401) { await clearCredential(); return { ok: false, kind: "unauthorized", error: "SESSION_REQUIRED" }; }
      if (!response.response.ok || !Number.isSafeInteger(response.body.coins) || response.body.coins < 0) return { ok: false, kind: "network", message: "Balance unavailable." };
      return { ok: true, coins: response.body.coins, shortsExpiresAt: response.body.shortsExpiresAt ?? null, serverTime: Number.isFinite(response.body.serverTime) ? response.body.serverTime : null };
    }
    if (type === "youtube-pricing-save") {
      const payload = message.rates;
      if (!payload || ![payload.standardCoinsPerMinute, payload.shortsCoinsPerMinute, payload.expectedStandard, payload.expectedShorts].every((rate) => Number.isFinite(rate) && rate > 0 && rate <= 100 && Math.abs(rate * 100 - Math.round(rate * 100)) < 1e-8)) return { ok: false, kind: "input", message: "Ungültige Preisangabe." };
      const response = await sendJson(`${credential.siteUrl}/extension/youtube/pricing-rates`, { method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (response.response.status === 401) { await clearCredential(); return { ok: false, kind: "unauthorized", message: "Erweiterungssitzung abgelaufen. Bitte erneut verbinden." }; }
      if (!response.response.ok) return { ok: false, kind: response.response.status === 409 ? "conflict" : "rejected", message: typeof response.body.error === "string" ? response.body.error : "Preise konnten nicht gespeichert werden." };
      const rates = response.body;
      if (![rates.standardCoinsPerMinute, rates.shortsCoinsPerMinute, rates.flexibleCoinsPerMinute].every((rate) => Number.isFinite(rate) && rate > 0 && rate <= 100)) return { ok: false, kind: "rejected", message: "Der Server hat ungültige Preisangaben zurückgegeben." };
      const confirmedRates = { standardCoinsPerMinute: rates.standardCoinsPerMinute, shortsCoinsPerMinute: rates.shortsCoinsPerMinute, flexibleCoinsPerMinute: rates.flexibleCoinsPerMinute, flexibleUsageEnabled: isLocalConvexSiteUrl(credential.siteUrl) && rates.flexibleUsageEnabled === true };
      await chrome.storage.local.set({ focusRewardsYouTubePricingRates: confirmedRates });
      return { ok: true, ...confirmedRates };
    }
    if (type === "youtube-shorts-time") {
      if (![5, 10, 30].includes(message.minutes) || !/^[A-Za-z0-9_-]{16,128}$/.test(message.idempotencyKey || "")) return { ok: false, kind: "input", message: "Ungültige Shorts-Zeit." };
      if (shortsPurchaseInFlight) return { ok: false, kind: "pending-purchase", message: "Ein Shorts-Kauf wird gerade geprüft. Bitte warte auf die Bestätigung." };
      shortsPurchaseInFlight = true;
      try {
        const stored = await chrome.storage.local.get([PENDING_SHORTS_PURCHASE_KEY]);
        const pending = stored[PENDING_SHORTS_PURCHASE_KEY];
        if (pending && pending.siteUrl === credential.siteUrl && pending.minutes !== message.minutes) {
          return { ok: false, kind: "pending-purchase", message: "Ein vorheriger Shorts-Kauf ist noch nicht bestätigt. Bitte wiederhole zuerst dieselbe Auswahl." };
        }
        const idempotencyKey = pending?.siteUrl === credential.siteUrl && pending.minutes === message.minutes
          && typeof pending.idempotencyKey === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(pending.idempotencyKey)
          ? pending.idempotencyKey
          : message.idempotencyKey;
        await chrome.storage.local.set({ [PENDING_SHORTS_PURCHASE_KEY]: { siteUrl: credential.siteUrl, minutes: message.minutes, idempotencyKey } });
        const response = await sendJson(`${credential.siteUrl}/extension/youtube/shorts-time`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ minutes: message.minutes, idempotencyKey }) });
        const clearPending = async () => {
          const current = await chrome.storage.local.get([PENDING_SHORTS_PURCHASE_KEY]);
          if (current[PENDING_SHORTS_PURCHASE_KEY]?.idempotencyKey === idempotencyKey) await chrome.storage.local.remove([PENDING_SHORTS_PURCHASE_KEY]);
        };
        if (response.response.status === 401) { await clearPending(); await clearCredential(); return { ok: false, kind: "unauthorized", message: "Erweiterungssitzung abgelaufen. Bitte erneut verbinden." }; }
        if (response.response.status === 402) { await clearPending(); return { ok: false, kind: "insufficient-coins", message: "Dein Coin-Guthaben reicht nicht aus." }; }
        if (response.response.status === 503) return { ok: false, kind: "network", message: "Server nicht erreichbar. Der Kaufstatus ist unklar; beim erneuten Versuch wird derselbe Vorgang geprüft." };
        if (!response.response.ok || response.body.success !== true) { await clearPending(); return { ok: false, kind: "rejected", message: response.body.error || "Shorts-Zeit konnte nicht gekauft werden." }; }
        await clearPending();
        return { ok: true, price: response.body.price, expiresAt: response.body.expiresAt, alreadyProcessed: response.body.alreadyProcessed === true };
      } finally {
        shortsPurchaseInFlight = false;
      }
    }
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
      const confirmedRates = { ...rates, flexibleUsageEnabled: isLocalConvexSiteUrl(credential.siteUrl) && localFlexibleRateOptIn && rates.flexibleUsageEnabled === true };
      await chrome.storage.local.set({ focusRewardsYouTubePricingRates: confirmedRates });
      return { ok: true, ...confirmedRates };
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
      if (!response.response.ok || typeof response.body.quoteId !== "string" || !Number.isSafeInteger(response.body.price) || !Number.isFinite(response.body.rateCoinsPerMinute) || response.body.entitlementHours !== 18) {
        return { ok: false, kind: "rejected", error: "QUOTE_REJECTED" };
      }
      return { ok: true, quoteId: response.body.quoteId, price: response.body.price, rateCoinsPerMinute: response.body.rateCoinsPerMinute, entitlementHours: response.body.entitlementHours };
    }
    if (type === "youtube-estimates") {
      if (!Array.isArray(message.videos) || message.videos.length > 100
        || message.videos.some((video) => !video || typeof video.videoId !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(video.videoId)
          || (video.durationSeconds !== null && (!Number.isSafeInteger(video.durationSeconds) || video.durationSeconds <= 0 || video.durationSeconds > 6 * 60 * 60)))) {
        return { ok: false, kind: "input", message: "Ungültige Video-Schätzung." };
      }
      const response = await sendJson(`${credential.siteUrl}/extension/youtube/estimates`, {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ videos: message.videos }),
      });
      if (response.response.status === 401) { await clearCredential(); return { ok: false, kind: "unauthorized", error: "SESSION_REQUIRED" }; }
      if (response.response.status === 503) return { ok: false, kind: "network", message: "Video estimates are temporarily unavailable." };
      if (!response.response.ok || !Array.isArray(response.body.videos)) return { ok: false, kind: "rejected", message: "Video estimates could not be loaded." };
      return { ok: true, ...response.body };
    }
    if (type === "youtube-purchase") {
      if (videoPurchaseInFlight) return { ok: false, kind: "pending-purchase", message: "Ein Videokauf wird gerade geprüft. Bitte warte auf die Bestätigung." };
      videoPurchaseInFlight = true;
      try {
        const stored = await chrome.storage.local.get([PENDING_VIDEO_PURCHASE_KEY]);
        const pending = stored[PENDING_VIDEO_PURCHASE_KEY];
        if (pending && (pending.siteUrl !== credential.siteUrl || pending.videoId !== message.videoId || pending.contentType !== message.contentType || pending.durationSeconds !== message.durationSeconds)) {
          return { ok: false, kind: "pending-purchase", message: "Ein vorheriger Videokauf ist noch nicht bestätigt. Bitte öffne das ursprüngliche Video und wiederhole denselben Vorgang." };
        }
        const purchase = pending ?? {
          siteUrl: credential.siteUrl,
          videoId: message.videoId,
          contentType: message.contentType,
          durationSeconds: message.durationSeconds,
          idempotencyKey: message.idempotencyKey,
          quoteId: message.quoteId,
          videoTitle: typeof message.videoTitle === "string" ? message.videoTitle.trim().slice(0, 200) : undefined,
        };
        await chrome.storage.local.set({ [PENDING_VIDEO_PURCHASE_KEY]: purchase });
        const response = await sendJson(`${credential.siteUrl}/extension/youtube/purchase`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ videoId: purchase.videoId, videoTitle: purchase.videoTitle, contentType: purchase.contentType, durationSeconds: purchase.durationSeconds, idempotencyKey: purchase.idempotencyKey, quoteId: purchase.quoteId }),
        });
        const clearPending = async () => {
          const current = await chrome.storage.local.get([PENDING_VIDEO_PURCHASE_KEY]);
          if (current[PENDING_VIDEO_PURCHASE_KEY]?.idempotencyKey === purchase.idempotencyKey) await chrome.storage.local.remove([PENDING_VIDEO_PURCHASE_KEY]);
        };
        if (response.response.status === 401) { await clearPending(); await clearCredential(); return { ok: false, kind: "unauthorized", error: "SESSION_REQUIRED" }; }
        if (response.response.status === 402 && response.body.error === "INSUFFICIENT_COINS") { await clearPending(); return { ok: false, kind: "insufficient-coins" }; }
        if (response.response.status === 503) return { ok: false, kind: "network", error: "NETWORK_ERROR" };
        if (!response.response.ok || response.body.success !== true) { await clearPending(); return { ok: false, kind: "rejected", error: typeof response.body.error === "string" ? response.body.error : "PURCHASE_REJECTED" };
        }
        await clearPending();
        return { ok: true, alreadyOwned: response.body.alreadyOwned === true, alreadyProcessed: response.body.alreadyProcessed === true, price: response.body.price, expiresAt: response.body.expiresAt };
      } finally {
        videoPurchaseInFlight = false;
      }
    }
    if (type === "youtube-entitlement") {
      const params = new URLSearchParams({ videoId: message.videoId, contentType: message.contentType });
      const response = await sendJson(`${credential.siteUrl}/extension/youtube/entitlement?${params}`, { method: "GET", headers });
      if (response.response.status === 401) {
        await clearCredential();
        return { ok: false, kind: "unauthorized", error: "SESSION_REQUIRED" };
      }
      if (!response.response.ok) return { ok: false, kind: "network", error: "NETWORK_ERROR" };
      return {
        ok: true,
        unlocked: response.body.unlocked === true,
        expiresAt: response.body.expiresAt ?? null,
        durationSeconds: response.body.durationSeconds ?? null,
        serverTime: Number.isFinite(response.body.serverTime) ? response.body.serverTime : null,
      };
    }
    return { ok: false, kind: "input", error: "UNKNOWN_ACTION" };
  }

  function newOperationKey() {
    const bytes = new Uint8Array(18);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function newRecoveryToken() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function isTabOpen(tabId) {
    if (!Number.isSafeInteger(tabId) || tabId < 0 || typeof chrome.tabs?.query !== "function") return true;
    try {
      const tabs = await chrome.tabs.query({});
      return tabs.some((tab) => tab.id === tabId);
    } catch { return true; }
  }

  function flexibleRequest(type, message, ownerTabId, credential) {
    const key = String(ownerTabId);
    const existing = flexibleRequestsInFlight.get(key);
    if (existing) return existing.type === type ? existing.promise : Promise.resolve({ ok: false, kind: "pending-operation", message: "Eine Flexible-Usage-Aktion wird für diesen Tab bereits geprüft." });
    const promise = performFlexibleRequest(type, message, ownerTabId, credential).finally(() => {
      if (flexibleRequestsInFlight.get(key)?.promise === promise) flexibleRequestsInFlight.delete(key);
    });
    flexibleRequestsInFlight.set(key, { type, promise });
    return promise;
  }

  async function recoverFlexibleState(state, ownerContext, ownerTabId, credential, sessions, pendingOperations) {
    let operation = pendingOperations.recovery;
    if (!operation) {
      operation = { siteUrl: credential.siteUrl, ownerTabId, type: "youtube-flexible-recover", sessionId: state.session.sessionId,
        expectedEpoch: ownerContext.ownershipEpoch, recoveryToken: ownerContext.recoveryToken, operationKey: newOperationKey() };
      pendingOperations.recovery = operation;
      await chrome.storage.local.set({ [FLEXIBLE_PENDING_KEY]: pendingOperations });
    }
    if (operation.sessionId !== state.session.sessionId || operation.expectedEpoch !== ownerContext.ownershipEpoch || operation.ownerTabId !== ownerTabId
      || operation.recoveryToken !== ownerContext.recoveryToken) {
      return { ok: false, kind: "pending-operation", message: "Ein Sitzungswechsel wird noch sicher abgeglichen." };
    }
    return await performFlexibleRequest("youtube-flexible-recover", {}, ownerTabId, credential);
  }

  async function performFlexibleRequest(type, message, ownerTabId, credential) {
    if (!Number.isSafeInteger(ownerTabId) || ownerTabId < 0) return { ok: false, kind: "input", message: "Ungültiger YouTube-Tab." };
    const stored = await chrome.storage.local.get([FLEXIBLE_STATE_KEY, FLEXIBLE_PENDING_KEY, FLEXIBLE_OWNER_KEY]);
    const sessions = stored[FLEXIBLE_STATE_KEY] && typeof stored[FLEXIBLE_STATE_KEY] === "object" ? stored[FLEXIBLE_STATE_KEY] : {};
    const pendingOperations = stored[FLEXIBLE_PENDING_KEY] && typeof stored[FLEXIBLE_PENDING_KEY] === "object" ? stored[FLEXIBLE_PENDING_KEY] : {};
    const ownerContext = stored[FLEXIBLE_OWNER_KEY] && stored[FLEXIBLE_OWNER_KEY].siteUrl === credential.siteUrl
      ? stored[FLEXIBLE_OWNER_KEY] : null;
    const current = sessions[String(ownerTabId)] ?? null;
    const pending = pendingOperations[String(ownerTabId)] ?? null;
    const recoveryPending = pendingOperations.recovery ?? pendingOperations.recoveryResult ?? null;
    if (type === "youtube-flexible-state") {
      if (recoveryPending?.type === "youtube-flexible-recover" && recoveryPending.siteUrl === credential.siteUrl
        && recoveryPending.ownerTabId === ownerTabId) {
        return await performFlexibleRequest("youtube-flexible-recover", {}, ownerTabId, credential);
      }
      const response = await sendJson(`${credential.siteUrl}/extension/youtube/flexible/state`, {
        method: "POST", headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ownerTabId }),
      });
      if (response.response.status === 401) { await clearCredential(); return { ok: false, kind: "unauthorized", error: "SESSION_REQUIRED" }; }
      if (response.response.status === 503 || !response.response.ok) return { ok: false, kind: response.response.status === 503 ? "network" : response.response.status === 404 ? "disabled" : "rejected", message: response.body.error || "Flexible session state is unavailable." };
      const result = response.body;
      result.flexibleUsageEnabled = isLocalConvexSiteUrl(credential.siteUrl) && localFlexibleRateOptIn && result.flexibleUsageEnabled === true;
      await chrome.storage.local.set({ focusRewardsYouTubePricingRates: { ...(stored.focusRewardsYouTubePricingRates || {}),
        flexibleUsageEnabled: result.flexibleUsageEnabled } });
      if (result.session?.status === "active" && result.activeElsewhere === true) {
        if (recoveryPending?.sessionId === result.session.sessionId && recoveryPending.siteUrl === credential.siteUrl
          && recoveryPending.operationKey === result.session.latestOperationKey
          && result.session.ownershipEpoch === recoveryPending.expectedEpoch) {
          const previousOwner = { siteUrl: credential.siteUrl, ownerTabId: recoveryPending.ownerTabId, sessionId: result.session.sessionId,
            ownershipEpoch: result.session.ownershipEpoch, recoveryToken: recoveryPending.recoveryToken };
          if (pendingOperations.recovery?.operationKey === recoveryPending.operationKey) delete pendingOperations.recovery;
          if (pendingOperations.recoveryResult?.operationKey === recoveryPending.operationKey) delete pendingOperations.recoveryResult;
          await chrome.storage.local.set({ [FLEXIBLE_PENDING_KEY]: pendingOperations, [FLEXIBLE_OWNER_KEY]: previousOwner });
          if (recoveryPending.ownerTabId === ownerTabId) {
            await chrome.storage.local.set({ [FLEXIBLE_STATE_KEY]: { ...sessions, [String(ownerTabId)]: { ...result.session, ownerTabId, siteUrl: credential.siteUrl } } });
            return { ok: true, ...result, recovered: true };
          }
          return await recoverFlexibleState(result, previousOwner, ownerTabId, credential, sessions, pendingOperations);
        }
        const interruptedStart = Object.entries(pendingOperations).find(([tabId, candidate]) => tabId !== "recovery" && tabId !== "recoveryResult"
          && candidate?.type === "youtube-flexible-start" && candidate.siteUrl === credential.siteUrl
          && typeof candidate.recoveryToken === "string" && /^[a-f0-9]{64}$/.test(candidate.recoveryToken));
        if (interruptedStart) {
          const [oldTabKey, startOperation] = interruptedStart;
          const oldTabId = Number(oldTabKey);
          if (await isTabOpen(oldTabId)) return { ok: false, kind: "active-elsewhere", session: result.session,
            rateCoinsPerMinute: result.rateCoinsPerMinute, serverTime: result.serverTime };
          delete pendingOperations[oldTabKey];
          await chrome.storage.local.set({ [FLEXIBLE_PENDING_KEY]: pendingOperations });
          const interruptedOwner = { siteUrl: credential.siteUrl, ownerTabId: oldTabId, sessionId: result.session.sessionId,
            ownershipEpoch: result.session.ownershipEpoch, recoveryToken: startOperation.recoveryToken };
          await chrome.storage.local.set({ [FLEXIBLE_OWNER_KEY]: interruptedOwner });
          return await recoverFlexibleState(result, interruptedOwner, ownerTabId, credential, sessions, pendingOperations);
        }
        const canRecover = ownerContext?.sessionId === result.session.sessionId && ownerContext.siteUrl === credential.siteUrl
          && typeof ownerContext.recoveryToken === "string" && /^[a-f0-9]{64}$/.test(ownerContext.recoveryToken)
          && Number.isSafeInteger(result.session.ownershipEpoch) && result.session.ownershipEpoch === ownerContext.ownershipEpoch
          && result.session.ownerTabId === ownerContext.ownerTabId && result.session.ownerTabId !== ownerTabId
          && !(await isTabOpen(ownerContext.ownerTabId));
        if (canRecover) return await recoverFlexibleState(result, ownerContext, ownerTabId, credential, sessions, pendingOperations);
        return { ok: false, kind: "active-elsewhere", session: result.session, rateCoinsPerMinute: result.rateCoinsPerMinute, serverTime: result.serverTime };
      }
      if (result.session?.status === "active" && result.activeElsewhere !== true) {
        if (recoveryPending?.sessionId === result.session.sessionId && recoveryPending.siteUrl === credential.siteUrl
          && recoveryPending.ownerTabId === ownerTabId && recoveryPending.expectedEpoch === result.session.ownershipEpoch - 1
          && recoveryPending.operationKey === result.session.latestOperationKey && result.session.ownerTabId === ownerTabId) {
          delete pendingOperations.recovery;
          await chrome.storage.local.set({ [FLEXIBLE_PENDING_KEY]: pendingOperations });
          await chrome.storage.local.set({ [FLEXIBLE_OWNER_KEY]: { siteUrl: credential.siteUrl, ownerTabId, sessionId: result.session.sessionId,
            ownershipEpoch: result.session.ownershipEpoch, recoveryToken: recoveryPending.recoveryToken } });
          await chrome.storage.local.set({ [FLEXIBLE_STATE_KEY]: { ...sessions, [String(ownerTabId)]: { ...result.session, ownerTabId, siteUrl: credential.siteUrl } } });
          return { ok: true, ...result, recovered: true };
        }
        if (pending?.type === "youtube-flexible-start" && pending.siteUrl === credential.siteUrl && pending.ownerTabId === ownerTabId
          && result.session.latestOperationKey === pending.operationKey) {
          return await performFlexibleRequest("youtube-flexible-start", {}, ownerTabId, credential);
        }
        await chrome.storage.local.set({
          [FLEXIBLE_STATE_KEY]: { ...sessions, [String(ownerTabId)]: { ...result.session, ownerTabId, siteUrl: credential.siteUrl } },
          [FLEXIBLE_OWNER_KEY]: { siteUrl: credential.siteUrl, ownerTabId, sessionId: result.session.sessionId, ownershipEpoch: result.session.ownershipEpoch,
            recoveryToken: ownerContext?.sessionId === result.session.sessionId ? ownerContext.recoveryToken : undefined },
        });
      } else if (current) { delete sessions[String(ownerTabId)]; await chrome.storage.local.set({ [FLEXIBLE_STATE_KEY]: sessions }); }
      if (pending && (result.session?.latestOperationKey === pending.operationKey || result.session?.stopOperationKey === pending.operationKey || result.session?.status !== "active")) {
        delete pendingOperations[String(ownerTabId)];
        await chrome.storage.local.set({ [FLEXIBLE_PENDING_KEY]: pendingOperations });
      }
      if (recoveryPending && result.session?.status !== "active") {
        delete pendingOperations.recovery;
        await chrome.storage.local.set({ [FLEXIBLE_PENDING_KEY]: pendingOperations });
      }
      return { ok: true, ...result };
    }

    if (type === "youtube-flexible-recover" && recoveryPending?.type === type
      && (recoveryPending.siteUrl !== credential.siteUrl || recoveryPending.ownerTabId !== ownerTabId)) {
      return { ok: false, kind: "pending-operation", message: "Ein vorheriger Wiederherstellungsvorgang ist noch unbestätigt. Wiederhole zuerst denselben Vorgang." };
    }
    if (type !== "youtube-flexible-recover" && pending && (pending.siteUrl !== credential.siteUrl || pending.ownerTabId !== ownerTabId || pending.type !== type)) {
      return { ok: false, kind: "pending-operation", message: "Ein vorheriger flexibler Abrechnungsvorgang ist noch unbestätigt. Wiederhole zuerst denselben Vorgang." };
    }
    let operation = type === "youtube-flexible-recover" ? recoveryPending : pending;
    if (!operation) {
      if (type === "youtube-flexible-start") {
        operation = { siteUrl: credential.siteUrl, ownerTabId, type, startKey: newOperationKey(), operationKey: newOperationKey(), recoveryToken: newRecoveryToken() };
      } else if (type === "youtube-flexible-recover") {
        if (!ownerContext || ownerContext.siteUrl !== credential.siteUrl || ownerContext.ownerTabId === ownerTabId
          || typeof ownerContext.recoveryToken !== "string" || !/^[a-f0-9]{64}$/.test(ownerContext.recoveryToken)
          || !Number.isSafeInteger(ownerContext.ownershipEpoch)) {
          return { ok: false, kind: "invalid-session", message: "Keine wiederherstellbare Flexible-Usage-Sitzung vorhanden." };
        }
        operation = { siteUrl: credential.siteUrl, ownerTabId, type, operationKey: newOperationKey(), sessionId: ownerContext.sessionId,
          expectedEpoch: ownerContext.ownershipEpoch, recoveryToken: ownerContext.recoveryToken };
      } else {
        if (!current || current.siteUrl !== credential.siteUrl || current.ownerTabId !== ownerTabId || current.status !== "active") return { ok: false, kind: "invalid-session", message: "Keine aktive Flexible-Usage-Sitzung in diesem Tab." };
        if (type === "youtube-flexible-renew" && message.expectedSequence !== current.sequence) return { ok: false, kind: "stale-session", message: "Flexible-Usage-Sitzung ist nicht mehr aktuell." };
        operation = { siteUrl: credential.siteUrl, ownerTabId, type, operationKey: newOperationKey(), sessionId: current.sessionId, ownershipEpoch: current.ownershipEpoch,
          ...(type === "youtube-flexible-renew" ? { expectedSequence: current.sequence } : {}) };
      }
      if (type === "youtube-flexible-recover") pendingOperations.recovery = operation;
      else pendingOperations[String(ownerTabId)] = operation;
      await chrome.storage.local.set({ [FLEXIBLE_PENDING_KEY]: pendingOperations });
    }
    const route = type === "youtube-flexible-start" ? "start" : type === "youtube-flexible-renew" ? "renew" : type === "youtube-flexible-stop" ? "stop" : "recover";
    const payload = { ownerTabId, operationKey: operation.operationKey,
      ...(route === "start" ? { startKey: operation.startKey, recoveryToken: operation.recoveryToken,
        ...(Number.isSafeInteger(operation.expectedEpoch) ? { expectedEpoch: operation.expectedEpoch } : {}) } : { sessionId: operation.sessionId }),
      ...(route === "renew" ? { expectedSequence: operation.expectedSequence } : {}),
      ...(route === "renew" || route === "stop" ? { ownershipEpoch: operation.ownershipEpoch } : {}),
      ...(route === "recover" ? { expectedEpoch: operation.expectedEpoch, recoveryToken: operation.recoveryToken } : {}) };
    const response = await sendJson(`${credential.siteUrl}/extension/youtube/flexible/${route}`, {
      method: "POST", headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    if (response.response.status === 401) { await clearCredential(); return { ok: false, kind: "unauthorized", error: "SESSION_REQUIRED" }; }
    if (response.response.status === 402) {
      delete pendingOperations[String(ownerTabId)];
      if (route === "recover") delete pendingOperations.recovery;
      await chrome.storage.local.set({ [FLEXIBLE_PENDING_KEY]: pendingOperations });
      if (route === "renew") {
        delete sessions[String(ownerTabId)];
        await chrome.storage.local.set({ [FLEXIBLE_STATE_KEY]: sessions });
      }
      return { ok: false, kind: "insufficient-coins", message: "Dein Coin-Guthaben reicht für das nächste Shorts-Intervall nicht aus." };
    }
    if (response.response.status === 503) return { ok: false, kind: "network", message: "Flexible Abrechnung nicht erreichbar. Wiedergabe bleibt bis zur Serverbestätigung gesperrt." };
    if (response.response.status === 404) return { ok: false, kind: "disabled", message: "Flexible Nutzung ist für diese Convex-Umgebung deaktiviert." };
    if (!response.response.ok) {
      if (route === "recover" && response.response.status === 409) {
        const latest = await sendJson(`${credential.siteUrl}/extension/youtube/flexible/state`, {
          method: "POST", headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ ownerTabId }),
        });
        if (latest.response.ok && latest.body.session?.status === "active" && latest.body.activeElsewhere === false) {
          delete pendingOperations.recovery;
          await chrome.storage.local.set({ [FLEXIBLE_PENDING_KEY]: pendingOperations });
          await chrome.storage.local.set({
            [FLEXIBLE_STATE_KEY]: { ...sessions, [String(ownerTabId)]: { ...latest.body.session, ownerTabId, siteUrl: credential.siteUrl } },
            [FLEXIBLE_OWNER_KEY]: { siteUrl: credential.siteUrl, ownerTabId, sessionId: latest.body.session.sessionId, ownershipEpoch: latest.body.session.ownershipEpoch, recoveryToken: operation.recoveryToken },
          });
          return { ok: true, ...latest.body, recovered: true };
        }
      }
      return { ok: false, kind: "rejected", message: response.body.error || "Flexible Abrechnung wurde abgelehnt." };
    }
    const result = response.body;
    result.flexibleUsageEnabled = isLocalConvexSiteUrl(credential.siteUrl) && localFlexibleRateOptIn && result.flexibleUsageEnabled === true;
    if (route === "recover") delete pendingOperations.recovery;
    else delete pendingOperations[String(ownerTabId)];
    await chrome.storage.local.set({ [FLEXIBLE_PENDING_KEY]: pendingOperations });
    if (result.status === "active") {
      const nextSessions = { ...sessions, [String(ownerTabId)]: { ...result, ownerTabId, siteUrl: credential.siteUrl } };
      await chrome.storage.local.set({ [FLEXIBLE_STATE_KEY]: nextSessions,
        [FLEXIBLE_OWNER_KEY]: { siteUrl: credential.siteUrl, ownerTabId, sessionId: result.sessionId, ownershipEpoch: result.ownershipEpoch,
          recoveryToken: operation.recoveryToken ?? ownerContext?.recoveryToken } });
    } else { delete sessions[String(ownerTabId)]; await chrome.storage.local.set({ [FLEXIBLE_STATE_KEY]: sessions }); }
    await chrome.storage.local.set({ focusRewardsYouTubePricingRates: { ...(stored.focusRewardsYouTubePricingRates || {}), flexibleUsageEnabled: isLocalConvexSiteUrl(credential.siteUrl) && result.flexibleUsageEnabled === true } });
    return { ok: true, ...result };
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
    if (fromPopup && ["status", "youtube-balance", "youtube-pricing-rates", "youtube-pricing-save"].includes(message.type)) {
      const request = message.type === "status" ? status() : youtubeRequest(message.type, message);
      request.then(sendResponse).catch(() => sendResponse({ ok: false, kind: "network", message: "Die Erweiterungssitzung konnte nicht geprüft werden." }));
      return true;
    }
    const flexibleTypes = ["youtube-flexible-state", "youtube-flexible-start", "youtube-flexible-renew", "youtube-flexible-stop"];
    if (!fromYouTubePage || !["status", "youtube-quote", "youtube-purchase", "youtube-entitlement", "youtube-estimates", "youtube-pricing-rates", "youtube-balance", "youtube-shorts-time", ...flexibleTypes].includes(message.type)) return false;
    const request = message.type === "status" ? status()
      : flexibleTypes.includes(message.type) ? getCredential().then((credential) => credential ? flexibleRequest(message.type, message, sender.tab.id, credential) : { ok: false, kind: "unauthorized", error: "SESSION_REQUIRED" })
        : youtubeRequest(message.type, message);
    request.then(sendResponse).catch(() => sendResponse({ ok: false, kind: "network", message: "The request failed. Check your connection and try again." }));
    return true;
  });
})();
