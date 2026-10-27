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
      accountStatus.textContent = result.message || "Der Kontostatus konnte nicht geladen werden.";
      return;
    }
    if (result.signedIn) {
      if (result.siteUrl) siteUrl.value = result.siteUrl;
      accountStatus.textContent = `Verbunden mit ${result.email || "deinem Konto"}. Sitzung gültig bis ${new Date(result.expiresAt).toLocaleString("de-DE")}.`;
      revokeButton.hidden = false;
      pairForm.hidden = true;
      return;
    }
    pairForm.hidden = false;
    revokeButton.hidden = true;
    accountStatus.textContent = result.reason === "expired-or-revoked"
      ? "Die Erweiterungssitzung ist abgelaufen oder wurde widerrufen. Verbinde dein Konto erneut."
      : "Es ist noch kein Focus-Rewards-Konto verbunden.";
  }

  chrome.storage.sync.get({ [SETTING]: true }, (settings) => {
    if (chrome.runtime.lastError) {
      checkbox.disabled = true;
      status.textContent = "Die Einstellung konnte nicht geladen werden.";
      return;
    }
    checkbox.checked = settings[SETTING] !== false;
  });

  checkbox.addEventListener("change", () => {
    chrome.storage.sync.set({ [SETTING]: checkbox.checked }, () => {
      if (chrome.runtime.lastError) {
        status.textContent = "Einstellung konnte nicht gespeichert werden. Bitte erneut versuchen.";
        return;
      }
      status.textContent = checkbox.checked ? "Preisschätzungen sind aktiviert." : "Preisschätzungen sind deaktiviert.";
    });
  });

  pairForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    pairButton.disabled = true;
    accountStatus.textContent = "Sichere Verbindung wird hergestellt…";
    try {
      const result = await request("pair", { siteUrl: siteUrl.value, code: pairingCode.value.trim() });
      if (!result?.ok) {
        accountStatus.textContent = result?.message || "Der Server hat die Verbindung nicht bestätigt.";
        return;
      }
      pairingCode.value = "";
      showAccountState({ ...result, signedIn: true, siteUrl: siteUrl.value });
    } catch {
      accountStatus.textContent = "Focus Rewards ist nicht erreichbar. Prüfe URL und Verbindung und versuche es erneut.";
    } finally {
      pairButton.disabled = false;
    }
  });

  revokeButton.addEventListener("click", async () => {
    revokeButton.disabled = true;
    accountStatus.textContent = "Erweiterungssitzung wird widerrufen…";
    try {
      const result = await request("revoke");
      if (!result?.ok) {
        accountStatus.textContent = result?.message || "Die Sitzung konnte nicht widerrufen werden.";
        return;
      }
      showAccountState({ ok: true, signedIn: false });
    } catch {
      accountStatus.textContent = "Server nicht erreichbar. Deine Sitzung bleibt gespeichert, damit du den Widerruf erneut versuchen kannst.";
    } finally {
      revokeButton.disabled = false;
    }
  });

  void request("status").then(showAccountState).catch(() => {
    accountStatus.textContent = "Kontostatus konnte nicht geprüft werden. Prüfe deine Verbindung und versuche es erneut.";
  });
})();
