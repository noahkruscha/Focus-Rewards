(function () {
  "use strict";

  const SETTING = "youtubePriceIndicatorEnabled";
  const DEFAULT_STANDARD_RATE = 1.2;
  const DEFAULT_SHORTS_RATE = 1.4;
  const CARD_SELECTOR = "ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer";
  const DURATION_SELECTOR = "ytd-thumbnail-overlay-time-status-renderer, yt-thumbnail-badge-view-model";
  const BADGE_CLASS = "fr-youtube-price";
  const LIVE_OR_DURATION_SELECTOR = "ytd-thumbnail-overlay-time-status-renderer, ytd-badge-supported-renderer";
  let enabled = true;
  let accountState = { ok: false, signedIn: false };
  let pendingPurchase = null;
  let pendingShortsPurchase = null;
  let purchaseSubmitting = false;
  let activeContentKey = null;
  let currentBalance = null;
  let balanceStatus = "disconnected";
  let currentShortsExpiry = null;
  let entitlementState = "checking";
  let entitlementExpiresAt = null;
  let serverClockOffsetMs = 0;
  let balanceRefreshTimer = 0;
  let balanceRequestId = 0;
  let entitlementExpiryTimer = 0;
  let entitlementCheckKey = null;
  let entitlementCheckPromise = null;
  let entitlementCheckCompletedKey = null;
  let shortsPurchasePanelOpen = false;
  let shortsWatchedMs = 0;
  let shortsLastTickAt = null;
  let nextShortsReminderMinute = 10;
  let shortsReminderTimer = 0;
  let observer;
  let scanTimer = 0;
  let pricingRates = { standardCoinsPerMinute: DEFAULT_STANDARD_RATE, shortsCoinsPerMinute: DEFAULT_SHORTS_RATE, flexibleCoinsPerMinute: 1.6, flexibleUsageEnabled: false };

  function isLive(card) {
    return Array.from(card.querySelectorAll(LIVE_OR_DURATION_SELECTOR)).some((node) => {
      const label = `${node.getAttribute("aria-label") || ""} ${node.textContent || ""}`;
      return /\blive\b/i.test(label);
    });
  }

  function durationFor(card) {
    for (const node of card.querySelectorAll(DURATION_SELECTOR)) {
      const label = node.getAttribute("aria-label") || "";
      const duration = window.FocusRewardsPricing.parseDurationSeconds(label)
        ?? window.FocusRewardsPricing.parseDurationSeconds(node.textContent || "");
      if (duration) return duration;
    }
    return null;
  }

  function findMenu(card) {
    return card.querySelector("ytd-menu-renderer")
      || card.querySelector('button[aria-label*="More"]')
      || card.querySelector('button[aria-label*="Options"]');
  }

  function removeBadge(card) {
    card.querySelectorAll(`.${BADGE_CLASS}`).forEach((badge) => badge.remove());
  }

  function shouldHideShortCard(card) {
    const path = location.pathname;
    return path === "/" || path.startsWith("/feed/")
      || (path === "/watch" && Boolean(card.closest?.("#secondary")))
      || path.startsWith("/results");
  }

  function updateShortsVisibility(card, isShort) {
    const hide = isShort && shouldHideShortCard(card);
    if (hide) card.classList.add("fr-youtube-filtered-short");
    else card.classList.remove("fr-youtube-filtered-short");
  }

  function currentContent() {
    const path = location.pathname;
    const short = path.match(/^\/shorts\/([A-Za-z0-9_-]{11})\/?$/);
    if (short) return { videoId: short[1], contentType: "youtube_short" };
    const videoId = path === "/watch" ? new URL(location.href).searchParams.get("v") : null;
    return videoId && /^[A-Za-z0-9_-]{11}$/.test(videoId) ? { videoId, contentType: "youtube_video" } : null;
  }

  function serverNow() {
    return Date.now() + serverClockOffsetMs;
  }

  function extensionRequest(type, payload = {}) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, ...payload }, (result) => {
        if (chrome.runtime.lastError) resolve({ ok: false, kind: "network", error: "NETWORK_ERROR" });
        else resolve(result ?? { ok: false, kind: "network", error: "NETWORK_ERROR" });
      });
    });
  }

  function pageContext() {
    return document.querySelector("ytd-watch-flexy") || document.querySelector("ytd-player")
      || document.querySelector("ytd-shorts") || document.querySelector("ytd-reel-video-renderer");
  }

  function removePurchaseUi() {
    document.querySelectorAll(".fr-youtube-purchase").forEach((node) => node.remove());
    document.documentElement.classList.remove("fr-youtube-blocked");
  }

  function openExtensionControls() {
    if (!currentContent() || !accountState.signedIn) {
      window.open(chrome.runtime.getURL("options/options.html"), "_blank", "noopener");
      return;
    }
    renderPurchaseUi(true);
  }

  function updateBalance() {
    let indicator = document.querySelector(".fr-youtube-balance");
    if (!indicator) {
      indicator = document.createElement("button");
      indicator.className = "fr-youtube-balance";
      indicator.type = "button";
      indicator.setAttribute("aria-label", "Focus Rewards coin balance");
      indicator.addEventListener("click", openExtensionControls);
    }
    if (!indicator.isConnected) {
      const nav = document.querySelector("#end #buttons") || document.querySelector("ytd-masthead #end");
      if (nav) nav.prepend(indicator);
      else return;
    }
    indicator.textContent = currentBalance !== null ? `◈ ${currentBalance}` : balanceStatus === "loading" ? "◈ ···" : balanceStatus === "error" ? "◈ nicht verfügbar" : "◈ Konto verbinden";
    indicator.dataset.state = currentBalance !== null ? "ready" : balanceStatus;
    indicator.title = currentBalance !== null ? `Focus Rewards · ${currentBalance} Coins` : balanceStatus === "error" ? "Coin-Guthaben kann derzeit nicht geladen werden" : balanceStatus === "loading" ? "Coin-Guthaben wird geladen" : "Focus-Rewards-Konto nicht verbunden";
    if (!document.querySelector(".fr-youtube-brand")) {
      const searchArea = document.querySelector("#center") || document.querySelector("ytd-masthead #center");
      const searchForm = searchArea?.querySelector("#search");
      if (searchArea && searchForm && window.innerWidth > 760) {
        const brand = document.createElement("button");
        brand.className = "fr-youtube-brand";
        brand.type = "button";
        brand.textContent = "Focus Rewards · YouTube-Freischaltung";
        brand.addEventListener("click", openExtensionControls);
        searchArea.append(brand);
      }
    } else {
      const brand = document.querySelector(".fr-youtube-brand");
      if (brand && !brand.isConnected) {
        const searchArea = document.querySelector("#center") || document.querySelector("ytd-masthead #center");
        if (searchArea?.querySelector("#search") && window.innerWidth > 760) searchArea.append(brand);
      }
    }
  }

  async function refreshBalance() {
    if (balanceRefreshTimer) window.clearTimeout(balanceRefreshTimer);
    const requestId = ++balanceRequestId;
    if (!accountState.signedIn) { currentBalance = null; balanceStatus = "disconnected"; currentShortsExpiry = null; updateBalance(); return; }
    balanceStatus = "loading";
    updateBalance();
    const result = await extensionRequest("youtube-balance");
    if (requestId !== balanceRequestId) return;
    if (!result?.ok) {
      currentBalance = null;
      balanceStatus = result?.kind === "unauthorized" ? "disconnected" : "error";
      currentShortsExpiry = null;
      if (result?.kind === "unauthorized") {
        accountState = { ok: true, signedIn: false };
        entitlementState = "blocked";
        entitlementExpiresAt = null;
        entitlementCheckCompletedKey = null;
        stopShortsReminderTimer();
        document.documentElement.classList.add("fr-youtube-blocked");
        pauseCurrentPlayer();
      }
      updateBalance();
      if (result?.kind === "unauthorized") renderPurchaseUi();
      balanceRefreshTimer = window.setTimeout(() => void refreshBalance(), 60_000);
      return;
    }
    if (Number.isFinite(result.serverTime)) serverClockOffsetMs = result.serverTime - Date.now();
    balanceStatus = "ready";
    currentBalance = result.coins;
    currentShortsExpiry = result.shortsExpiresAt;
    if (currentContent()?.contentType === "youtube_short" && currentShortsExpiry && currentShortsExpiry > serverNow()) {
      const content = currentContent();
      if (entitlementState !== "unlocked" || entitlementExpiresAt !== currentShortsExpiry) {
        entitlementState = "unlocked";
        entitlementExpiresAt = currentShortsExpiry;
        document.documentElement.classList.remove("fr-youtube-blocked");
        pauseCurrentPlayer(false);
        armEntitlementExpiry(content, currentShortsExpiry);
        startShortsReminderTimer();
      }
    } else if (currentContent()?.contentType === "youtube_short" && entitlementState === "unlocked") {
      entitlementState = "checking";
      entitlementExpiresAt = null;
      shortsWatchedMs = 0;
      shortsLastTickAt = null;
      nextShortsReminderMinute = 10;
      stopShortsReminderTimer();
      document.documentElement.classList.add("fr-youtube-blocked");
      pauseCurrentPlayer();
    }
    updateBalance();
    renderPurchaseUi();
    balanceRefreshTimer = window.setTimeout(() => void refreshBalance(), 60_000);
  }

  function renderPurchaseUi(forceOpen = false) {
    const content = currentContent();
    if (!content) {
      activeContentKey = null;
      entitlementState = "unlocked";
      shortsPurchasePanelOpen = false;
      entitlementCheckCompletedKey = null;
      if (shortsReminderTimer) stopShortsReminderTimer();
      removePurchaseUi();
      updateBalance();
      return;
    }
    if (activeContentKey !== `${content.contentType}:${content.videoId}`) {
      if (content.contentType !== "youtube_short") stopShortsReminderTimer();
      shortsLastTickAt = null;
      shortsPurchasePanelOpen = false;
      entitlementCheckCompletedKey = null;
      entitlementState = "checking";
      entitlementExpiresAt = null;
      document.documentElement.classList.add("fr-youtube-blocked");
      pauseCurrentPlayer();
    }
    const host = pageContext();
    updateBalance();
    if (!host) return;
    const durationText = document.querySelector(".ytp-time-duration")?.textContent || document.querySelector("ytd-player #movie_player")?.getAttribute("aria-label") || "";
    const contentKey = `${content.contentType}:${content.videoId}`;
    activeContentKey = contentKey;
    if (entitlementState === "unlocked" && entitlementExpiresAt !== null && entitlementExpiresAt <= serverNow()) {
      shortsPurchasePanelOpen = false;
      entitlementState = "checking";
      entitlementExpiresAt = null;
      document.documentElement.classList.add("fr-youtube-blocked");
      pauseCurrentPlayer();
    }
    if (entitlementState === "unlocked" && forceOpen && content.contentType === "youtube_short") shortsPurchasePanelOpen = true;
    const extendingShorts = shortsPurchasePanelOpen && content.contentType === "youtube_short"
      && entitlementState === "unlocked" && entitlementExpiresAt !== null && entitlementExpiresAt > serverNow();
    if (entitlementState === "unlocked" && !extendingShorts) {
      shortsPurchasePanelOpen = false;
      document.querySelectorAll(".fr-youtube-purchase").forEach((node) => node.remove());
      document.documentElement.classList.remove("fr-youtube-blocked");
      return;
    }
    if (pendingPurchase && pendingPurchase.contentKey !== contentKey) pendingPurchase = null;
    const durationSeconds = content.contentType === "youtube_short" ? 0 : window.FocusRewardsPricing.parseDurationSeconds(durationText);
    if (content.contentType === "youtube_video" && !durationSeconds) {
      entitlementState = "blocked";
      document.documentElement.classList.add("fr-youtube-blocked");
      pauseCurrentPlayer();
      let metadataPanel = document.querySelector(".fr-youtube-purchase");
      if (!metadataPanel) { metadataPanel = document.createElement("section"); metadataPanel.className = "fr-youtube-purchase"; document.body.append(metadataPanel); }
      metadataPanel.dataset.contentKey = contentKey;
      metadataPanel.setAttribute("role", "dialog");
      metadataPanel.setAttribute("aria-modal", "true");
      metadataPanel.setAttribute("aria-label", "Focus Rewards YouTube-Freischaltung");
      metadataPanel.replaceChildren();
      const status = document.createElement("span");
      status.className = "fr-youtube-message";
      status.setAttribute("role", "status");
      status.textContent = "Videodauer wird geladen. Die Wiedergabe bleibt gesperrt, bis der Server den Zugang bestätigen kann.";
      metadataPanel.append(status);
      if (accountState.signedIn && metadataPanel.dataset.entitlementCheckStarted !== "true") {
        metadataPanel.dataset.entitlementCheckStarted = "true";
        void verifyContentEntitlement(content, metadataPanel);
      }
      return;
    }
    const accountKey = accountState.signedIn ? "linked" : "unlinked";
    let panel = document.querySelector(".fr-youtube-purchase");
    if (panel?.dataset.contentKey === contentKey && panel.dataset.accountState === accountKey
      && panel.dataset.durationSeconds === String(durationSeconds)) {
      refreshShortsChoices(panel);
      updateStandardPurchaseAction(panel);
      if (accountState.signedIn && entitlementState === "checking") void verifyContentEntitlement(content, panel);
      if (accountState.signedIn && content.contentType === "youtube_video" && !panel.dataset.quoteId) void loadPurchaseQuote(content, durationSeconds, panel, panel.querySelector("button"), panel.querySelector(".fr-youtube-message"));
      return;
    }
    if (!panel) {
      panel = document.createElement("section");
      panel.className = "fr-youtube-purchase";
      document.body.append(panel);
    }
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", "Focus Rewards YouTube-Freischaltung");
    panel.dataset.contentKey = contentKey;
    panel.dataset.accountState = accountKey;
    panel.dataset.durationSeconds = String(durationSeconds);
    delete panel.dataset.quoteId;
    delete panel.dataset.quoteRate;
    delete panel.dataset.entitlementError;
    panel.replaceChildren();
    const heading = document.createElement("strong");
    heading.textContent = "Focus Rewards · YouTube-Freischaltung";
    const videoHeading = document.createElement("span");
    videoHeading.className = "fr-youtube-video-title";
    videoHeading.textContent = document.querySelector("h1.ytd-watch-metadata")?.textContent?.trim() || document.querySelector("ytd-reel-video-renderer h2")?.textContent?.trim() || "YouTube-Video";
    const message = document.createElement("span");
    message.className = "fr-youtube-message";
    message.setAttribute("role", "status");
    message.setAttribute("aria-live", "polite");
    const action = document.createElement("button");
    action.type = "button";
    action.textContent = content.contentType === "youtube_short" ? (accountState.signedIn ? "Shorts-Zeit wählen" : "Konto verbinden") : (accountState.signedIn ? "Preis wird geladen…" : "Konto verbinden");
    action.disabled = accountState.signedIn && content.contentType === "youtube_video";
    action.hidden = content.contentType === "youtube_short" && accountState.signedIn;
    action.addEventListener("click", async () => {
      if (purchaseSubmitting) return;
      if (!accountState.signedIn) {
        const optionsUrl = chrome.runtime.getURL("options/options.html");
        window.open(optionsUrl, "_blank", "noopener");
        message.textContent = "Verbinde zuerst dein Focus-Rewards-Konto in den Erweiterungseinstellungen.";
        return;
      }
      if (content.contentType !== "youtube_video") {
        panel.querySelector(".fr-shorts-options button[data-minutes]")?.focus();
        return;
      }
      if (panel.dataset.entitlementError === "network") {
        delete panel.dataset.entitlementError;
        entitlementState = "checking";
        entitlementCheckCompletedKey = null;
        action.disabled = true;
        action.textContent = "Freischaltung wird geprüft…";
        message.textContent = "Der Serverzugang wird erneut geprüft. Die Wiedergabe bleibt bis zur Bestätigung gesperrt.";
        await verifyContentEntitlement(content, panel);
        if (panel.isConnected && entitlementState === "blocked") updateStandardPurchaseAction(panel);
        return;
      }
      purchaseSubmitting = true;
      action.disabled = true;
      message.textContent = "Kauf wird sicher vom Server geprüft…";
      pendingPurchase ??= { contentKey, idempotencyKey: makeIdempotencyKey() };
      const result = await extensionRequest("youtube-purchase", {
        videoId: content.videoId,
        contentType: content.contentType,
        durationSeconds,
        idempotencyKey: pendingPurchase.idempotencyKey,
        quoteId: panel.dataset.quoteId,
      });
      if (result.ok) {
        pendingPurchase = null;
        await refreshBalance();
        if (panel.isConnected && panel.dataset.contentKey === `${content.contentType}:${content.videoId}`) {
          message.textContent = result.alreadyOwned ? "Eine gültige Freischaltung wurde vom Server bestätigt." : `Kauf vom Server bestätigt. Gültig bis ${new Date(result.expiresAt).toLocaleDateString("de-DE")}.`;
          await verifyContentEntitlement(content, panel);
        }
      } else if (result.kind === "insufficient-coins") {
        pendingPurchase = null;
        if (panel.isConnected && panel.dataset.contentKey === `${content.contentType}:${content.videoId}`) message.textContent = "Dein Coin-Guthaben reicht für diese Freischaltung nicht aus.";
      } else if (result.kind === "unauthorized") {
        accountState = { ok: true, signedIn: false };
        pendingPurchase = null;
        if (panel.isConnected && panel.dataset.contentKey === `${content.contentType}:${content.videoId}`) message.textContent = "Deine Anmeldung ist abgelaufen oder widerrufen. Bitte verknüpfe dein Konto erneut.";
      } else if (result.kind === "network") {
        if (panel.isConnected && panel.dataset.contentKey === `${content.contentType}:${content.videoId}`) message.textContent = "Verbindungsfehler. Der Kauf ist nicht bestätigt. Bitte erneut versuchen.";
      } else {
        pendingPurchase = null;
        if (panel.isConnected && panel.dataset.contentKey === `${content.contentType}:${content.videoId}`) message.textContent = "Der Kauf konnte nicht bestätigt werden. Bitte prüfe dein Konto und versuche es erneut.";
      }
      purchaseSubmitting = false;
      if (panel.isConnected && panel.dataset.contentKey === `${content.contentType}:${content.videoId}`) action.disabled = false;
    });
    if (panel.parentElement !== document.body) document.body.append(panel);
    panel.append(heading, videoHeading, action, message);
    if (extendingShorts) message.textContent = `Shorts-Zeit läuft bis ${new Date(entitlementExpiresAt).toLocaleTimeString("de-DE")}. Du kannst zusätzliche Zeit buchen.`;
    if (content.contentType === "youtube_video") {
      const duration = document.createElement("span");
      duration.className = "fr-youtube-duration";
      duration.textContent = `Länge: ${durationText}`;
      panel.insertBefore(duration, action);
    }
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "fr-youtube-cancel";
    cancel.textContent = extendingShorts ? "Weiter ansehen" : "Zurück zu YouTube";
    cancel.addEventListener("click", () => {
      if (extendingShorts) {
        shortsPurchasePanelOpen = false;
        panel.remove();
      } else location.href = "https://www.youtube.com/";
    });
    panel.append(cancel);
    if (content.contentType === "youtube_short") {
      const options = document.createElement("div");
      options.className = "fr-shorts-options";
      const title = document.createElement("span");
      title.textContent = "Shorts-Zeit statt Einzelkauf";
      options.append(title);
      for (const minutes of [5, 10, 30]) {
        const choice = document.createElement("button");
        choice.type = "button";
        choice.dataset.minutes = String(minutes);
        choice.textContent = `${minutes} Minuten`;
        choice.disabled = !accountState.signedIn || currentBalance === null || currentBalance < Math.ceil(minutes * pricingRates.shortsCoinsPerMinute);
        choice.addEventListener("click", async () => {
          if (!accountState.signedIn) {
            window.open(chrome.runtime.getURL("options/options.html"), "_blank", "noopener");
            message.textContent = "Verbinde zuerst dein Focus-Rewards-Konto in den Erweiterungseinstellungen.";
            return;
          }
          if (pendingShortsPurchase && pendingShortsPurchase.minutes !== minutes) {
            message.textContent = "Ein vorheriger Kauf ist noch nicht sicher bestätigt. Wiederhole dieselbe Auswahl, bevor du eine andere Shorts-Zeit kaufst.";
            return;
          }
          choice.disabled = true;
          message.textContent = "Shorts-Zeit wird serverseitig geprüft…";
          pendingShortsPurchase ??= { contentKey, minutes, idempotencyKey: makeIdempotencyKey() };
          const purchase = await extensionRequest("youtube-shorts-time", { minutes, idempotencyKey: pendingShortsPurchase.idempotencyKey });
          if (!panel.isConnected) { choice.disabled = false; return; }
          if (purchase.ok) {
            pendingShortsPurchase = null;
            currentShortsExpiry = purchase.expiresAt;
            if (accountState.signedIn && activeContentKey === `${content.contentType}:${content.videoId}` && currentContent()?.contentType === "youtube_short") {
              entitlementState = "unlocked";
              entitlementExpiresAt = purchase.expiresAt;
              document.documentElement.classList.remove("fr-youtube-blocked");
              pauseCurrentPlayer(false);
              armEntitlementExpiry(content, purchase.expiresAt);
              startShortsReminderTimer();
            }
            message.textContent = `Serverbestätigt. Shorts verfügbar bis ${new Date(purchase.expiresAt).toLocaleTimeString("de-DE")}.`;
            await refreshBalance();
            if (activeContentKey === `${content.contentType}:${content.videoId}`) await verifyContentEntitlement(content, panel);
          } else {
            if (purchase.kind !== "network") pendingShortsPurchase = null;
            message.textContent = purchase.message || "Shorts-Zeit konnte nicht gekauft werden.";
          }
          choice.disabled = false;
        });
        options.append(choice);
      }
      panel.append(options);
      refreshShortsChoices(panel);
    }
    if (accountState.signedIn) {
      if (content.contentType === "youtube_video") void loadPurchaseQuote(content, durationSeconds, panel, action, message);
      if (!extendingShorts) void verifyContentEntitlement(content, panel);
    } else {
      entitlementState = "blocked";
      document.documentElement.classList.add("fr-youtube-blocked");
    }
  }

  async function loadPurchaseQuote(content, durationSeconds, panel, action, message) {
    const quote = await extensionRequest("youtube-quote", { ...content, durationSeconds });
    const key = `${content.contentType}:${content.videoId}`;
    if (activeContentKey !== key || !panel.isConnected) return;
    if (!quote.ok) {
      message.textContent = quote.kind === "network" ? "Preis konnte nicht geladen werden. Bitte Verbindung prüfen." : "Preis für dieses Video ist nicht verfügbar.";
      action.disabled = true;
      return;
    }
    panel.dataset.quoteId = quote.quoteId;
    panel.dataset.quotePrice = String(quote.price);
    panel.dataset.quoteRate = String(quote.rateCoinsPerMinute);
    action.textContent = `Für ${quote.price} Coins freischalten · 18 Stunden`;
    action.disabled = true;
    message.textContent = `Serverpreis: ${String(quote.rateCoinsPerMinute).replace(".", ",")} Coins pro Minute. Guthaben wird geprüft…`;
    updateStandardPurchaseAction(panel);
  }

  function verifyContentEntitlement(content, panel) {
    const key = `${content.contentType}:${content.videoId}`;
    if (entitlementCheckKey === key && entitlementCheckPromise) return entitlementCheckPromise;
    if (entitlementCheckCompletedKey === key && entitlementState !== "checking") return Promise.resolve();
    entitlementCheckKey = key;
    const request = performContentEntitlementCheck(content, panel, key);
    entitlementCheckPromise = request.finally(() => {
      if (entitlementCheckPromise === wrappedRequest) {
        entitlementCheckKey = null;
        entitlementCheckPromise = null;
      }
    });
    const wrappedRequest = entitlementCheckPromise;
    return wrappedRequest;
  }

  async function performContentEntitlementCheck(content, panel, key) {
    activeContentKey = key;
    const result = await extensionRequest("youtube-entitlement", content);
    if (activeContentKey !== key || currentContent()?.videoId !== content.videoId || currentContent()?.contentType !== content.contentType) return;
    if (result.ok && result.unlocked) {
      entitlementState = "unlocked";
      entitlementExpiresAt = result.expiresAt;
      if (Number.isFinite(result.serverTime)) serverClockOffsetMs = result.serverTime - Date.now();
      entitlementCheckCompletedKey = key;
      if (content.contentType === "youtube_short") startShortsReminderTimer();
      document.documentElement.classList.remove("fr-youtube-blocked");
      pauseCurrentPlayer(false);
      if (panel?.isConnected) panel.remove();
      armEntitlementExpiry(content, result.expiresAt);
      return;
    }
    if (!result.ok && result.kind !== "network") entitlementCheckCompletedKey = key;
    if (result.ok && !result.unlocked) entitlementCheckCompletedKey = key;
    if (!panel?.isConnected) {
      entitlementState = "blocked";
      entitlementExpiresAt = null;
      if (content.contentType === "youtube_short") stopShortsReminderTimer();
      document.documentElement.classList.add("fr-youtube-blocked");
      pauseCurrentPlayer();
      renderPurchaseUi();
      return;
    }
    const message = panel.querySelector(".fr-youtube-message");
    if (!result.ok) {
      entitlementState = "blocked";
      document.documentElement.classList.add("fr-youtube-blocked");
      if (result.kind === "unauthorized") { accountState = { ok: true, signedIn: false }; currentBalance = null; updateBalance(); }
      if (result.kind === "network") {
        entitlementCheckCompletedKey = null;
        panel.dataset.entitlementError = "network";
      } else {
        delete panel.dataset.entitlementError;
      }
      message.textContent = result.kind === "network" ? "Offline kann der Server die Freischaltung nicht bestätigen. Wiedergabe bleibt gesperrt." : "Melde dich in den Erweiterungseinstellungen an. Wiedergabe bleibt gesperrt.";
      if (result.kind === "network" && content.contentType === "youtube_video") {
        const retryAction = panel.querySelector("button:not(.fr-youtube-cancel)");
        if (retryAction) { retryAction.textContent = "Zugang erneut prüfen"; retryAction.disabled = false; }
      }
      pauseCurrentPlayer();
      return;
    }
    entitlementState = "blocked";
    entitlementExpiresAt = null;
    if (content.contentType === "youtube_short") stopShortsReminderTimer();
    entitlementCheckCompletedKey = key;
    delete panel.dataset.entitlementError;
    document.documentElement.classList.add("fr-youtube-blocked");
    pauseCurrentPlayer();
    const action = panel.querySelector("button");
    if (action) { action.hidden = content.contentType === "youtube_short"; action.disabled = false; }
    if (content.contentType === "youtube_short" && currentShortsExpiry && currentShortsExpiry <= serverNow()) currentShortsExpiry = null;
    message.textContent = content.contentType === "youtube_short" ? `Shorts-Zeit erforderlich. ${currentBalance === null ? "Guthaben wird geprüft…" : `Guthaben: ${currentBalance} Coins.`}` : "Für dieses Video liegt keine gültige Freischaltung vor.";
  }

  function makeIdempotencyKey() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  }

  function updateStandardPurchaseAction(panel) {
    if (panel.dataset.contentKey?.startsWith("youtube_video:") !== true || !panel.dataset.quoteId) return;
    const button = panel.querySelector("button:not(.fr-youtube-cancel)");
    const message = panel.querySelector(".fr-youtube-message");
    const price = Number(panel.dataset.quotePrice);
    if (!button || !message || !Number.isSafeInteger(price)) return;
    if (panel.dataset.entitlementError === "network") {
      button.disabled = false;
      button.textContent = "Zugang erneut prüfen";
      message.textContent = "Offline kann der Server die Freischaltung nicht bestätigen. Wiedergabe bleibt gesperrt.";
    } else if (!accountState.signedIn) {
      button.disabled = true;
      message.textContent = "Verbinde dein Focus-Rewards-Konto, um den Kaufpreis zu bestätigen.";
    } else if (currentBalance === null) {
      button.disabled = true;
      message.textContent = "Coin-Guthaben wird geprüft. Kauf bleibt bis zur Serverbestätigung gesperrt.";
    } else if (currentBalance < price) {
      button.disabled = true;
      message.textContent = `Nicht genügend Coins. Preis ${price} · Guthaben ${currentBalance}.`;
    } else {
      button.disabled = false;
      button.textContent = `Für ${price} Coins freischalten · 18 Stunden`;
      message.textContent = `Serverpreis: ${String(Number(panel.dataset.quoteRate)).replace(".", ",")} Coins pro Minute · Guthaben ${currentBalance} Coins.`;
    }
  }

  function refreshShortsChoices(panel) {
    if (!accountState.signedIn) return;
    panel.querySelectorAll(".fr-shorts-options button[data-minutes]").forEach((choice) => {
      const minutes = Number(choice.dataset.minutes);
      const estimate = Math.ceil(minutes * pricingRates.shortsCoinsPerMinute);
      choice.textContent = `${minutes} Min · ca. ${estimate} Coins`;
      choice.disabled = currentBalance === null || currentBalance < estimate
        || (pendingShortsPurchase !== null && pendingShortsPurchase.minutes !== minutes);
    });
  }

  function stopShortsReminderTimer() {
    if (shortsReminderTimer) window.clearInterval(shortsReminderTimer);
    shortsReminderTimer = 0;
  }

  function startShortsReminderTimer() {
    if (shortsReminderTimer || currentContent()?.contentType !== "youtube_short" || entitlementState !== "unlocked") return;
    const tick = () => {
      if (currentContent()?.contentType !== "youtube_short" || entitlementState !== "unlocked" || !entitlementExpiresAt || entitlementExpiresAt <= serverNow()) {
        stopShortsReminderTimer();
        return;
      }
      const now = Date.now();
      const player = document.querySelector("video.html5-main-video");
      if (!player || player.paused || document.hidden) {
        shortsLastTickAt = null;
        return;
      }
      if (shortsLastTickAt !== null) shortsWatchedMs += Math.max(0, now - shortsLastTickAt);
      shortsLastTickAt = now;
      const elapsedMinute = Math.floor(shortsWatchedMs / 60_000);
      if (elapsedMinute >= nextShortsReminderMinute) {
        nextShortsReminderMinute = (Math.floor(elapsedMinute / 10) + 1) * 10;
        let reminder = document.querySelector(".fr-youtube-reminder");
        if (!reminder) {
          reminder = document.createElement("div");
          reminder.className = "fr-youtube-reminder";
          reminder.setAttribute("role", "status");
          document.body.append(reminder);
        }
        reminder.textContent = `Du schaust seit ${elapsedMinute} Minuten Shorts.`;
        if (reminderTimer) window.clearTimeout(reminderTimer);
        reminderTimer = window.setTimeout(() => reminder.remove(), 5_000);
      }
    };
    shortsReminderTimer = window.setInterval(tick, 5_000);
  }

  let reminderTimer = 0;

  function armEntitlementExpiry(content, expiresAt) {
    if (entitlementExpiryTimer) window.clearTimeout(entitlementExpiryTimer);
    if (!Number.isFinite(expiresAt)) return;
    const remainingMs = expiresAt - serverNow();
    if (remainingMs <= 0) {
      entitlementState = "blocked";
      document.documentElement.classList.add("fr-youtube-blocked");
      pauseCurrentPlayer();
      renderPurchaseUi();
      return;
    }
    entitlementExpiryTimer = window.setTimeout(() => {
      if (activeContentKey !== `${content.contentType}:${content.videoId}`) return;
      if (expiresAt <= serverNow()) {
        entitlementState = "checking";
        entitlementExpiresAt = null;
        if (content.contentType === "youtube_short") {
          stopShortsReminderTimer();
          shortsWatchedMs = 0;
          shortsLastTickAt = null;
          nextShortsReminderMinute = 10;
        }
        entitlementCheckCompletedKey = null;
        document.documentElement.classList.add("fr-youtube-blocked");
        pauseCurrentPlayer();
        renderPurchaseUi();
      } else {
        armEntitlementExpiry(content, expiresAt);
      }
    }, Math.min(remainingMs, 2_147_000_000));
  }

  function pauseCurrentPlayer(pause = true) {
    const player = document.querySelector("video.html5-main-video") || document.querySelector("ytd-player #movie_player");
    if (pause) { try { player?.pause?.(); } catch { /* player can be replaced during navigation */ } }
    if (player) player.style.pointerEvents = entitlementState === "unlocked" ? "" : "none";
  }

  function contentTypeForCard(card) {
    const links = card.querySelectorAll("a[href]");
    for (const link of links) {
      try {
        if (new URL(link.href, location.origin).pathname.startsWith("/shorts/")) return "youtube_short";
      } catch { /* Ignore malformed YouTube card links. */ }
    }
    return "youtube_video";
  }

  function updateCard(card) {
    const existing = card.querySelector(`.${BADGE_CLASS}`);
    const menu = findMenu(card);
    const validVideo = card.querySelectorAll("a[href]").length > 0;
    const contentType = validVideo ? contentTypeForCard(card) : null;
    updateShortsVisibility(card, contentType === "youtube_short");
    if (!validVideo || !menu || isLive(card)) {
      if (existing) removeBadge(card);
      return;
    }
    const durationSeconds = durationFor(card);
    const rate = contentType === "youtube_short" ? pricingRates.shortsCoinsPerMinute : pricingRates.standardCoinsPerMinute;
    const price = window.FocusRewardsPricing.priceForDurationSeconds(durationSeconds, rate);
    if (price === null) {
      if (existing) removeBadge(card);
      return;
    }

    const row = menu.parentElement || menu;
    const badge = existing || document.createElement("span");
    badge.className = BADGE_CLASS;
    const label = `◈ ${price} ${price === 1 ? "Coin" : "Coins"}`;
    if (badge.textContent !== label) badge.textContent = label;
    const tooltip = `Geschätzter Wert (${String(rate).replace(".", ",")} Coins pro Minute); den Kaufpreis bestätigt der Server.`;
    if (badge.getAttribute("title") !== tooltip) badge.setAttribute("title", tooltip);
    const accessibleLabel = `Geschätzter Wert: ${price} Coins. Der endgültige Kaufpreis wird vom Server bestätigt.`;
    if (badge.getAttribute("aria-label") !== accessibleLabel) badge.setAttribute("aria-label", accessibleLabel);
    if (badge.dataset.durationSeconds !== String(durationSeconds)) badge.dataset.durationSeconds = String(durationSeconds);
    if (badge.dataset.price !== String(price)) badge.dataset.price = String(price);

    if (badge.parentElement !== row || badge.nextElementSibling !== menu) {
      row.insertBefore(badge, menu);
    }
    for (const duplicate of card.querySelectorAll(`.${BADGE_CLASS}`)) {
      if (duplicate !== badge) duplicate.remove();
    }
  }

  function scan() {
    scanTimer = 0;
    if (enabled) document.querySelectorAll(CARD_SELECTOR).forEach(updateCard);
    renderPurchaseUi();
  }

  function scheduleScan() {
    if (scanTimer) window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(scan, 120);
  }

  function setEnabled(value) {
    enabled = value !== false;
    if (enabled) {
      scheduleScan();
      renderPurchaseUi();
    } else {
      if (scanTimer) window.clearTimeout(scanTimer);
      scanTimer = 0;
      document.querySelectorAll(`.${BADGE_CLASS}`).forEach((badge) => badge.remove());
      renderPurchaseUi();
    }
  }

  function start() {
    const protectPlayback = (event) => {
      if (!currentContent()) return;
      if (entitlementState === "unlocked" && entitlementExpiresAt !== null && entitlementExpiresAt > serverNow()) return;
      if (entitlementState === "unlocked") { entitlementState = "blocked"; entitlementExpiresAt = null; }
      if (event.target instanceof HTMLVideoElement) { try { event.target.pause(); } catch { /* player navigation race */ } }
      document.documentElement.classList.add("fr-youtube-blocked");
      if (entitlementState === "blocked") renderPurchaseUi();
    };
    document.addEventListener("play", protectPlayback, true);
    document.addEventListener("playing", protectPlayback, true);
    if (currentContent()) { entitlementState = "checking"; document.documentElement.classList.add("fr-youtube-blocked"); pauseCurrentPlayer(); }
    observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-label", "href", "overlay-style"],
    });

    const refreshPricingRates = () => {
      void extensionRequest("youtube-pricing-rates").then((result) => {
        if (result?.ok) {
          pricingRates = result;
          scheduleScan();
        }
      });
    };
    const handleNavigation = () => {
      activeContentKey = null;
      entitlementCheckCompletedKey = null;
      if (!location.pathname.startsWith("/shorts/")) {
        stopShortsReminderTimer();
        shortsLastTickAt = null;
      }
      entitlementState = "checking";
      entitlementExpiresAt = null;
      document.documentElement.classList.add("fr-youtube-blocked");
      pauseCurrentPlayer();
      scheduleScan();
      renderPurchaseUi();
      refreshPricingRates();
      void refreshBalance();
    };
    window.addEventListener("popstate", handleNavigation);
    document.addEventListener("yt-navigate-finish", handleNavigation);
    document.addEventListener("yt-page-data-updated", scheduleScan);
    const accountChanged = () => {
      entitlementCheckCompletedKey = null;
      void extensionRequest("status").then((result) => {
        accountState = result;
        if (result?.signedIn) refreshPricingRates();
        void refreshBalance();
        renderPurchaseUi();
      });
    };
    chrome.storage.onChanged.addListener((changes, areaName) => { if (areaName === "local") accountChanged(); });
    void extensionRequest("status").then((result) => { accountState = result; if (result?.signedIn) refreshPricingRates(); void refreshBalance(); renderPurchaseUi(); });

    chrome.storage.sync.get({ [SETTING]: true }, (settings) => setEnabled(settings[SETTING]));
    refreshPricingRates();
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "sync" && changes[SETTING]) setEnabled(changes[SETTING].newValue);
      if (areaName === "local") refreshPricingRates();
    });
  }

  start();
})();
