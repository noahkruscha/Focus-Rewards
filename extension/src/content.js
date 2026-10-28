(function () {
  "use strict";

  const SETTING = "youtubePriceIndicatorEnabled";
  const DEFAULT_STANDARD_RATE = 1.2;
  const DEFAULT_SHORTS_RATE = 1.4;
  const FLEXIBLE_RENEW_LEAD_MS = 2_000;
  const CARD_SELECTOR = "ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer, ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer, ytd-reel-shelf-renderer";
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
  let entitlementExpiryKey = null;
  let entitlementExpiryAt = null;
  let entitlementCheckKey = null;
  let entitlementCheckPromise = null;
  let entitlementCheckCompletedKey = null;
  let shortsPurchasePanelOpen = false;
  let shortsWatchedMs = 0;
  let shortsLastTickAt = null;
  let nextShortsReminderMinute = 10;
  let shortsReminderTimer = 0;
  let shortsRendererIdentitySeen = false;
  let observer;
  let scanTimer = 0;
  let pricingRates = { standardCoinsPerMinute: DEFAULT_STANDARD_RATE, shortsCoinsPerMinute: DEFAULT_SHORTS_RATE, flexibleCoinsPerMinute: 1.6, flexibleUsageEnabled: false };
  let flexibleState = { status: "idle", sessionId: null, sequence: null, leaseExpiresAt: null, chargedCoins: 0, availableCoins: null, message: "" };
  let flexibleTimer = 0;
  let flexibleRequestPending = false;
  const estimateCache = new Map();
  const estimateRequests = new Map();
  let shortsRouteActive = false;

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
    if (short) {
      shortsRouteActive = true;
      const activeVideoId = activeShortVideoId();
      if (activeVideoId) return { videoId: activeVideoId, contentType: "youtube_short" };
      // Once a Shorts surface has been resolved, YouTube briefly removes its
      // active renderer while swapping clips. Do not interpret that gap as a
      // new video (or re-open the gate); initial direct loads still use the URL
      // ID until an active renderer becomes available.
      if (shortsRouteActive && shortsRendererIdentitySeen && (shortsHosts().length > 0 || shortRendererExists())) return null;
      return { videoId: short[1], contentType: "youtube_short" };
    }
    if (!path.startsWith("/shorts/")) shortsRouteActive = false;
    const videoId = path === "/watch" ? new URL(location.href).searchParams.get("v") : null;
    return videoId && /^[A-Za-z0-9_-]{11}$/.test(videoId) ? { videoId, contentType: "youtube_video" } : null;
  }

  function serverNow() {
    return Date.now() + serverClockOffsetMs;
  }

  function entitlementKeyFor(content) {
    return content.contentType === "youtube_short" ? "youtube_short:account" : `${content.contentType}:${content.videoId}`;
  }

  function openShadowRoots(roots) {
    const pending = [...roots];
    const visited = new Set();
    const shadowRoots = new Set();
    while (pending.length) {
      const root = pending.pop();
      if (!root || visited.has(root)) continue;
      visited.add(root);
      if (root.shadowRoot) {
        shadowRoots.add(root.shadowRoot);
        pending.push(root.shadowRoot);
      }
      for (const element of root.querySelectorAll?.("*") ?? []) {
        if (element.shadowRoot) {
          shadowRoots.add(element.shadowRoot);
          pending.push(element.shadowRoot);
        }
      }
    }
    return [...shadowRoots];
  }

  function queryOpenShadowRoots(selector, roots) {
    const matches = new Set();
    const scopes = [...new Set([...roots, ...openShadowRoots(roots)])];
    for (const root of scopes) {
      if (root.matches?.(selector)) matches.add(root);
      for (const element of root.querySelectorAll?.(selector) ?? []) matches.add(element);
    }
    return [...matches];
  }

  function shortsHosts() {
    return [...document.querySelectorAll("ytd-shorts, ytd-reel-video-renderer")];
  }

  function activeShortRenderers() {
    return [...new Set([
      ...document.querySelectorAll("ytd-reel-video-renderer[is-active]"),
      ...queryOpenShadowRoots("ytd-reel-video-renderer[is-active]", shortsHosts()),
    ])];
  }

  function shortRendererExists() {
    return queryOpenShadowRoots("ytd-reel-video-renderer", shortsHosts()).length > 0;
  }

  function activeShortVideoId() {
    for (const renderer of activeShortRenderers()) {
      const videoId = renderer.getAttribute?.("video-id");
      if (videoId && /^[A-Za-z0-9_-]{11}$/.test(videoId)) {
        shortsRendererIdentitySeen = true;
        return videoId;
      }
    }
    return null;
  }

  function hasValidShortsGrant() {
    return entitlementState === "unlocked" && entitlementExpiresAt !== null
      && entitlementExpiresAt > serverNow() && entitlementCheckCompletedKey === "youtube_short:account";
  }

  function hasValidFlexibleLease() {
    return pricingRates.flexibleUsageEnabled === true && flexibleState.status === "active" && Number.isFinite(flexibleState.leaseExpiresAt)
      && flexibleState.leaseExpiresAt > serverNow() && accountState.signedIn;
  }

  function hasCompletedShortsCheck() {
    return entitlementCheckCompletedKey === "youtube_short:account";
  }

  function hasValidEntitlement(content) {
    return Boolean(content && entitlementState === "unlocked" && entitlementExpiresAt !== null
      && entitlementExpiresAt > serverNow() && entitlementCheckCompletedKey === entitlementKeyFor(content));
  }

  function activeYouTubePlayers() {
    const players = new Set(document.querySelectorAll("video.html5-main-video, ytd-shorts video, ytd-reel-video-renderer[is-active] video, #shorts-player video, ytd-shorts #player-container video, ytd-reel-video-renderer[is-active] #player-container video"));
    for (const video of queryOpenShadowRoots("video.html5-main-video, video", shortsHosts())) players.add(video);
    const standardVideo = document.querySelector("ytd-player video.html5-main-video");
    if (standardVideo) players.add(standardVideo);
    return [...players];
  }

  function activeYouTubePlayerApis() {
    const players = new Set(document.querySelectorAll("ytd-player #movie_player, ytd-shorts #movie_player, #shorts-player"));
    const renderers = activeShortRenderers();
    const scopes = renderers.length ? renderers : shortsHosts();
    for (const player of queryOpenShadowRoots("#movie_player, #shorts-player", scopes)) players.add(player);
    return [...players];
  }

  const guardedShortVideos = new WeakSet();
  const observedShortRoots = new WeakSet();
  let shortPlaybackGuard = null;

  function installShortVideoGuard(video) {
    if (!video || typeof video.addEventListener !== "function") return;
    if (!guardedShortVideos.has(video)) {
      guardedShortVideos.add(video);
      video.addEventListener("play", (event) => shortPlaybackGuard?.(event), true);
      video.addEventListener("playing", (event) => shortPlaybackGuard?.(event), true);
    }
    if (video.paused === false) shortPlaybackGuard?.({ target: video });
  }

  function installShortPlaybackGuards() {
    if (!shortPlaybackGuard) return;
    const hosts = shortsHosts();
    const roots = openShadowRoots(hosts);
    const videos = new Set(queryOpenShadowRoots("video.html5-main-video, video", hosts));
    for (const video of activeYouTubePlayers()) videos.add(video);
    for (const video of videos) installShortVideoGuard(video);
    for (const root of roots) {
      if (observedShortRoots.has(root)) continue;
      observedShortRoots.add(root);
      const rootObserver = new MutationObserver(() => {
        for (const video of queryOpenShadowRoots("video.html5-main-video, video", hosts)) installShortVideoGuard(video);
        scheduleScan();
      });
      rootObserver.observe(root, { childList: true, subtree: true });
    }
  }

  function currentVideoTitle() {
    const shortTitle = activeShortRenderers().map((renderer) => renderer.querySelector?.("h2")?.textContent
      || queryOpenShadowRoots("h2", [renderer]).map((heading) => heading.textContent).find(Boolean)).find(Boolean);
    return (document.querySelector("h1.ytd-watch-metadata")?.textContent || shortTitle || "").trim().slice(0, 200);
  }

  function extensionRequest(type, payload = {}) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, ...payload }, (result) => {
        if (chrome.runtime.lastError) resolve({ ok: false, kind: "network", error: "NETWORK_ERROR" });
        else resolve(result ?? { ok: false, kind: "network", error: "NETWORK_ERROR" });
      });
    });
  }

  function ensureFlexibleStatusPanel() {
    if (currentContent()?.contentType !== "youtube_short") return;
    if (pricingRates.flexibleUsageEnabled !== true) {
      document.querySelectorAll(".fr-flexible-usage-status").forEach((node) => node.remove());
      return;
    }
    let panel = document.querySelector(".fr-flexible-usage-status");
    if (!panel) {
      panel = document.createElement("section");
      panel.className = "fr-flexible-usage-status";
      panel.setAttribute("role", "status");
      panel.setAttribute("aria-live", "polite");
      document.body.append(panel);
    }
    const active = flexibleState.status === "active" && Number.isFinite(flexibleState.leaseExpiresAt);
    panel.textContent = `Flexible Nutzung · ${String(flexibleState.rateCoinsPerMinute ?? pricingRates.flexibleCoinsPerMinute).replace(".", ",")} Coins/min · ${active ? `aktiv · ${Math.max(0, Math.ceil((flexibleState.leaseExpiresAt - serverNow()) / 1000))}s autorisiert` : flexibleState.status} · ${flexibleState.chargedCoins ?? 0} Coins verbraucht · Guthaben ${flexibleState.availableCoins ?? currentBalance ?? "…"}`;
    if (flexibleState.message) panel.textContent += ` · ${flexibleState.message}`;
    if (!panel.isConnected) document.body.append(panel);
  }

  async function syncFlexibleState({ allowCreate = false } = {}) {
    if (!accountState.signedIn || currentContent()?.contentType !== "youtube_short" || flexibleRequestPending) return;
    flexibleRequestPending = true;
    const state = await extensionRequest("youtube-flexible-state");
    flexibleRequestPending = false;
    if (!state?.ok) {
      if (state?.kind === "active-elsewhere") {
        flexibleState = { ...flexibleState, status: "active-elsewhere", message: "Flexible Sitzung läuft in einem anderen Tab." };
        document.documentElement.classList.add("fr-youtube-blocked");
        pauseCurrentPlayer();
        renderPurchaseUi();
      } else if (state?.kind === "unauthorized") {
        accountState = { ok: true, signedIn: false };
        flexibleState = { ...flexibleState, status: "blocked", message: "Sitzung abgelaufen. Bitte Konto erneut verbinden." };
        document.documentElement.classList.add("fr-youtube-blocked");
        pauseCurrentPlayer();
        renderPurchaseUi();
      } else if (state?.kind === "network" && hasValidFlexibleLease()) {
        flexibleState.status = "blocked";
        flexibleState.message = "Flexible Sitzung kann nicht bestätigt werden. Verbindung prüfen.";
        clearFlexibleLeaseTimer();
        document.documentElement.classList.add("fr-youtube-blocked");
        pauseCurrentPlayer();
        renderPurchaseUi();
        ensureFlexibleStatusPanel();
      } else if (state?.kind === "disabled") {
        pricingRates.flexibleUsageEnabled = false;
        flexibleState = { ...flexibleState, status: "disabled", message: "Flexible Nutzung ist für diese Convex-Umgebung deaktiviert." };
        document.querySelectorAll(".fr-flexible-usage-status").forEach((node) => node.remove());
      }
      return;
    }
    if (currentContent()?.contentType !== "youtube_short") return;
    pricingRates.flexibleUsageEnabled = state.flexibleUsageEnabled === true;
    if (Number.isFinite(state.serverTime)) serverClockOffsetMs = state.serverTime - Date.now();
    if (state.activeElsewhere) {
      flexibleState = { ...flexibleState, status: "active-elsewhere", message: "Flexible Sitzung läuft in einem anderen Tab." };
      document.documentElement.classList.add("fr-youtube-blocked");
      pauseCurrentPlayer();
      renderPurchaseUi();
      return;
    }
    flexibleState.rateCoinsPerMinute = state.rateCoinsPerMinute;
    const session = state.session;
    if (pricingRates.flexibleUsageEnabled !== true) {
      if (session?.status === "active" && session.leaseExpiresAt > serverNow()) {
        flexibleState = { ...flexibleState, ...session, status: "active", leaseExpiresAt: session.leaseExpiresAt };
        armFlexibleLeaseExpiry(session.leaseExpiresAt);
      }
      return;
    }
    if (session?.status === "active" && session.leaseExpiresAt > serverNow()) {
      flexibleState = { ...flexibleState, ...session, status: "active", rateCoinsPerMinute: state.rateCoinsPerMinute, message: "" };
      entitlementState = "unlocked";
      entitlementExpiresAt = session.leaseExpiresAt;
      entitlementCheckCompletedKey = "youtube_short:account";
      document.documentElement.classList.remove("fr-youtube-blocked");
      pauseCurrentPlayer(false);
      const authorizedContent = currentContent();
      if (authorizedContent?.contentType === "youtube_short") playCurrentPlayer(authorizedContent);
      document.querySelectorAll(".fr-youtube-purchase").forEach((node) => node.remove());
      ensureFlexibleStatusPanel();
      addFlexibleStopControl();
      armFlexibleLeaseExpiry(session.leaseExpiresAt);
      return;
    }
    flexibleState = { ...flexibleState, status: session?.status || "idle", sessionId: session?.sessionId ?? null,
      sequence: session?.sequence ?? null, leaseExpiresAt: null, chargedCoins: session?.chargedCoins ?? 0,
      availableCoins: session?.availableCoins ?? currentBalance, rateCoinsPerMinute: state.rateCoinsPerMinute,
      message: session?.status === "insufficient" ? "Guthaben reicht nicht für ein weiteres Intervall." : "" };
    if (allowCreate && !state.session && !state.activeElsewhere) await startFlexibleSession();
  }

  function addFlexibleSessionControl() {
    const existing = document.querySelector(".fr-flexible-start");
    if (existing?.isConnected) return;
    const control = document.createElement("button");
    control.className = "fr-flexible-start";
    control.type = "button";
    control.textContent = "Flexible Shorts-Nutzung starten";
    control.setAttribute("aria-label", `Flexible Shorts-Nutzung starten, ${pricingRates.flexibleCoinsPerMinute} Coins pro Minute`);
    control.addEventListener("click", async () => {
      control.disabled = true;
      control.textContent = "Serverautorisierung wird geprüft…";
      await startFlexibleSession();
      if (!hasValidFlexibleLease() && control.isConnected) {
        control.disabled = false;
        control.textContent = "Flexible Shorts-Nutzung starten";
      }
    });
    document.body.append(control);
  }

  function addFlexibleStopControl() {
    document.querySelectorAll(".fr-flexible-start").forEach((node) => node.remove());
    let control = document.querySelector(".fr-flexible-stop");
    if (control?.isConnected) return;
    control = document.createElement("button");
    control.className = "fr-flexible-stop";
    control.type = "button";
    control.textContent = "Flexible Sitzung beenden";
    control.addEventListener("click", async () => {
      control.disabled = true;
      control.textContent = "Sitzung wird abgerechnet…";
      await stopFlexibleSession();
      control.remove();
      if (flexibleState.status !== "stopped") addFlexibleStopControl();
    });
    document.body.append(control);
  }

  async function startFlexibleSession() {
    if (flexibleRequestPending || currentContent()?.contentType !== "youtube_short") return;
    flexibleRequestPending = true;
    const requestedContent = currentContent();
    const response = await extensionRequest("youtube-flexible-start");
    flexibleRequestPending = false;
    await applyFlexibleOperationResult(response, requestedContent);
  }

  async function renewFlexibleSession() {
    if (flexibleRequestPending || !hasValidFlexibleLease()) return;
    flexibleRequestPending = true;
    const current = currentContent();
    const response = await extensionRequest("youtube-flexible-renew", { expectedSequence: flexibleState.sequence });
    flexibleRequestPending = false;
    await applyFlexibleOperationResult(response, current);
  }

  async function stopFlexibleSession(message = "") {
    if (flexibleRequestPending || flexibleState.status !== "active") return;
    flexibleRequestPending = true;
    const response = await extensionRequest("youtube-flexible-stop");
    flexibleRequestPending = false;
    if (response?.ok) {
      flexibleState = { ...flexibleState, ...response, status: response.status, message };
      clearFlexibleLeaseTimer();
      if (response.status !== "active") {
        document.documentElement.classList.add("fr-youtube-blocked");
        pauseCurrentPlayer();
      }
    } else if (response?.kind === "network" || response?.kind === "insufficient-coins" || response?.kind === "unauthorized") {
      flexibleState.message = response.message || "Flexible Nutzung wurde nicht bestätigt.";
      document.documentElement.classList.add("fr-youtube-blocked");
      pauseCurrentPlayer();
    }
    ensureFlexibleStatusPanel();
  }

  async function applyFlexibleOperationResult(response, requestedContent) {
    const current = currentContent();
    if (!response?.ok) {
      const sameAuthorizedShort = current?.contentType === "youtube_short" && requestedContent?.contentType === "youtube_short"
        && hasValidFlexibleLease();
      if (sameAuthorizedShort && response?.kind !== "unauthorized" && response?.kind !== "active-elsewhere") {
        flexibleState.message = response?.message || "Erneuerung nicht bestätigt. Aktuelles autorisiertes Intervall bleibt bis zum Ablauf gültig.";
        ensureFlexibleStatusPanel();
        return;
      }
      flexibleState.status = response?.kind === "active-elsewhere" ? "active-elsewhere" : "blocked";
      flexibleState.message = response?.message || "Flexible Abrechnung konnte nicht vom Server bestätigt werden.";
      if (current?.contentType === "youtube_short") {
        document.documentElement.classList.add("fr-youtube-blocked");
        pauseCurrentPlayer();
        renderPurchaseUi();
      }
      ensureFlexibleStatusPanel();
      if (response?.kind === "unauthorized") accountState = { ok: true, signedIn: false };
      return;
    }
    if (Number.isFinite(response.serverTime)) serverClockOffsetMs = response.serverTime - Date.now();
    flexibleState = { ...flexibleState, ...response, status: response.status,
      rateCoinsPerMinute: response.rateCoinsPerMinute ?? flexibleState.rateCoinsPerMinute,
      availableCoins: response.availableCoins ?? currentBalance, message: "" };
    await refreshBalance();
    if (response.status === "active" && Number.isFinite(response.leaseExpiresAt) && response.leaseExpiresAt > serverNow()) {
      if (current?.contentType === "youtube_short" && requestedContent?.contentType === "youtube_short") {
        entitlementState = "unlocked";
        entitlementExpiresAt = response.leaseExpiresAt;
        entitlementCheckCompletedKey = "youtube_short:account";
        document.documentElement.classList.remove("fr-youtube-blocked");
        pauseCurrentPlayer(false);
        playCurrentPlayer(current);
        document.querySelectorAll(".fr-youtube-purchase").forEach((node) => node.remove());
        ensureFlexibleStatusPanel();
        addFlexibleStopControl();
        armFlexibleLeaseExpiry(response.leaseExpiresAt);
      } else {
        document.documentElement.classList.add("fr-youtube-blocked");
        pauseCurrentPlayer();
      }
    } else {
      clearFlexibleLeaseTimer();
      entitlementState = "blocked";
      entitlementExpiresAt = null;
      document.documentElement.classList.add("fr-youtube-blocked");
      pauseCurrentPlayer();
      renderPurchaseUi();
      ensureFlexibleStatusPanel();
    }
  }

  function clearFlexibleLeaseTimer() {
    if (flexibleTimer) window.clearTimeout(flexibleTimer);
    flexibleTimer = 0;
  }

  function armFlexibleLeaseExpiry(expiresAt) {
    clearFlexibleLeaseTimer();
    const renewAt = expiresAt - FLEXIBLE_RENEW_LEAD_MS;
    flexibleTimer = window.setTimeout(() => {
      flexibleTimer = 0;
      if (currentContent()?.contentType !== "youtube_short") return;
      if (!hasValidFlexibleLease()) {
        flexibleState.status = "expired";
        flexibleState.message = "Intervall abgelaufen. Bitte auf die Serverautorisierung warten.";
        document.documentElement.classList.add("fr-youtube-blocked");
        pauseCurrentPlayer();
        renderPurchaseUi();
        ensureFlexibleStatusPanel();
        return;
      }
      if (currentContent()?.contentType !== "youtube_short") return;
      void renewFlexibleSession();
      if (flexibleTimer) window.clearTimeout(flexibleTimer);
      flexibleTimer = window.setTimeout(() => {
        if (flexibleState.status === "active" && Number.isFinite(flexibleState.leaseExpiresAt) && flexibleState.leaseExpiresAt <= serverNow()) {
          flexibleState.status = "expired";
          flexibleState.message = "Der Server hat kein weiteres Shorts-Intervall autorisiert.";
          document.documentElement.classList.add("fr-youtube-blocked");
          pauseCurrentPlayer();
          renderPurchaseUi();
          ensureFlexibleStatusPanel();
        }
      }, Math.max(0, expiresAt - serverNow()));
    }, Math.max(0, renewAt - serverNow()));
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
    if (currentContent()?.contentType === "youtube_short" && flexibleState.status === "active" && flexibleState.leaseExpiresAt > serverNow()) {
      currentBalance = result.coins;
      flexibleState.availableCoins = result.coins;
    } else if (currentContent()?.contentType === "youtube_short" && currentShortsExpiry && currentShortsExpiry > serverNow()) {
      const content = currentContent();
      if (entitlementState !== "unlocked" || entitlementExpiresAt !== currentShortsExpiry) {
        entitlementState = "unlocked";
        entitlementExpiresAt = currentShortsExpiry;
        entitlementCheckCompletedKey = entitlementKeyFor(content);
        document.documentElement.classList.remove("fr-youtube-blocked");
        pauseCurrentPlayer(false);
        armEntitlementExpiry(content, currentShortsExpiry);
        startShortsReminderTimer();
      }
    } else if (currentContent()?.contentType === "youtube_short" && hasValidShortsGrant()
      && entitlementExpiresAt <= serverNow()) {
      entitlementState = "checking";
      entitlementExpiresAt = null;
      entitlementCheckCompletedKey = null;
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
    if (!content && location.pathname.startsWith("/shorts/")) {
      shortsPurchasePanelOpen = false;
      // Keep the authorization decision intact while YouTube swaps reel
      // renderers, but hide its stale video-specific panel until the next
      // active video ID can be verified.
      document.querySelectorAll(".fr-youtube-purchase").forEach((node) => { node.hidden = true; });
      if (hasValidShortsGrant() || (pricingRates.flexibleUsageEnabled === true && hasValidFlexibleLease())) {
        document.documentElement.classList.remove("fr-youtube-blocked");
        pauseCurrentPlayer(false);
      } else {
        if (!hasCompletedShortsCheck()) entitlementState = "checking";
        document.documentElement.classList.add("fr-youtube-blocked");
        pauseCurrentPlayer();
      }
      return;
    }
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
    const nextContentKey = `${content.contentType}:${content.videoId}`;
    document.querySelectorAll(".fr-youtube-purchase").forEach((node) => { node.hidden = false; });
    if (activeContentKey !== nextContentKey) {
      const keepShortsAccess = content.contentType === "youtube_short" && (hasValidShortsGrant() || (pricingRates.flexibleUsageEnabled === true && hasValidFlexibleLease()));
      const keepShortsDenial = content.contentType === "youtube_short"
        && entitlementState === "blocked" && hasCompletedShortsCheck();
      if (content.contentType !== "youtube_short") stopShortsReminderTimer();
      if (!keepShortsAccess) shortsLastTickAt = null;
      shortsPurchasePanelOpen = false;
      if (!keepShortsAccess && !keepShortsDenial) {
        entitlementCheckCompletedKey = null;
        entitlementState = "checking";
        entitlementExpiresAt = null;
        document.documentElement.classList.add("fr-youtube-blocked");
        pauseCurrentPlayer();
      } else if (keepShortsAccess) {
        document.documentElement.classList.remove("fr-youtube-blocked");
        pauseCurrentPlayer(false);
        if (hasValidShortsGrant()) startShortsReminderTimer();
      } else if (keepShortsDenial) {
        // The account-wide Shorts check already denied access. Once the new
        // active renderer has an identity, enforce that denial on its player.
        document.documentElement.classList.add("fr-youtube-blocked");
        pauseCurrentPlayer();
      }
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
    if (content.contentType === "youtube_short" && pricingRates.flexibleUsageEnabled === true && hasValidFlexibleLease()) {
      document.documentElement.classList.remove("fr-youtube-blocked");
      pauseCurrentPlayer(false);
      ensureFlexibleStatusPanel();
      return;
    }
    if (content.contentType === "youtube_short" && pricingRates.flexibleUsageEnabled === true && accountState.signedIn
      && (flexibleState.status === "idle" || flexibleState.status === "insufficient" || flexibleState.status === "stopped")) {
      addFlexibleSessionControl();
    }
    if (entitlementState === "unlocked" && !extendingShorts) {
      shortsPurchasePanelOpen = false;
      document.querySelectorAll(".fr-youtube-purchase").forEach((node) => node.remove());
      document.documentElement.classList.remove("fr-youtube-blocked");
      if (content.contentType === "youtube_short") {
        armEntitlementExpiry(content, entitlementExpiresAt);
        startShortsReminderTimer();
      }
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
      const purchasedContentKey = `${content.contentType}:${content.videoId}`;
      const result = await extensionRequest("youtube-purchase", {
        videoId: content.videoId,
        videoTitle: videoHeading.textContent?.trim().slice(0, 200) || undefined,
        contentType: content.contentType,
        durationSeconds,
        idempotencyKey: pendingPurchase.idempotencyKey,
        quoteId: panel.dataset.quoteId,
      });
      if (result.ok) {
        pendingPurchase = null;
        if (activeContentKey === purchasedContentKey && currentContent()?.videoId === content.videoId
          && Number.isFinite(result.expiresAt) && result.expiresAt > serverNow()) {
          entitlementState = "unlocked";
          entitlementExpiresAt = result.expiresAt;
          entitlementCheckCompletedKey = purchasedContentKey;
          document.documentElement.classList.remove("fr-youtube-blocked");
          panel.remove();
          armEntitlementExpiry(content, result.expiresAt);
          playCurrentPlayer(content);
        }
        await refreshBalance();
        if (panel.isConnected && panel.dataset.contentKey === purchasedContentKey) {
          message.textContent = result.alreadyOwned ? "Eine gültige Freischaltung wurde vom Server bestätigt." : `Kauf vom Server bestätigt. Gültig bis ${new Date(result.expiresAt).toLocaleDateString("de-DE")}.`;
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
          if (!panel.isConnected) {
            choice.disabled = false;
            if (purchase.ok) {
              pendingShortsPurchase = null;
              currentShortsExpiry = purchase.expiresAt;
              await refreshBalance();
              const current = currentContent();
              if (accountState.signedIn && current?.contentType === "youtube_short" && purchase.expiresAt > serverNow()) {
                entitlementState = "unlocked";
                entitlementExpiresAt = purchase.expiresAt;
                entitlementCheckCompletedKey = entitlementKeyFor(current);
                document.documentElement.classList.remove("fr-youtube-blocked");
                armEntitlementExpiry(current, purchase.expiresAt);
                startShortsReminderTimer();
                playCurrentPlayer(current);
              }
            }
            return;
          }
          if (purchase.ok) {
            pendingShortsPurchase = null;
            currentShortsExpiry = purchase.expiresAt;
            if (accountState.signedIn && activeContentKey === `${content.contentType}:${content.videoId}` && currentContent()?.contentType === "youtube_short" && purchase.expiresAt > serverNow()) {
              entitlementState = "unlocked";
              entitlementExpiresAt = purchase.expiresAt;
              entitlementCheckCompletedKey = entitlementKeyFor(content);
              document.documentElement.classList.remove("fr-youtube-blocked");
              panel.remove();
              armEntitlementExpiry(content, purchase.expiresAt);
              startShortsReminderTimer();
              playCurrentPlayer(content);
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
    const key = entitlementKeyFor(content);
    if (content.contentType === "youtube_short" && currentShortsExpiry !== null && currentShortsExpiry > serverNow()) {
      entitlementState = "unlocked";
      entitlementExpiresAt = currentShortsExpiry;
      entitlementCheckCompletedKey = key;
      document.documentElement.classList.remove("fr-youtube-blocked");
      if (panel?.isConnected) panel.remove();
      armEntitlementExpiry(content, currentShortsExpiry);
      startShortsReminderTimer();
      return Promise.resolve();
    }
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
  }  async function performContentEntitlementCheck(content, panel, key) {
    const result = await extensionRequest("youtube-entitlement", content);
    const latestContent = currentContent();
    // Shorts entitlement is account-wide, not tied to the particular clip. An
    // in-flight result remains valid during a brief renderer-less transition,
    // while an actual route change away from Shorts invalidates it.
    const sameEntitlementScope = content.contentType === "youtube_short"
      ? (latestContent?.contentType === "youtube_short" || (!latestContent && location.pathname.startsWith("/shorts/")))
      : latestContent?.contentType === content.contentType && latestContent.videoId === content.videoId;
    if (!sameEntitlementScope) return;
    const resolvedContent = latestContent ?? content;
    if (content.contentType === "youtube_short" && pricingRates.flexibleUsageEnabled === true && hasValidFlexibleLease()) {
      if (panel?.isConnected) panel.remove();
      document.documentElement.classList.remove("fr-youtube-blocked");
      pauseCurrentPlayer(false);
      if (resolvedContent.contentType === "youtube_short") playCurrentPlayer(resolvedContent);
      return;
    }
    if (result.ok && result.unlocked && Number.isFinite(result.expiresAt) && result.expiresAt > (Number.isFinite(result.serverTime) ? result.serverTime : serverNow())) {
      if (Number.isFinite(result.serverTime)) serverClockOffsetMs = result.serverTime - Date.now();
      entitlementState = "unlocked";
      entitlementExpiresAt = result.expiresAt;
      if (content.contentType === "youtube_short") currentShortsExpiry = result.expiresAt;
      entitlementCheckCompletedKey = key;
      if (content.contentType === "youtube_short") startShortsReminderTimer();
      document.documentElement.classList.remove("fr-youtube-blocked");
      pauseCurrentPlayer(false);
      if (panel?.isConnected) panel.remove();
      armEntitlementExpiry(resolvedContent, result.expiresAt);
      if (latestContent) playCurrentPlayer(latestContent);
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
    const contentKey = `${content.contentType}:${content.videoId}`;
    if (entitlementExpiryTimer && entitlementExpiryKey === contentKey && entitlementExpiryAt === expiresAt) return;
    if (entitlementExpiryTimer) window.clearTimeout(entitlementExpiryTimer);
    entitlementExpiryTimer = 0;
    entitlementExpiryKey = contentKey;
    entitlementExpiryAt = expiresAt;
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
      entitlementExpiryTimer = 0;
      entitlementExpiryKey = null;
      entitlementExpiryAt = null;
      if (activeContentKey !== contentKey) return;
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
    for (const player of activeYouTubePlayers()) {
      if (pause && !player.paused) {
        try { player.pause?.(); } catch { /* YouTube may replace the active Shorts player during navigation. */ }
      }
      if (player.style) player.style.pointerEvents = entitlementState === "unlocked" ? "" : "none";
    }
    if (pause) {
      for (const youtubePlayer of activeYouTubePlayerApis()) {
        if (youtubePlayer?.getPlayerState && youtubePlayer.getPlayerState() !== 2) {
          try { youtubePlayer.pauseVideo?.(); } catch { /* Player can be detached while its state changes. */ }
        }
      }
    }
  }

  function playCurrentPlayer(content) {
    const current = currentContent();
    if (!current || current.contentType !== content.contentType || current.videoId !== content.videoId
      || entitlementState !== "unlocked" || entitlementExpiresAt === null || entitlementExpiresAt <= serverNow()) return;
    for (const player of activeYouTubePlayers()) {
      if (player.paused && typeof player.play === "function") {
        const result = player.play();
        result?.catch?.(() => { /* YouTube may require a user gesture; access is nevertheless unlocked. */ });
      }
      if (player.style) player.style.pointerEvents = "";
    }
    for (const youtubePlayer of activeYouTubePlayerApis()) {
      try { youtubePlayer?.playVideo?.(); } catch { /* Player may be replaced during SPA navigation. */ }
    }
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

  function shouldUseServerEstimateCards() {
    return location.pathname === "/playlist" || (location.pathname === "/watch" && Boolean(document.querySelector("#secondary")));
  }

  function shouldUseServerEstimate(card) {
    return shouldUseServerEstimateCards() && (location.pathname === "/playlist" || Boolean(card.closest?.("#secondary")));
  }

  function renderEstimateBadge(card, menu, estimate, title) {
    const row = menu.parentElement || menu;
    const badge = card.querySelector(`.${BADGE_CLASS}`) || document.createElement("span");
    badge.className = BADGE_CLASS;
    badge.textContent = estimate.unlocked ? "✓ Freigeschaltet" : estimate.estimatedPrice === null ? "Preis nicht verfügbar" : `◈ ca. ${estimate.estimatedPrice} Coins`;
    badge.setAttribute("title", title);
    badge.setAttribute("aria-label", title);
    if (badge.parentElement !== row || badge.nextElementSibling !== menu) row.insertBefore(badge, menu);
    for (const duplicate of card.querySelectorAll(`.${BADGE_CLASS}`)) if (duplicate !== badge) duplicate.remove();
  }

  function cardVideo(card) {
    const link = [...card.querySelectorAll("a[href]")].find((item) => {
      try { return new URL(item.href, location.origin).pathname === "/watch"; } catch { return false; }
    });
    if (!link) return null;
    const url = new URL(link.href, location.origin);
    const videoId = url.searchParams.get("v");
    return videoId && /^[A-Za-z0-9_-]{11}$/.test(videoId)
      ? { videoId, durationSeconds: durationFor(card) }
      : null;
  }

  function fetchServerEstimates(videos) {
    if (!accountState.signedIn || !videos.length) return Promise.resolve(new Map());
    const unique = [...new Map(videos.filter((video) => !estimateRequests.has(video.videoId))
      .map((video) => [video.videoId, video])).values()].slice(0, 100);
    if (!unique.length) return Promise.all(videos.map((video) => estimateRequests.get(video.videoId)).filter(Boolean))
      .then((results) => new Map(results.flatMap((items) => [...items])));
    const request = extensionRequest("youtube-estimates", { videos: unique }).then((result) => {
      if (!result?.ok || !Array.isArray(result.videos)) return new Map();
      if (Number.isFinite(result.serverTime)) serverClockOffsetMs = result.serverTime - Date.now();
      const estimates = new Map(result.videos.map((item) => [item.videoId, { ...item, cachedAt: Date.now() }]));
      for (const [videoId, estimate] of estimates) estimateCache.set(videoId, estimate);
      return estimates;
    }).finally(() => { for (const video of unique) estimateRequests.delete(video.videoId); });
    for (const video of unique) estimateRequests.set(video.videoId, request);
    return request;
  }

  function renderServerEstimateCards(cards) {
    if (!shouldUseServerEstimateCards()) return;
    if (!accountState.signedIn) {
      cards.forEach((card) => {
        if (contentTypeForCard(card) === "youtube_video") removeBadge(card);
      });
      return;
    }
    const entries = cards.map((card) => ({ card, menu: findMenu(card), video: cardVideo(card) }))
      .filter((entry) => entry.menu && entry.video && contentTypeForCard(entry.card) === "youtube_video"
        && shouldUseServerEstimate(entry.card));
    const now = Date.now();
    const pending = entries.filter(({ video }) => {
      const cached = estimateCache.get(video.videoId);
      return video.durationSeconds !== null && (!cached || now - cached.cachedAt >= 30_000)
        && !estimateRequests.has(video.videoId);
    }).slice(0, 100);
    const apply = () => {
      for (const { card, menu, video } of entries) {
        const estimate = estimateCache.get(video.videoId);
        if (estimate && menu) renderEstimateBadge(card, menu, estimate, estimate.unlocked
          ? "Dieses Video hat bereits eine aktive Freischaltung."
          : estimate.estimatedPrice === null ? "Für dieses Video ist keine Preisschätzung verfügbar." : "Geschätzter Preis; der Server bestätigt den tatsächlichen Kaufpreis.");
      }
      renderPlaylistTotal(entries);
    };
    apply();
    if (pending.length) void fetchServerEstimates(pending.map(({ video }) => video)).then((estimates) => {
      for (const { card, menu, video } of entries) {
        const estimate = estimates.get(video.videoId) ?? estimateCache.get(video.videoId);
        if (estimate && menu) renderEstimateBadge(card, menu, estimate, estimate.unlocked
          ? "Dieses Video hat bereits eine aktive Freischaltung."
          : estimate.estimatedPrice === null ? "Für dieses Video ist keine Preisschätzung verfügbar." : "Geschätzter Preis; der Server bestätigt den tatsächlichen Kaufpreis.");
      }
      renderPlaylistTotal(entries);
      // Continue in bounded batches only when the current page had a full
      // batch to send; failures and unknown-duration entries must not create a
      // tight request/rescan loop.
      if (pending.length === 100) scheduleScan();
    });
  }

  function renderPlaylistTotal(entries) {
    if (location.pathname !== "/playlist") return;
    const unique = [...new Map(entries.filter(({ video }) => video).map(({ video }) => [video.videoId, video])).values()];
    const estimates = unique.map(({ videoId }) => estimateCache.get(videoId));
    let totalNode = document.querySelector(".fr-youtube-playlist-total");
    if (!estimates.length) {
      totalNode?.remove();
      return;
    }
    if (!totalNode) {
      totalNode = document.createElement("div");
      totalNode.className = "fr-youtube-playlist-total";
    }
    const priced = estimates.filter((item) => item && !item.unlocked && Number.isSafeInteger(item.estimatedPrice));
    const unknown = unique.filter(({ videoId }) => {
      const estimate = estimateCache.get(videoId);
      return !estimate || (!estimate.unlocked && estimate.estimatedPrice === null);
    }).length;
    const total = priced.reduce((sum, item) => sum + item.estimatedPrice, 0);
    totalNode.textContent = `Playlist estimate only: ${total} Coins${unknown ? ` · incomplete (${unknown} unpriced)` : ""} · unlocked videos excluded · no batch purchase`;
    const anchor = document.querySelector("ytd-playlist-header-renderer #play-button, ytd-playlist-header-renderer #primary ytd-playlist-play-button-renderer, ytd-playlist-header-renderer #primary button");
    const header = document.querySelector("ytd-playlist-header-renderer #primary") || anchor?.parentElement;
    if (header && totalNode.parentElement !== header) header.append(totalNode);
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
    if (contentType === "youtube_video" && shouldUseServerEstimate(card)) {
      if (existing) removeBadge(card);
      return;
    }
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
    installShortPlaybackGuards();
    const cards = [...document.querySelectorAll(CARD_SELECTOR)];
    if (enabled) cards.forEach(updateCard);
    renderServerEstimateCards(cards);
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
      const content = currentContent();
      if (!content) {
        if (!location.pathname.startsWith("/shorts/")) return;
        if (hasValidShortsGrant()) return;
        document.documentElement.classList.add("fr-youtube-blocked");
        const transitioningPlayer = event.target;
        if (transitioningPlayer && typeof transitioningPlayer.pause === "function" && transitioningPlayer.paused === false) {
          try { transitioningPlayer.pause(); } catch { /* YouTube may replace the active Shorts player during navigation. */ }
        }
        pauseCurrentPlayer();
        return;
      }
      if (hasValidEntitlement(content)) {
        if (content.contentType === "youtube_short" && event.target && typeof event.target.play === "function" && event.target.paused) {
          const resumed = event.target.play();
          resumed?.catch?.(() => { /* Resume may require a browser gesture; the server-approved access remains valid. */ });
        }
        return;
      }
      if (entitlementState === "unlocked") {
        entitlementState = "checking";
        entitlementExpiresAt = null;
        entitlementCheckCompletedKey = null;
      }
      const player = event.target;
      if (player && typeof player.pause === "function" && player.paused === false) {
        try { player.pause(); } catch { /* YouTube may replace this player while navigating. */ }
      }
      document.documentElement.classList.add("fr-youtube-blocked");
      pauseCurrentPlayer();
      if (entitlementState === "blocked") renderPurchaseUi();
    };
    shortPlaybackGuard = protectPlayback;
    document.addEventListener("play", protectPlayback, true);
    document.addEventListener("playing", protectPlayback, true);
    installShortPlaybackGuards();
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
          estimateCache.clear();
          scheduleScan();
          if (result.flexibleUsageEnabled !== true) {
            const flexibleLeaseActive = flexibleState.status === "active" && flexibleState.leaseExpiresAt > serverNow();
            document.querySelectorAll(".fr-flexible-usage-status").forEach((node) => node.remove());
            if (flexibleLeaseActive) armFlexibleLeaseExpiry(flexibleState.leaseExpiresAt);
            else if (flexibleState.status === "active") {
              flexibleState = { ...flexibleState, status: "blocked", message: "Flexible Usage ist serverseitig deaktiviert." };
              document.documentElement.classList.add("fr-youtube-blocked");
              pauseCurrentPlayer();
            }
          } else if (currentContent()?.contentType === "youtube_short") {
            void syncFlexibleState();
          }
        }
      });
    };
    const handleNavigation = () => {
      const next = currentContent();
      const onShortsRoute = location.pathname.startsWith("/shorts/");
      const retainShortsDecision = onShortsRoute && hasCompletedShortsCheck();
      const retainAccountShortsGrant = onShortsRoute && (hasValidShortsGrant() || (pricingRates.flexibleUsageEnabled === true && hasValidFlexibleLease()));
      activeContentKey = null;
      if (!onShortsRoute) shortsRendererIdentitySeen = false;
      if (next?.contentType !== "youtube_short" && !retainShortsDecision) {
        entitlementCheckCompletedKey = null;
        stopShortsReminderTimer();
        shortsLastTickAt = null;
      }
      if (!retainAccountShortsGrant) {
        entitlementState = "checking";
        entitlementExpiresAt = null;
        document.documentElement.classList.add("fr-youtube-blocked");
        pauseCurrentPlayer();
      } else {
        document.documentElement.classList.remove("fr-youtube-blocked");
      }
      scheduleScan();
      renderPurchaseUi();
      refreshPricingRates();
      void refreshBalance();
      if (next?.contentType === "youtube_short" && accountState.signedIn && !hasValidShortsGrant()) void syncFlexibleState();
    };
    window.addEventListener("popstate", handleNavigation);
    document.addEventListener("yt-navigate-finish", handleNavigation);
    document.addEventListener("yt-page-data-updated", scheduleScan);
    const accountChanged = () => {
      entitlementCheckCompletedKey = null;
      void extensionRequest("status").then((result) => {
        accountState = result;
        if (result?.signedIn) {
          refreshPricingRates();
          if (currentContent()?.contentType === "youtube_short" && !hasValidShortsGrant()) void syncFlexibleState();
        }
        void refreshBalance();
        renderPurchaseUi();
      });
    };
    chrome.storage.onChanged.addListener((changes, areaName) => { if (areaName === "local") accountChanged(); });
    void extensionRequest("status").then((result) => {
      accountState = result;
      if (result?.signedIn) {
        refreshPricingRates();
        if (currentContent()?.contentType === "youtube_short") void syncFlexibleState();
      }
      void refreshBalance();
      renderPurchaseUi();
    });

    chrome.storage.sync.get({ [SETTING]: true }, (settings) => setEnabled(settings[SETTING]));
    refreshPricingRates();
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "sync" && changes[SETTING]) setEnabled(changes[SETTING].newValue);
      if (areaName === "local") refreshPricingRates();
    });
  }

  start();
})();
