import { convexTest } from "convex-test";
import type { TestConvex } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { flexibleCumulativeCharge, flexibleLeaseReservation, FLEXIBLE_LEASE_MS, isFlexibleUsageEnabled } from "./flexibleUsageBilling";
import { recordTransaction } from "./rewards";

const modules = {
  "./_generated/api.js": () => import("./_generated/api.js"),
  "./_generated/server.js": () => import("./_generated/server.js"),
  "./access.ts": () => import("./access"),
  "./http.ts": () => import("./http"),
  "./rewards.ts": () => import("./rewards"),
  "./users.ts": () => import("./users"),
};

type Test = TestConvex<typeof schema>;

function createTest() {
  process.env.CONVEX_CLOUD_URL = "http://127.0.0.1:3210";
  process.env.FLEXIBLE_USAGE_ENABLED = "true";
  process.env.BETA_REQUIRE_APPROVAL = "true";
  process.env.BETA_INVITATIONS_ENABLED = "true";
  process.env.BETA_ADMIN_EMAIL = "owner@example.com";
  return convexTest(schema, modules as never) as Test;
}

async function createFlexibleMember(t: Test, email: string, coins: number, rate = 1.6) {
  const now = Date.now();
  const userId = await t.run(async (ctx) => await ctx.db.insert("users", {
    email, displayName: "Flexible member", onboardingCompletedAt: now, emailVerificationTime: now, isAnonymous: false,
  }));
  const identity = t.withIdentity({ subject: `${userId}|flexible-test`, email });
  await t.run(async (ctx) => await ctx.db.insert("betaAccess", { userId, status: "approved", requestedAt: now, updatedAt: now }));
  await identity.mutation(api.rewards.initialize);
  await identity.mutation(api.rewards.setYouTubePricingRates, { standardCoinsPerMinute: 1.2, shortsCoinsPerMinute: 1.4, flexibleCoinsPerMinute: rate });
  await t.run(async (ctx) => {
    const account = await ctx.db.query("accountData").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
    await ctx.db.patch(account!._id, { coins });
    await ctx.db.insert("extensionSessions", { tokenHash: `${String(userId).slice(-24).padEnd(64, "a")}`.slice(0, 64), userId, createdAt: now, expiresAt: now + 24 * 60 * 60_000 });
  });
  const tokenHash = await t.run(async (ctx) => {
    const session = await ctx.db.query("extensionSessions").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
    return session!.tokenHash;
  });
  return { userId, identity, tokenHash };
}

const recoveryTokenHash = "a".repeat(64);

function keys(seed: string) {
  return { startKey: `start-${seed}-0000000000`, operationKey: `operation-${seed}-0000000`, recoveryTokenHash };
}

async function hashExtensionToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`focus-rewards:extension-session:v1:${token}`));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("Flexible Shorts billing protocol", () => {
  it("fails closed outside a local Convex runtime even when the opt-in is set", () => {
    const originalCloudUrl = process.env.CONVEX_CLOUD_URL;
    const originalEnabled = process.env.FLEXIBLE_USAGE_ENABLED;
    try {
      process.env.FLEXIBLE_USAGE_ENABLED = "true";
      process.env.CONVEX_CLOUD_URL = "https://production.convex.cloud";
      expect(isFlexibleUsageEnabled()).toBe(false);
      process.env.CONVEX_CLOUD_URL = "http://127.0.0.1:3210";
      expect(isFlexibleUsageEnabled()).toBe(true);
      delete process.env.FLEXIBLE_USAGE_ENABLED;
      expect(isFlexibleUsageEnabled()).toBe(false);
    } finally {
      if (originalCloudUrl === undefined) delete process.env.CONVEX_CLOUD_URL;
      else process.env.CONVEX_CLOUD_URL = originalCloudUrl;
      if (originalEnabled === undefined) delete process.env.FLEXIBLE_USAGE_ENABLED;
      else process.env.FLEXIBLE_USAGE_ENABLED = originalEnabled;
    }
  });

  it("uses cumulative whole-Coin rounding so many short intervals match total usage", () => {
    expect(flexibleLeaseReservation(1.6)).toBe(1);
    expect(flexibleCumulativeCharge(1.6, 60_000)).toBe(2);
    expect(flexibleCumulativeCharge(1.6, 10 * FLEXIBLE_LEASE_MS)).toBe(3);
    expect(flexibleCumulativeCharge(1.6, 60 * 60_000)).toBe(96);
  });

  it("atomically reserves the saved rate once and returns the same session for a lost start response", async () => {
    const t = createTest();
    const { userId, tokenHash } = await createFlexibleMember(t, "reserve@example.com", 10);
    const ownerTabId = 8;
    const start = { tokenHash, ownerTabId, ...keys("retry-start") };
    const first = await t.mutation(internal.rewards.startFlexibleUsage, start);
    const retry = await t.mutation(internal.rewards.startFlexibleUsage, start);
    expect(retry).toMatchObject({ sessionId: first.sessionId, status: "active", resumed: true, rateCoinsPerMinute: 1.6, reservedCoins: 1 });
    const state = await t.run(async (ctx) => ({
      account: await ctx.db.query("accountData").withIndex("by_user", (q) => q.eq("userId", userId)).unique(),
      sessions: await ctx.db.query("flexibleUsageSessions").withIndex("by_user", (q) => q.eq("userId", userId)).collect(),
      intervals: await ctx.db.query("flexibleUsageIntervals").collect(),
      transactions: await ctx.db.query("walletTransactions").withIndex("by_user_time", (q) => q.eq("userId", userId)).collect(),
    }));
    expect(state.account?.coins).toBe(9);
    expect(state.sessions).toHaveLength(1);
    expect(state.intervals).toHaveLength(1);
    expect(state.transactions).toHaveLength(1);
    expect(state.transactions[0]).toMatchObject({ amount: -1, type: "youtube_flexible_reservation", idempotencyKey: `flex:reserve:${first.sessionId}:1` });
    await expect(t.mutation(internal.rewards.startFlexibleUsage, { ...start, startKey: "start-other-00000000000", operationKey: start.operationKey })).rejects.toThrow(/already active|active in another tab|already used/);
  });

  it("rejects an interval reservation when the wallet is insufficient without writing session or ledger records", async () => {
    const t = createTest();
    const { userId, tokenHash } = await createFlexibleMember(t, "poor@example.com", 0, 100);
    await expect(t.mutation(internal.rewards.startFlexibleUsage, { tokenHash, ownerTabId: 1, ...keys("poor-start") })).rejects.toThrow(/INSUFFICIENT_COINS/);
    const state = await t.run(async (ctx) => ({ sessions: await ctx.db.query("flexibleUsageSessions").collect(), intervals: await ctx.db.query("flexibleUsageIntervals").collect(), transactions: await ctx.db.query("walletTransactions").collect(), account: await ctx.db.query("accountData").withIndex("by_user", (q) => q.eq("userId", userId)).unique() }));
    expect(state.sessions).toHaveLength(0);
    expect(state.intervals).toHaveLength(0);
    expect(state.transactions).toHaveLength(0);
    expect(state.account?.coins).toBe(0);
  });

  it("allows only one active session for concurrent starts across tabs", async () => {
    const t = createTest();
    const { userId, tokenHash } = await createFlexibleMember(t, "concurrent@example.com", 20);
    const [one, two] = await Promise.allSettled([
      t.mutation(internal.rewards.startFlexibleUsage, { tokenHash, ownerTabId: 1, ...keys("tab-one") }),
      t.mutation(internal.rewards.startFlexibleUsage, { tokenHash, ownerTabId: 2, ...keys("tab-two") }),
    ]);
    expect([one, two].filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect([one, two].filter((result) => result.status === "rejected")).toHaveLength(1);
    const sessions = await t.run(async (ctx) => await ctx.db.query("flexibleUsageSessions").withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", "active")).collect());
    expect(sessions).toHaveLength(1);
  });

  it("settles by server time, supports renewal retries, and releases unused reservations on stop", async () => {
    const t = createTest();
    const { userId, tokenHash } = await createFlexibleMember(t, "settle@example.com", 100);
    const ownerTabId = 3;
    const start = await t.mutation(internal.rewards.startFlexibleUsage, { tokenHash, ownerTabId, ...keys("settle") });
    try {
      vi.useFakeTimers();
      vi.setSystemTime(start.leaseExpiresAt - 2_000);
      const renewalKey = "renew-operation-00000001";
      const renewArgs = { tokenHash, ownerTabId, sessionId: start.sessionId, expectedSequence: 1, ownershipEpoch: start.ownershipEpoch, operationKey: renewalKey };
      const renewed = await t.mutation(internal.rewards.renewFlexibleUsage, renewArgs);
      expect(renewed).toMatchObject({ status: "active", sequence: 2, leaseStartedAt: start.leaseExpiresAt, leaseExpiresAt: start.leaseExpiresAt + FLEXIBLE_LEASE_MS, chargedCoins: 1, reservedCoins: 1 });
      const duplicate = await t.mutation(internal.rewards.renewFlexibleUsage, renewArgs);
      expect(duplicate).toMatchObject({ sequence: 2, leaseExpiresAt: renewed.leaseExpiresAt });
      const afterRenewal = await t.run(async (ctx) => ({ intervals: await ctx.db.query("flexibleUsageIntervals").withIndex("by_session_sequence", (q) => q.eq("sessionId", start.sessionId)).collect(), transactions: await ctx.db.query("walletTransactions").collect() }));
      expect(afterRenewal.intervals).toHaveLength(2);
      expect(afterRenewal.transactions.filter((transaction: Doc<"walletTransactions">) => transaction.type === "youtube_flexible_reservation")).toHaveLength(2);
      vi.setSystemTime(start.leaseExpiresAt + 3_500);
      const stopped = await t.mutation(internal.rewards.stopFlexibleUsage, { tokenHash, ownerTabId, sessionId: start.sessionId, ownershipEpoch: renewed.ownershipEpoch, operationKey: "stop-operation-00000001" });
      expect(stopped).toMatchObject({ status: "stopped", authorizedMs: 13_500, chargedCoins: 1, reservedCoins: 0 });
      const retry = await t.mutation(internal.rewards.stopFlexibleUsage, { tokenHash, ownerTabId, sessionId: start.sessionId, ownershipEpoch: renewed.ownershipEpoch, operationKey: "stop-operation-00000001" });
      expect(retry).toMatchObject({ status: "stopped", chargedCoins: 1 });
      const state = await t.run(async (ctx) => ({
        account: await ctx.db.query("accountData").withIndex("by_user", (q) => q.eq("userId", userId)).unique(),
        intervals: await ctx.db.query("flexibleUsageIntervals").withIndex("by_session_sequence", (q) => q.eq("sessionId", start.sessionId)).collect(),
        transactions: await ctx.db.query("walletTransactions").withIndex("by_user_time", (q) => q.eq("userId", userId)).collect(),
      }));
      expect(state.account?.coins).toBe(99);
      expect(state.intervals[1]).toMatchObject({ status: "settled", consumedMs: 3_500, chargedCoins: 0, refundedCoins: 1 });
      expect(state.transactions.filter((transaction: Doc<"walletTransactions">) => transaction.type === "youtube_flexible_refund")).toHaveLength(1);
      expect(state.transactions.reduce((sum: number, transaction: Doc<"walletTransactions">) => sum + transaction.amount, 0)).toBe(-1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not double-charge or double-refund when a committed partial stop is retried after a lost response", async () => {
    const t = createTest();
    const { userId, tokenHash } = await createFlexibleMember(t, "lost-settlement@example.com", 50, 100);
    const start = await t.mutation(internal.rewards.startFlexibleUsage, { tokenHash, ownerTabId: 6, ...keys("lost-settlement") });
    expect(start.reservedCoins).toBe(17);
    try {
      vi.useFakeTimers();
      vi.setSystemTime(start.leaseStartedAt + 1_000);
      const stopArgs = { tokenHash, ownerTabId: 6, sessionId: start.sessionId, ownershipEpoch: start.ownershipEpoch,
        operationKey: "lost-settlement-stop-operation-01" };
      // Treat this committed response as lost: the client repeats exactly the same operation.
      await t.mutation(internal.rewards.stopFlexibleUsage, stopArgs);
      const retry = await t.mutation(internal.rewards.stopFlexibleUsage, stopArgs);
      expect(retry).toMatchObject({ status: "stopped", authorizedMs: 1_000, chargedCoins: 2, reservedCoins: 0 });
      const state = await t.run(async (ctx) => ({
        account: await ctx.db.query("accountData").withIndex("by_user", (q) => q.eq("userId", userId)).unique(),
        session: await ctx.db.get(start.sessionId),
        intervals: await ctx.db.query("flexibleUsageIntervals").withIndex("by_session_sequence", (q) => q.eq("sessionId", start.sessionId)).collect(),
        transactions: await ctx.db.query("walletTransactions").withIndex("by_user_time", (q) => q.eq("userId", userId)).collect(),
      }));
      expect(state.account?.coins).toBe(48);
      expect(state.session).toMatchObject({ status: "stopped", authorizedMs: 1_000, chargedCoins: 2, reservedCoins: 0 });
      expect(state.intervals).toHaveLength(1);
      expect(state.intervals[0]).toMatchObject({ status: "settled", consumedMs: 1_000, chargedCoins: 2, refundedCoins: 15 });
      expect(state.transactions.filter((transaction: Doc<"walletTransactions">) => transaction.type === "youtube_flexible_reservation")).toHaveLength(1);
      expect(state.transactions.filter((transaction: Doc<"walletTransactions">) => transaction.type === "youtube_flexible_refund")).toHaveLength(1);
      expect(state.transactions.reduce((sum: number, transaction: Doc<"walletTransactions">) => sum + transaction.amount, 0)).toBe(-2);
    } finally { vi.useRealTimers(); }
  });

  it("expires an abandoned authorized interval at its server lease boundary and releases its reservation", async () => {
    const t = createTest();
    const { userId, tokenHash } = await createFlexibleMember(t, "abandoned@example.com", 10);
    const originalNow = Date.now();
    const start = await t.mutation(internal.rewards.startFlexibleUsage, { tokenHash, ownerTabId: 5, ...keys("abandoned") });
    try {
      vi.useFakeTimers();
      vi.setSystemTime(originalNow + FLEXIBLE_LEASE_MS + 1);
      const expired = await t.mutation(internal.rewards.expireFlexibleUsage, { sessionId: start.sessionId, sequence: 1 });
      expect(expired).toMatchObject({ status: "expired", authorizedMs: FLEXIBLE_LEASE_MS, chargedCoins: 1, reservedCoins: 0 });
      const account = await t.run(async (ctx) => await ctx.db.query("accountData").withIndex("by_user", (q) => q.eq("userId", userId)).unique());
      expect(account?.coins).toBe(9);
      const interval = await t.run(async (ctx) => await ctx.db.query("flexibleUsageIntervals").withIndex("by_session_sequence", (q) => q.eq("sessionId", start.sessionId)).unique());
      expect(interval).toMatchObject({ status: "settled", consumedMs: FLEXIBLE_LEASE_MS, chargedCoins: 1, refundedCoins: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops at zero balance after an authorized high-rate interval without creating a negative balance", async () => {
    const t = createTest();
    const { userId, tokenHash } = await createFlexibleMember(t, "low-next-interval@example.com", 17, 100);
    const originalNow = Date.now();
    const start = await t.mutation(internal.rewards.startFlexibleUsage, { tokenHash, ownerTabId: 7, ...keys("low-next") });
    expect(start.reservedCoins).toBe(17);
    try {
      vi.useFakeTimers();
      vi.setSystemTime(originalNow + FLEXIBLE_LEASE_MS - 1);
      const result = await t.mutation(internal.rewards.renewFlexibleUsage, { tokenHash, ownerTabId: 7, sessionId: start.sessionId, expectedSequence: 1, ownershipEpoch: start.ownershipEpoch, operationKey: "renew-low-balance-0001" });
      expect(result).toMatchObject({ status: "insufficient", authorizedMs: FLEXIBLE_LEASE_MS, chargedCoins: 17, reservedCoins: 0, availableCoins: 0 });
      const state = await t.run(async (ctx) => ({ account: await ctx.db.query("accountData").withIndex("by_user", (q) => q.eq("userId", userId)).unique(), transactions: await ctx.db.query("walletTransactions").withIndex("by_user_time", (q) => q.eq("userId", userId)).collect() }));
      expect(state.account?.coins).toBe(0);
      expect(state.transactions.reduce((sum: number, transaction: Doc<"walletTransactions">) => sum + transaction.amount, 0)).toBe(-17);
    } finally {
      vi.useRealTimers();
    }
  });

  it("exposes only authenticated flexible HTTP routes and ignores client-supplied timestamps", async () => {
    const t = createTest();
    const { userId } = await createFlexibleMember(t, "http-flex@example.com", 10);
    const token = "F".repeat(43);
    const tokenHash = await hashExtensionToken(token);
    const now = Date.now();
    await t.run(async (ctx) => await ctx.db.insert("extensionSessions", { tokenHash, userId, createdAt: now, expiresAt: now + 60_000 }));
    const recoveryToken = "a".repeat(64);
    const body = { ownerTabId: 11, startKey: "http-start-operation-0001", operationKey: "http-start-operation-0002", recoveryToken, now: now - 20 * 60_000 };
    const denied = await t.fetch("/extension/youtube/flexible/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect(denied.status).toBe(401);
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const started = await t.fetch("/extension/youtube/flexible/start", { method: "POST", headers, body: JSON.stringify(body) });
    expect(started.status).toBe(200);
    const result = await started.json() as { status: string; leaseStartedAt: number; leaseExpiresAt: number };
    expect(result.status).toBe("active");
    expect(result.leaseStartedAt).toBeGreaterThanOrEqual(now - 1_000);
    expect(result.leaseExpiresAt - result.leaseStartedAt).toBe(FLEXIBLE_LEASE_MS);
    const state = await t.fetch("/extension/youtube/flexible/state", { method: "POST", headers, body: JSON.stringify({ ownerTabId: 11 }) });
    expect(state.status).toBe(200);
    expect(await state.json()).toMatchObject({ session: { status: "active" }, activeElsewhere: false });
    const invalid = await t.fetch("/extension/youtube/flexible/renew", { method: "POST", headers, body: JSON.stringify({ ownerTabId: 11, sessionId: "invalid", expectedSequence: 1, ownershipEpoch: 1, operationKey: "http-renew-operation-01" }) });
    expect(invalid.status).toBe(409);
    expect(await invalid.json()).toMatchObject({ error: "Flexible session is invalid." });
  });

  it("ignores client clock and elapsed-time claims when authorizing and billing an interval", async () => {
    const t = createTest();
    const { userId } = await createFlexibleMember(t, "clock-skew@example.com", 20);
    const token = "K".repeat(43);
    const tokenHash = await hashExtensionToken(token);
    const initialServerTime = Date.now();
    await t.run(async (ctx) => await ctx.db.insert("extensionSessions", { tokenHash, userId, createdAt: initialServerTime, expiresAt: initialServerTime + 60_000 }));
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const skewedClientStart = await t.fetch("/extension/youtube/flexible/start", { method: "POST", headers,
      body: JSON.stringify({ ownerTabId: 81, startKey: "clock-skew-start-operation-01", operationKey: "clock-skew-start-op-0001",
        recoveryToken: "d".repeat(64), now: initialServerTime + 86_400_000, elapsedMs: 86_400_000 }) });
    expect(skewedClientStart.status).toBe(200);
    const start = await skewedClientStart.json() as { sessionId: string; ownershipEpoch: number; leaseStartedAt: number; leaseExpiresAt: number };
    expect(start.leaseStartedAt).toBeGreaterThanOrEqual(initialServerTime - 1_000);
    expect(start.leaseStartedAt).toBeLessThan(initialServerTime + 1_000);
    expect(start.leaseExpiresAt - start.leaseStartedAt).toBe(FLEXIBLE_LEASE_MS);

    try {
      vi.useFakeTimers();
      vi.setSystemTime(start.leaseExpiresAt - 2_000);
      const renewal = await t.fetch("/extension/youtube/flexible/renew", { method: "POST", headers,
        body: JSON.stringify({ ownerTabId: 81, sessionId: start.sessionId, expectedSequence: 1,
          ownershipEpoch: start.ownershipEpoch, operationKey: "clock-skew-renew-operation-01",
          clientNow: start.leaseStartedAt - 10 * 86_400_000, elapsedMs: Number.MAX_SAFE_INTEGER }) });
      expect(renewal.status).toBe(200);
      const result = await renewal.json() as { leaseStartedAt: number; leaseExpiresAt: number; authorizedMs: number; chargedCoins: number; sequence: number };
      expect(result.sequence).toBe(2);
      expect(result.leaseStartedAt).toBe(start.leaseExpiresAt);
      expect(result.leaseExpiresAt - result.leaseStartedAt).toBe(FLEXIBLE_LEASE_MS);
      expect(result.authorizedMs).toBe(FLEXIBLE_LEASE_MS);
      expect(result.chargedCoins).toBe(1);
      const audit = await t.run(async (ctx) => ({
        account: await ctx.db.query("accountData").withIndex("by_user", (q) => q.eq("userId", userId)).unique(),
        intervals: await ctx.db.query("flexibleUsageIntervals").collect(),
        transactions: await ctx.db.query("walletTransactions").withIndex("by_user_time", (q) => q.eq("userId", userId)).collect(),
      }));
      expect(audit.account?.coins).toBe(18);
      expect(audit.intervals).toHaveLength(2);
      expect(audit.intervals[0]).toMatchObject({ startedAt: start.leaseStartedAt, expiresAt: start.leaseExpiresAt, consumedMs: FLEXIBLE_LEASE_MS, chargedCoins: 1 });
      expect(audit.transactions.reduce((sum: number, transaction: Doc<"walletTransactions">) => sum + transaction.amount, 0)).toBe(-2);
    } finally { vi.useRealTimers(); }
  });

  it("isolates sessions by account and rejects foreign session operations", async () => {
    const t = createTest();
    const first = await createFlexibleMember(t, "first@example.com", 10);
    const second = await createFlexibleMember(t, "second@example.com", 10);
    const started = await t.mutation(internal.rewards.startFlexibleUsage, { tokenHash: first.tokenHash, ownerTabId: 9, ...keys("owner") });
    await expect(t.mutation(internal.rewards.stopFlexibleUsage, { tokenHash: second.tokenHash, ownerTabId: 9, sessionId: started.sessionId, ownershipEpoch: started.ownershipEpoch, operationKey: "foreign-stop-operation" })).rejects.toThrow(/invalid/);
    const secondSession = await t.mutation(internal.rewards.flexibleUsageState, { tokenHash: second.tokenHash, ownerTabId: 9 });
    expect(secondSession.session).toBeNull();
  });

  it("recovers before lease expiry with the recovery secret, fences the stale owner, and retries idempotently", async () => {
    const t = createTest();
    const { userId, tokenHash } = await createFlexibleMember(t, "recover-before@example.com", 20);
    const start = await t.mutation(internal.rewards.startFlexibleUsage, { tokenHash, ownerTabId: 101, ...keys("recover-before") });
    const args = { tokenHash, ownerTabId: 202, sessionId: start.sessionId, expectedEpoch: start.ownershipEpoch,
      recoveryTokenHash, operationKey: "recover-before-operation-0001" };
    const recovered = await t.mutation(internal.rewards.recoverFlexibleUsage, args);
    expect(recovered).toMatchObject({ recovered: true, ownerTabId: 202, ownershipEpoch: 2, sequence: 1,
      leaseExpiresAt: start.leaseExpiresAt, chargedCoins: 0, reservedCoins: 1 });
    expect(await t.mutation(internal.rewards.recoverFlexibleUsage, args)).toMatchObject({ recovered: true, ownershipEpoch: 2 });
    await expect(t.mutation(internal.rewards.renewFlexibleUsage, { tokenHash, ownerTabId: 101, sessionId: start.sessionId,
      expectedSequence: 1, ownershipEpoch: 1, operationKey: "stale-owner-renew-operation" })).rejects.toThrow(/ownership/);
    const state = await t.run(async (ctx) => ({ account: await ctx.db.query("accountData").withIndex("by_user", (q) => q.eq("userId", userId)).unique(), recoveries: await ctx.db.query("flexibleUsageRecoveries").collect(), intervals: await ctx.db.query("flexibleUsageIntervals").collect(), transactions: await ctx.db.query("walletTransactions").collect() }));
    expect(state.account?.coins).toBe(19);
    expect(state.recoveries).toHaveLength(1);
    expect(state.intervals).toHaveLength(1);
    expect(state.transactions).toHaveLength(1);
  });

  it("serializes concurrent recovery claims and grants the newer epoch to only one tab", async () => {
    const t = createTest();
    const { userId, tokenHash } = await createFlexibleMember(t, "recover-race@example.com", 20);
    const start = await t.mutation(internal.rewards.startFlexibleUsage, { tokenHash, ownerTabId: 10, ...keys("recover-race") });
    const outcomes = await Promise.allSettled([11, 12].map((ownerTabId) => t.mutation(internal.rewards.recoverFlexibleUsage, {
      tokenHash, ownerTabId, sessionId: start.sessionId, expectedEpoch: 1, recoveryTokenHash,
      operationKey: `recovery-race-${ownerTabId}-0001`,
    })));
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const state = await t.run(async (ctx) => ({ session: await ctx.db.get(start.sessionId), recoveries: await ctx.db.query("flexibleUsageRecoveries").collect(), transactions: await ctx.db.query("walletTransactions").collect(), account: await ctx.db.query("accountData").withIndex("by_user", (q) => q.eq("userId", userId)).unique() }));
    expect(state.session?.ownershipEpoch).toBe(2);
    expect(state.recoveries).toHaveLength(1);
    expect(state.transactions).toHaveLength(1);
    expect(state.account?.coins).toBe(19);
  });

  it("settles expired leases at server time once and audits recovery retries without duplicate charges", async () => {
    const t = createTest();
    const { userId, tokenHash } = await createFlexibleMember(t, "recover-expired@example.com", 20);
    const start = await t.mutation(internal.rewards.startFlexibleUsage, { tokenHash, ownerTabId: 31, ...keys("recover-expired") });
    const args = { tokenHash, ownerTabId: 32, sessionId: start.sessionId, expectedEpoch: 1, recoveryTokenHash,
      operationKey: "recover-expired-operation-01" };
    try {
      vi.useFakeTimers();
      vi.setSystemTime(start.leaseExpiresAt + 1);
      const expired = await t.mutation(internal.rewards.recoverFlexibleUsage, args);
      expect(expired).toMatchObject({ recovered: false, status: "expired",
        authorizedMs: FLEXIBLE_LEASE_MS, chargedCoins: 1, reservedCoins: 0 });
      expect(await t.mutation(internal.rewards.recoverFlexibleUsage, args)).toMatchObject({ recovered: false, status: "expired", chargedCoins: 1 });
      const state = await t.run(async (ctx) => ({ session: await ctx.db.get(start.sessionId), account: await ctx.db.query("accountData").withIndex("by_user", (q) => q.eq("userId", userId)).unique(), intervals: await ctx.db.query("flexibleUsageIntervals").collect(), transactions: await ctx.db.query("walletTransactions").collect(), recoveries: await ctx.db.query("flexibleUsageRecoveries").collect() }));
      expect(state.session?.stoppedAt).toBe(start.leaseExpiresAt);
      expect(state.account?.coins).toBe(19);
      expect(state.intervals[0]).toMatchObject({ status: "settled", consumedMs: FLEXIBLE_LEASE_MS, chargedCoins: 1, refundedCoins: 0 });
      expect(state.transactions.reduce((sum: number, transaction: Doc<"walletTransactions">) => sum + transaction.amount, 0)).toBe(-1);
      expect(state.recoveries).toHaveLength(1);
      expect(state.recoveries[0]).toMatchObject({ outcome: "expired", authorizedMs: FLEXIBLE_LEASE_MS, chargedCoins: 1, refundedCoins: 0 });
    } finally { vi.useRealTimers(); }
  });

  it("keeps an active reservation unchanged when the wallet receives another transaction", async () => {
    const t = createTest();
    const { userId, tokenHash } = await createFlexibleMember(t, "wallet-reservation@example.com", 5);
    const start = await t.mutation(internal.rewards.startFlexibleUsage, { tokenHash, ownerTabId: 71, ...keys("wallet-reservation") });
    await t.run(async (ctx) => await recordTransaction(ctx, { userId, amount: 3, type: "task_reward",
      description: "Unrelated wallet credit", referenceType: "task", referenceId: "test-credit",
      idempotencyKey: "flexible-wallet-credit-test" }));
    const current = await t.mutation(internal.rewards.flexibleUsageState, { tokenHash, ownerTabId: 71 });
    expect(current.session).toMatchObject({ status: "active", reservedCoins: start.reservedCoins,
      leaseExpiresAt: start.leaseExpiresAt, chargedCoins: 0, availableCoins: 7 });
    const state = await t.run(async (ctx) => ({ account: await ctx.db.query("accountData").withIndex("by_user", (q) => q.eq("userId", userId)).unique(),
      transactions: await ctx.db.query("walletTransactions").withIndex("by_user_time", (q) => q.eq("userId", userId)).collect() }));
    expect(state.account?.coins).toBe(7);
    expect(state.transactions.filter((transaction: Doc<"walletTransactions">) => transaction.type === "youtube_flexible_reservation")).toHaveLength(1);
  });

  it("rejects a wrong recovery secret and stale recovery epoch", async () => {
    const t = createTest();
    const { tokenHash } = await createFlexibleMember(t, "recover-secret@example.com", 20);
    const start = await t.mutation(internal.rewards.startFlexibleUsage, { tokenHash, ownerTabId: 51, ...keys("recover-secret") });
    await expect(t.mutation(internal.rewards.recoverFlexibleUsage, { tokenHash, ownerTabId: 52, sessionId: start.sessionId,
      expectedEpoch: 1, recoveryTokenHash: "b".repeat(64), operationKey: "forged-recovery-operation-01" })).rejects.toThrow(/credential/);
    await t.mutation(internal.rewards.recoverFlexibleUsage, { tokenHash, ownerTabId: 52, sessionId: start.sessionId,
      expectedEpoch: 1, recoveryTokenHash, operationKey: "valid-recovery-operation-0001" });
    await expect(t.mutation(internal.rewards.recoverFlexibleUsage, { tokenHash, ownerTabId: 53, sessionId: start.sessionId,
      expectedEpoch: 1, recoveryTokenHash, operationKey: "stale-recovery-operation-001" })).rejects.toThrow(/ownership/);
  });
});
