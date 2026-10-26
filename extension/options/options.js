(() => {
  "use strict";

  const SETTING = "youtubePriceIndicatorEnabled";
  const checkbox = document.getElementById("youtube-price-enabled");
  const status = document.getElementById("save-status");
  const pairForm = document.getElementById("pair-form");
  const siteUrl = document.getElementById("convex-site-url");
  const pairingCode = document.getElementById("pairing-code");
  const pairButton = document.getElementById("pair-button");
  const accountStatus = document.getElementById("account-status");
  const revokeButton = document.getElementById("revoke-button");

  function request(type, data = {}) {
    return chrome.runtime.sendMessage({ type, ...data });
  }

  function showAccountState(result) {
    if (!result.ok) {
      accountStatus.textContent = result.message;
      return;
    }
    if (result.signedIn) {
      if (result.siteUrl) siteUrl.value = result.siteUrl;
      accountStatus.textContent = `Linked to ${result.email || "your approved account"}. Session expires ${new Date(result.expiresAt).toLocaleString()}.`;
      revokeButton.hidden = false;
      pairForm.hidden = true;
      return;
    }
    pairForm.hidden = false;
    revokeButton.hidden = true;
    accountStatus.textContent = result.reason === "expired-or-revoked"
      ? "The extension session expired or was revoked. Link the account again to continue."
      : "No Focus Rewards account is linked.";
  }

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

  pairForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    pairButton.disabled = true;
    accountStatus.textContent = "Linking securely…";
    try {
      const result = await request("pair", { siteUrl: siteUrl.value, code: pairingCode.value.trim() });
      if (!result.ok) {
        accountStatus.textContent = result.message;
        return;
      }
      pairingCode.value = "";
      showAccountState({ ...result, signedIn: true, siteUrl: siteUrl.value });
    } catch {
      accountStatus.textContent = "Could not reach Focus Rewards. Check the URL and network, then try again.";
    } finally {
      pairButton.disabled = false;
    }
  });

  revokeButton.addEventListener("click", async () => {
    revokeButton.disabled = true;
    accountStatus.textContent = "Revoking extension session…";
    try {
      const result = await request("revoke");
      if (!result.ok) {
        accountStatus.textContent = result.message;
        return;
      }
      showAccountState({ ok: true, signedIn: false });
    } catch {
      accountStatus.textContent = "Could not reach the server. Your saved session was kept so you can retry revocation.";
    } finally {
      revokeButton.disabled = false;
    }
  });

  void request("status").then(showAccountState).catch(() => {
    accountStatus.textContent = "Could not check the extension account. Check your network and retry.";
  });
})();
