(function () {
  "use strict";

  const SETTING = "youtubePriceIndicatorEnabled";
  const CARD_SELECTOR = "ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer";
  const DURATION_SELECTOR = "ytd-thumbnail-overlay-time-status-renderer, yt-thumbnail-badge-view-model";
  const BADGE_CLASS = "fr-youtube-price";
  const LIVE_OR_DURATION_SELECTOR = "ytd-thumbnail-overlay-time-status-renderer, ytd-badge-supported-renderer";
  let enabled = true;
  let observer;
  let scanTimer = 0;

  function containsShort(card) {
    return Array.from(card.querySelectorAll("a[href]"))
      .some((link) => /\/shorts\//i.test(link.getAttribute("href") || ""));
  }

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

  function updateCard(card) {
    const existing = card.querySelector(`.${BADGE_CLASS}`);
    const menu = findMenu(card);
    const validVideo = card.querySelectorAll("a[href]").length > 0;
    if (!validVideo || !menu || containsShort(card) || isLive(card)) {
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
    const tooltip = `Estimated value based on video duration (${window.FocusRewardsPricing.COINS_PER_MINUTE} coins per minute). No coins are spent.`;
    if (badge.getAttribute("title") !== tooltip) badge.setAttribute("title", tooltip);
    const accessibleLabel = `Estimated value: ${price} coins, calculated from video duration. No coins are spent.`;
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
    if (!enabled) return;
    document.querySelectorAll(CARD_SELECTOR).forEach(updateCard);
  }

  function scheduleScan() {
    if (scanTimer) window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(scan, 120);
  }

  function setEnabled(value) {
    enabled = value !== false;
    if (enabled) {
      scheduleScan();
    } else {
      if (scanTimer) window.clearTimeout(scanTimer);
      scanTimer = 0;
      document.querySelectorAll(`.${BADGE_CLASS}`).forEach((badge) => badge.remove());
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

    chrome.storage.sync.get({ [SETTING]: true }, (settings) => {
      setEnabled(settings[SETTING]);
    });
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "sync" && changes[SETTING]) {
        setEnabled(changes[SETTING].newValue);
      }
    });
  }

  start();
})();
