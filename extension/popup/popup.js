(() => {
  "use strict";

  const card = document.querySelector(".account-card");
  const heading = document.getElementById("account-heading");
  const detail = document.getElementById("account-detail");
  const action = document.getElementById("account-action");

  function openOptions() {
    void chrome.runtime.openOptionsPage();
  }

  function setPending() {
    action.disabled = true;
    heading.textContent = "Konto wird geprüft…";
    detail.textContent = "Verbindung zum Server wird überprüft.";
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

  action.addEventListener("click", () => {
    if (card.dataset.state === "error") checkStatus();
    else openOptions();
  });

  checkStatus();
})();
