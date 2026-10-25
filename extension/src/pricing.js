(function (root) {
  "use strict";

  const COINS_PER_MINUTE = 1.2;

  function priceForDurationSeconds(durationSeconds) {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
    return Math.max(1, Math.ceil((durationSeconds / 60) * COINS_PER_MINUTE));
  }

  function parseDurationSeconds(value) {
    if (typeof value !== "string") return null;
    const text = value.trim();
    if (!text) return null;

    const clock = text.match(/(?:^|\s)(\d{1,3}:\d{2}(?::\d{2})?)(?:\s|$)/);
    if (clock) {
      const parts = clock[1].split(":").map(Number);
      if (parts.some((part) => !Number.isInteger(part))) return null;
      if (parts.length === 2 && parts[1] < 60) return parts[0] * 60 + parts[1] || null;
      if (parts.length === 3 && parts[1] < 60 && parts[2] < 60) {
        return parts[0] * 3600 + parts[1] * 60 + parts[2] || null;
      }
      return null;
    }

    const hours = text.match(/(\d+)\s*hours?/i);
    const minutes = text.match(/(\d+)\s*minutes?/i);
    const seconds = text.match(/(\d+)\s*seconds?/i);
    if (!hours && !minutes && !seconds) return null;

    const totalSeconds = (Number(hours?.[1] ?? 0) * 3600)
      + (Number(minutes?.[1] ?? 0) * 60)
      + Number(seconds?.[1] ?? 0);
    return Number.isFinite(totalSeconds) && totalSeconds > 0 ? totalSeconds : null;
  }

  root.FocusRewardsPricing = Object.freeze({
    COINS_PER_MINUTE,
    parseDurationSeconds,
    priceForDurationSeconds,
  });
})(globalThis);
