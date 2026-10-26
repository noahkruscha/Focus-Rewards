(function () {
  "use strict";

  const SETTING = "youtubePriceIndicatorEnabled";
  const ESTIMATE_RATE_KEY = "focusRewardsYoutubeCoinsPerMinute";
  const CARD_SELECTOR = "ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer";
  const DURATION_SELECTOR = "ytd-thumbnail-overlay-time-status-renderer, yt-thumbnail-badge-view-model";
  const BADGE_CLASS = "fr-youtube-price";
  const LIVE_OR_DURATION_SELECTOR = "ytd-thumbnail-overlay-time-status-renderer, ytd-badge-supported-renderer";
  let enabled = true;
  let accountState = { ok: false, signedIn: false };
  let pendingPurchase = null;
  let purchaseSubmitting = false;
  let activeContentKey = null;
  let observer;
  let scanTimer = 0;

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

  function currentContent() {
    const path = location.pathname;
    const short = path.match(/^\/shorts\/([A-Za-z0-9_-]{11})\/?$/);
    if (short) return { videoId: short[1], contentType: "youtube_short" };
    const videoId = path === "/watch" ? new URL(location.href).searchParams.get("v") : null;
    return videoId && /^[A-Za-z0-9_-]{11}$/.test(videoId) ? { videoId, contentType: "youtube_video" } : null;
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
    return document.querySelector("ytd-watch-flexy") || document.querySelector("ytd-player");
  }

  function removePurchaseUi() {
    document.querySelectorAll(".fr-youtube-purchase").forEach((node) => node.remove());
  }

  function renderPurchaseUi() {
    const content = currentContent();
    if (!enabled || !content) {
      activeContentKey = null;
      removePurchaseUi();
      return;
    }
    const host = pageContext();
    if (!host) return;
    const durationText = document.querySelector(".ytp-time-duration")?.textContent || document.querySelector("ytd-player #movie_player")?.getAttribute("aria-label") || "";
    const contentKey = `${content.contentType}:${content.videoId}`;
    activeContentKey = contentKey;
    if (pendingPurchase && pendingPurchase.contentKey !== contentKey) pendingPurchase = null;
    const durationSeconds = window.FocusRewardsPricing.parseDurationSeconds(durationText);
    if (!durationSeconds) {
      const stalePanel = document.querySelector(".fr-youtube-purchase");
      if (stalePanel?.dataset.contentKey !== contentKey) stalePanel?.remove();
      return;
    }
    const accountKey = accountState.signedIn ? "linked" : "unlinked";
    let panel = document.querySelector(".fr-youtube-purchase");
    if (panel?.dataset.contentKey === contentKey && panel.dataset.accountState === accountKey
      && panel.dataset.durationSeconds === String(durationSeconds)) return;
    if (!panel) {
      panel = document.createElement("section");
      panel.className = "fr-youtube-purchase";
      panel.setAttribute("role", "region");
      panel.setAttribute("aria-label", "Focus Rewards");
      host.prepend(panel);
    }
    panel.dataset.contentKey = contentKey;
    panel.dataset.accountState = accountKey;
    panel.dataset.durationSeconds = String(durationSeconds);
    panel.replaceChildren();
    const heading = document.createElement("strong");
    heading.textContent = "Focus Rewards";
    const message = document.createElement("span");
    message.className = "fr-youtube-message";
    const action = document.createElement("button");
    action.type = "button";
    action.textContent = accountState.signedIn ? "Preis wird geladen…" : "Focus Rewards-Konto verbinden";
    action.disabled = accountState.signedIn;
    action.addEventListener("click", async () => {
      if (purchaseSubmitting) return;
      if (!accountState.signedIn) {
        const optionsUrl = chrome.runtime.getURL("options/options.html");
        window.open(optionsUrl, "_blank", "noopener");
        message.textContent = "Bitte verknüpfe zuerst dein Focus Rewards-Konto in den Erweiterungseinstellungen.";
        return;
      }
      purchaseSubmitting = true;
      action.disabled = true;
      message.textContent = "Freischaltung wird sicher beim Server geprüft…";
      const result = await extensionRequest("youtube-purchase", {
        videoId: content.videoId,
        contentType: content.contentType,
        durationSeconds,
        idempotencyKey: pendingPurchase?.idempotencyKey || (pendingPurchase = { contentKey, idempotencyKey: makeIdempotencyKey() }).idempotencyKey,
      });
      if (result.ok) {
        pendingPurchase = null;
        if (panel.isConnected && panel.dataset.contentKey === `${content.contentType}:${content.videoId}`) {
          message.textContent = result.alreadyOwned ? "Du besitzt bereits eine gültige Freischaltung." : `Erfolgreich freigeschaltet. Gültig bis ${new Date(result.expiresAt).toLocaleDateString("de-DE")}.`;
          await verifyContentEntitlement(content, panel);
        }
      } else if (result.kind === "insufficient-coins") {
        pendingPurchase = null;
        if (panel.isConnected && panel.dataset.contentKey === `${content.contentType}:${content.videoId}`) message.textContent = "Du hast nicht genug Coins für diese Freischaltung.";
      } else if (result.kind === "unauthorized") {
        accountState = { ok: true, signedIn: false };
        pendingPurchase = null;
        if (panel.isConnected && panel.dataset.contentKey === `${content.contentType}:${content.videoId}`) message.textContent = "Deine Anmeldung ist abgelaufen oder widerrufen. Bitte verknüpfe dein Konto erneut.";
      } else if (result.kind === "network") {
        if (panel.isConnected && panel.dataset.contentKey === `${content.contentType}:${content.videoId}`) message.textContent = "Netzwerkfehler. Der Kauf wurde nicht bestätigt; bitte erneut versuchen.";
      } else {
        pendingPurchase = null;
        if (panel.isConnected && panel.dataset.contentKey === `${content.contentType}:${content.videoId}`) message.textContent = "Der Kauf konnte nicht bestätigt werden. Bitte prüfe dein Konto und versuche es erneut.";
      }
      purchaseSubmitting = false;
      if (panel.isConnected && panel.dataset.contentKey === `${content.contentType}:${content.videoId}`) action.disabled = false;
    });
    if (panel.parentElement !== host) host.prepend(panel);
    panel.append(heading, action, message);
    if (accountState.signedIn) {
      void loadPurchaseQuote(content, durationSeconds, panel, action, message);
      void verifyContentEntitlement(content, panel);
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
    action.textContent = `Mit ${quote.price} Coins freischalten (${quote.entitlementDays} Tage)`;
    action.disabled = false;
  }

  async function verifyContentEntitlement(content, panel) {
    const key = `${content.contentType}:${content.videoId}`;
    activeContentKey = key;
    const result = await extensionRequest("youtube-entitlement", content);
    if (activeContentKey !== key || !panel.isConnected) return;
    const message = panel.querySelector(".fr-youtube-message");
    if (!result.ok) {
      if (result.kind === "unauthorized") accountState = { ok: true, signedIn: false };
      message.textContent = result.kind === "network" ? "Freischaltung offline nicht verifizierbar." : "Bitte melde dich in den Erweiterungseinstellungen an.";
      return;
    }
    if (result.unlocked) {
      message.textContent = `Serverbestätigt freigeschaltet bis ${new Date(result.expiresAt).toLocaleDateString("de-DE")}.`;
      const action = panel.querySelector("button");
      if (action) action.hidden = true;
    } else {
      const action = panel.querySelector("button");
      if (action) action.hidden = false;
    }
  }

  function makeIdempotencyKey() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  }

  function updateCard(card) {
    const existing = card.querySelector(`.${BADGE_CLASS}`);
    const menu = findMenu(card);
    const validVideo = card.querySelectorAll("a[href]").length > 0;
    if (!validVideo || !menu || isLive(card)) {
      if (existing) removeBadge(card);
      return;
    }
    const durationSeconds = durationFor(card);
    const price = window.FocusRewardsPricing.priceForDurationSeconds(durationSeconds);
    if (price === null) {
      if (existing) removeBadge(card);
      return;
    }

    const row = menu.parentElement || menu;
    const badge = existing || document.createElement("span");
    badge.className = BADGE_CLASS;
    const label = `◈ ${price} ${price === 1 ? "coin" : "coins"}`;
    if (badge.textContent !== label) badge.textContent = label;
    const coinsPerMinute = window.FocusRewardsPricing.COINS_PER_MINUTE;
    const tooltip = `Estimated value (${coinsPerMinute} coins per minute); the server quotes the purchase price.`;
    if (badge.getAttribute("title") !== tooltip) badge.setAttribute("title", tooltip);
    const accessibleLabel = `Estimated value: ${price} coins; the server quotes the final price.`;
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
      activeContentKey = null;
      if (scanTimer) window.clearTimeout(scanTimer);
      scanTimer = 0;
      document.querySelectorAll(`.${BADGE_CLASS}`).forEach((badge) => badge.remove());
      removePurchaseUi();
    }
  }

  function start() {
    observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-label", "href", "overlay-style"],
    });

    window.addEventListener("popstate", scheduleScan);
    document.addEventListener("yt-navigate-finish", scheduleScan);
    document.addEventListener("yt-page-data-updated", scheduleScan);
    document.addEventListener("yt-navigate-finish", renderPurchaseUi);
    window.addEventListener("popstate", renderPurchaseUi);
    const accountChanged = () => { void extensionRequest("status").then((result) => { accountState = result; renderPurchaseUi(); }); };
    chrome.storage.onChanged.addListener((changes, areaName) => { if (areaName === "local") accountChanged(); });
    void extensionRequest("status").then((result) => { accountState = result; renderPurchaseUi(); });

    chrome.storage.sync.get({ [SETTING]: true, [ESTIMATE_RATE_KEY]: 1.2 }, (settings) => {
      window.FocusRewardsPricing.setCoinsPerMinute(Number(settings[ESTIMATE_RATE_KEY]) || 1.2);
      setEnabled(settings[SETTING]);
    });
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "sync" && changes[SETTING]) setEnabled(changes[SETTING].newValue);
      if (areaName === "sync" && changes[ESTIMATE_RATE_KEY]) {
        window.FocusRewardsPricing.setCoinsPerMinute(Number(changes[ESTIMATE_RATE_KEY].newValue));
        scheduleScan();
      }
    });
  }

  start();
})();
