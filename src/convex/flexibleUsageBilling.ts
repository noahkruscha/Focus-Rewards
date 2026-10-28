import { ConvexError } from "convex/values";

export const FLEXIBLE_LEASE_MS = 10_000;
export const FLEXIBLE_RENEW_LEAD_MS = 2_000;
export const FLEXIBLE_MAX_SESSION_MS = 30 * 60_000;
export const FLEXIBLE_RECOVERY_GRACE_MS = 30_000;
export const FLEXIBLE_MAX_RESERVED_COINS = 20;
export const FLEXIBLE_MAX_RATE = 100;
export const FLEXIBLE_OPERATION_KEY = /^[A-Za-z0-9_-]{16,128}$/;
export const FLEXIBLE_RECOVERY_TOKEN_HASH = /^[a-f0-9]{64}$/;

/** Default-off opt-in that is additionally restricted to Convex's local runtime. */
export function isFlexibleUsageEnabled(): boolean {
  if (process.env.FLEXIBLE_USAGE_ENABLED !== "true") return false;
  try {
    const deploymentUrl = new URL(process.env.CONVEX_CLOUD_URL ?? "");
    return deploymentUrl.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(deploymentUrl.hostname);
  } catch {
    return false;
  }
}

/** Round the cumulative session charge up to a whole Coin (rate precision: 0.01 Coin/min). */
export function flexibleCumulativeCharge(rateCoinsPerMinute: number, authorizedMs: number): number {
  if (!Number.isFinite(rateCoinsPerMinute) || rateCoinsPerMinute <= 0 || rateCoinsPerMinute > FLEXIBLE_MAX_RATE
    || !Number.isSafeInteger(Math.round(rateCoinsPerMinute * 100)) || !Number.isSafeInteger(authorizedMs) || authorizedMs < 0) {
    throw new ConvexError("Invalid flexible usage billing input.");
  }
  return Math.ceil((Math.round(rateCoinsPerMinute * 100) * authorizedMs) / 6_000_000);
}

/** Reserve the maximum whole-Coin charge for one authorized interval. */
export function flexibleLeaseReservation(rateCoinsPerMinute: number, durationMs = FLEXIBLE_LEASE_MS): number {
  const reservation = flexibleCumulativeCharge(rateCoinsPerMinute, durationMs);
  if (!Number.isSafeInteger(reservation) || reservation < 1 || reservation > FLEXIBLE_MAX_RESERVED_COINS) {
    throw new ConvexError("Flexible usage rate exceeds the interval reservation limit.");
  }
  return reservation;
}
