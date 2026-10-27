(() => {
  "use strict";

  const card = document.querySelector(".account-card");
  const heading = document.getElementById("account-heading");
  const detail = document.getElementById("account-detail");
  const action = document.getElementById("account-action");
  const pricing = document.querySelector(".pricing-controls");
  const standardRate = document.getElementById("standard-rate");
  const shortsRate = document.getElementById("shorts-rate");
  const saveRates = document.getElementById("save-rates");
  const pricingStatus = document.getElementById("pricing-status");
  let savedRates = null;
  const flexibleRateValue = document.getElementById("flexible-rate-value");

  function openOptions() {
    void chrome.runtime.openOptionsPage();
  }

  function setPending() {
    action.disabled = true;
    heading.textContent = "Konto wird geprüft…";
    detail.textContent = "Verbindung zum Server wird überprüft.";
  }

  function loadRates() {
    chrome.runtime.sendMessage({ type: "youtube-pricing-rates" }).then((result) => {
      if (!result?.ok) { pricing.hidden = true; return; }
      savedRates = { standard: result.standardCoinsPerMinute, shorts: result.shortsCoinsPerMinute };
      flexibleRateValue.value = String(result.flexibleCoinsPerMinute).replace(".", ",");
      standardRate.value = String(savedRates.standard);
      shortsRate.value = String(savedRates.shorts);
      document.getElementById("standard-rate-value").value = String(savedRates.standard).replace(".", ",");
      document.getElementById("shorts-rate-value").value = String(savedRates.shorts).replace(".", ",");
      pricing.hidden = false;
    });
  }

  function checkStatus() {
    setPending();
    chrome.runtime.sendMessage({ type: "status" }).then((result) => {
      if (!result?.ok) {
        card.dataset.state = "error";
        heading.textContent = "Verbindung nicht verfügbar";
        detail.textContent = result?.message || "Kontostatus konnte nicht geprüft werden. Bitte Verbindung prüfen.";
        action.textContent = "Erneut versuchen";
        return;
      }
      if (result.signedIn) {
        card.dataset.state = "connected";
        heading.textContent = "Konto verbunden";
        detail.textContent = `${result.email || "Focus-Rewards-Konto"} · Sitzung gültig bis ${new Date(result.expiresAt).toLocaleDateString("de-DE")}`;
        action.textContent = "Konto verwalten";
        loadRates();
        return;
      }
      card.dataset.state = "disconnected";
      heading.textContent = result.reason === "expired-or-revoked" ? "Erneut verbinden" : "Noch kein Konto verbunden";
      detail.textContent = result.reason === "expired-or-revoked"
        ? "Die Erweiterungssitzung ist abgelaufen oder wurde widerrufen."
        : "Verknüpfe dein Konto, um YouTube-Freischaltungen zu nutzen.";
      action.textContent = "Konto verknüpfen";
    }).catch(() => {
      card.dataset.state = "error";
      heading.textContent = "Verbindung nicht verfügbar";
      detail.textContent = "Kontostatus konnte nicht geprüft werden. Prüfe die Verbindung und versuche es erneut.";
      action.textContent = "Erneut versuchen";
    }).finally(() => {
      action.disabled = false;
    });
  }

  standardRate.addEventListener("input", () => { document.getElementById("standard-rate-value").value = Number(standardRate.value).toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 2 }); saveRates.disabled = false; });
  shortsRate.addEventListener("input", () => { document.getElementById("shorts-rate-value").value = Number(shortsRate.value).toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 2 }); saveRates.disabled = false; });
  saveRates.addEventListener("click", async () => {
    if (!savedRates) return;
    saveRates.disabled = true;
    pricingStatus.textContent = "Speichere serverseitig…";
    const result = await new Promise((resolve) => chrome.runtime.sendMessage({ type: "youtube-pricing-save", rates: { standardCoinsPerMinute: Number(standardRate.value), shortsCoinsPerMinute: Number(shortsRate.value), expectedStandard: savedRates.standard, expectedShorts: savedRates.shorts } }, resolve));
    if (!result?.ok) {
      pricingStatus.textContent = result?.message || "Speichern fehlgeschlagen; aktuelle Preise bleiben unverändert.";
      saveRates.disabled = false;
      if (result?.kind === "conflict") loadRates();
      return;
    }
    savedRates = { standard: result.standardCoinsPerMinute, shorts: result.shortsCoinsPerMinute };
    pricingStatus.textContent = "Preise vom Server gespeichert. Neue Schätzungen verwenden die aktualisierten Tarife.";
  });

  action.addEventListener("click", () => {
    if (card.dataset.state === "error") checkStatus();
    else openOptions();
  });

  checkStatus();
})();
