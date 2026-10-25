(() => {
  "use strict";

  const SETTING = "youtubePriceIndicatorEnabled";
  const checkbox = document.getElementById("youtube-price-enabled");
  const status = document.getElementById("save-status");

  chrome.storage.sync.get({ [SETTING]: true }, (settings) => {
    checkbox.checked = settings[SETTING] !== false;
  });

  checkbox.addEventListener("change", () => {
    chrome.storage.sync.set({ [SETTING]: checkbox.checked }, () => {
      if (chrome.runtime.lastError) {
        status.textContent = "Couldn't save this setting. Please try again.";
        return;
      }
      status.textContent = checkbox.checked ? "Price estimates are on." : "Price estimates are off.";
    });
  });
})();
