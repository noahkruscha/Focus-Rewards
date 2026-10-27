import { convexTest } from "convex-test";
import type { TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";

const modules = {
  "./_generated/api.js": () => import("./_generated/api.js"),
  "./_generated/server.js": () => import("./_generated/server.js"),
  "./access.ts": () => import("./access"),
  "./http.ts": () => import("./http"),
  "./rewards.ts": () => import("./rewards"),
  "./users.ts": () => import("./users"),
};
const ADMIN_EMAIL = "owner@example.com";

function createTest() {
  process.env.BETA_REQUIRE_APPROVAL = "true";
  process.env.BETA_INVITATIONS_ENABLED = "true";
  process.env.BETA_ADMIN_EMAIL = ADMIN_EMAIL;
  return convexTest(schema, modules as never) as TestConvex<typeof schema>;
}

async function createApprovedUser(t: ReturnType<typeof createTest>, email: string) {
  const userId = await t.run(async (ctx) => await ctx.db.insert("users", {
    email,
    displayName: "Extension member",
    onboardingCompletedAt: Date.now(),
    emailVerificationTime: Date.now(),
    isAnonymous: false,
  }));
  const identity = t.withIdentity({ subject: `${userId}|extension-test`, email });
  if (email === ADMIN_EMAIL) await identity.mutation(api.access._grantInitialAdministrator);
  else {
    await t.run(async (ctx) => await ctx.db.insert("betaAccess", {
      userId,
      status: "approved",
      requestedAt: Date.now(),
      updatedAt: Date.now(),
    }));
  }
  return { userId, identity };
}

async function hash(purpose: string, value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`focus-rewards:${purpose}:v1:${value}`));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("extension credential backend", () => {
  it("creates an owner-bound short-lived code and redeems it once for a 30-day session", async () => {
    const t = createTest();
    const { userId, identity } = await createApprovedUser(t, ADMIN_EMAIL);
    const { code, expiresAt } = await identity.action(api.access.createExtensionPairingCode, {});
    expect(code).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
    const pairHash = await hash("extension-pair", code);
    const pairing = await t.run(async (ctx) => (await ctx.db.query("extensionPairingCodes").collect()).find((item: Doc<"extensionPairingCodes">) => item.codeHash === pairHash));
    expect(pairing?.userId).toBe(userId);

    const tokenHash = "a".repeat(64);
    const now = Date.now();
    const session = await t.mutation(internal.access.redeemExtensionPairingCode, { codeHash: pairHash, sessionHash: tokenHash, now });
    expect(session.email).toBe(ADMIN_EMAIL);
    expect(session.expiresAt - now).toBe(30 * 24 * 60 * 60 * 1000);
    expect(await t.query(internal.access.assertExtensionSession, { tokenHash, now })).toMatchObject({ userId, expiresAt: session.expiresAt });
    await expect(t.mutation(internal.access.redeemExtensionPairingCode, { codeHash: pairHash, sessionHash: "b".repeat(64), now })).rejects.toThrow(/already used/);
  });

  it("rejects expired codes and expired or revoked extension sessions", async () => {
    const t = createTest();
    const { userId, identity } = await createApprovedUser(t, ADMIN_EMAIL);
    const { code } = await identity.action(api.access.createExtensionPairingCode, {});
    const codeHash = await hash("extension-pair", code);
    const expiredAt = Date.now() - 1;
    await t.run(async (ctx) => {
      const codeRecord = (await ctx.db.query("extensionPairingCodes").collect()).find((item: Doc<"extensionPairingCodes">) => item.codeHash === codeHash);
      await ctx.db.patch(codeRecord!._id, { expiresAt: expiredAt });
    });
    await expect(t.mutation(internal.access.redeemExtensionPairingCode, { codeHash, sessionHash: "a".repeat(64), now: Date.now() })).rejects.toThrow(/expired/);

    const sessionHash = "c".repeat(64);
    const expiresAt = Date.now() + 1000;
    await t.run(async (ctx) => await ctx.db.insert("extensionSessions", { tokenHash: sessionHash, userId, createdAt: Date.now(), expiresAt }));
    expect(await t.query(internal.access.assertExtensionSession, { tokenHash: sessionHash, now: expiresAt })).toBeNull();
    await t.mutation(internal.access.revokeExtensionSessionByHash, { tokenHash: sessionHash, now: Date.now() });
    expect(await t.query(internal.access.assertExtensionSession, { tokenHash: sessionHash, now: Date.now() })).toBeNull();
  });

  it("rejects pairing and protects session listing from unapproved or foreign users", async () => {
    const t = createTest();
    const { userId, identity } = await createApprovedUser(t, ADMIN_EMAIL);
    const unapprovedId = await t.run(async (ctx) => await ctx.db.insert("users", { email: "pending@example.com", displayName: "Pending", onboardingCompletedAt: Date.now(), emailVerificationTime: Date.now(), isAnonymous: false }));
    const unapproved = t.withIdentity({ subject: `${unapprovedId}|pending`, email: "pending@example.com" });
    await expect(unapproved.action(api.access.createExtensionPairingCode, {})).rejects.toThrow(/not been approved/);

    const sessionId = await t.run(async (ctx) => await ctx.db.insert("extensionSessions", { tokenHash: "d".repeat(64), userId, createdAt: Date.now(), expiresAt: Date.now() + 60_000 }));
    await expect(unapproved.mutation(api.access.revokeExtensionSession, { sessionId })).rejects.toThrow();
    expect((await identity.query(api.access.extensionSessions, {})).some((session) => session.id === sessionId)).toBe(true);
  });

  it("redeems an HTTP pairing code into a server-checked bearer session and supports revocation", async () => {
    const t = createTest();
    const { identity } = await createApprovedUser(t, ADMIN_EMAIL);
    const { code } = await identity.action(api.access.createExtensionPairingCode, {});
    const redeemed = await t.fetch("/extension/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: `chrome-extension://${"a".repeat(32)}` },
      body: JSON.stringify({ code }),
    });
    expect(redeemed.status).toBe(200);
    const credential = await redeemed.json() as { token: string; expiresAt: number; email: string; userId?: string };
    expect(credential.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(credential.email).toBe(ADMIN_EMAIL);
    expect(credential.userId).toBeUndefined();
    expect(credential.expiresAt).toBeLessThanOrEqual(Date.now() + 30 * 24 * 60 * 60 * 1000);

    const status = await t.fetch("/extension/me", { headers: { Authorization: `Bearer ${credential.token}` } });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ email: ADMIN_EMAIL, expiresAt: credential.expiresAt });
    const replay = await t.fetch("/extension/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(replay.status).toBe(401);
    const logout = await t.fetch("/extension/me", { method: "DELETE", headers: { Authorization: `Bearer ${credential.token}` } });
    expect(logout.status).toBe(200);
    const revoked = await t.fetch("/extension/me", { headers: { Authorization: `Bearer ${credential.token}` } });
    expect(revoked.status).toBe(401);
  });

  it("rejects an origin other than a Chrome extension on browser session routes", async () => {
    const t = createTest();
    const response = await t.fetch("/extension/me", { headers: { Origin: "https://attacker.example" } });
    expect(response.status).toBe(403);
  });

  it("purchases Shorts time at the saved rate, extends active time, and settles atomically and idempotently", async () => {
    const t = createTest();
    const { userId, identity } = await createApprovedUser(t, "shorts@example.com");
    await identity.mutation(api.rewards.initialize);
    await identity.mutation(api.rewards.setYouTubePricingRates, { standardCoinsPerMinute: 1.2, shortsCoinsPerMinute: 2.5, flexibleCoinsPerMinute: 1.6 });
    const now = Date.now();
    const tokenHash = "c".repeat(64);
    await t.run(async (ctx) => {
      await ctx.db.insert("extensionSessions", { tokenHash, userId, createdAt: now, expiresAt: now + 60_000 });
      const account = await ctx.db.query("accountData").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
      await ctx.db.patch(account!._id, { coins: 100 });
    });
    const args = { tokenHash, minutes: 5, idempotencyKey: "short-time-key-0001", now };
    const first = await identity.mutation(internal.rewards.purchaseShortsTime, args);
    expect(first).toMatchObject({ success: true, price: 13, expiresAt: now + 5 * 60_000, alreadyProcessed: false });
    const lowBalanceKey = "short-time-poor-0001";
    await t.run(async (ctx) => {
      const account = await ctx.db.query("accountData").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
      await ctx.db.patch(account!._id, { coins: 10 });
    });
    await expect(identity.mutation(internal.rewards.purchaseShortsTime, { ...args, minutes: 30, idempotencyKey: lowBalanceKey, now })).rejects.toThrow(/INSUFFICIENT_COINS/);
    await t.run(async (ctx) => {
      const account = await ctx.db.query("accountData").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
      await ctx.db.patch(account!._id, { coins: 87 });
    });
    const second = await identity.mutation(internal.rewards.purchaseShortsTime, { ...args, minutes: 10, idempotencyKey: "short-time-key-0002", now: now + 1000 });
    expect(second.expiresAt).toBe(first.expiresAt + 10 * 60_000);
    const retry = await identity.mutation(internal.rewards.purchaseShortsTime, args);
    expect(retry).toMatchObject({ success: true, price: 13, expiresAt: first.expiresAt, alreadyProcessed: true });
    expect(await identity.query(internal.rewards.verifyYouTubeEntitlement, { tokenHash, videoId: "abcdefghijk", contentType: "youtube_short", now: second.expiresAt })).toBeNull();
    expect(await identity.query(internal.rewards.verifyYouTubeEntitlement, { tokenHash, videoId: "abcdefghijk", contentType: "youtube_short", now: now + 2 })).toMatchObject({ expiresAt: second.expiresAt });
    expect(await identity.query(api.rewards.snapshot)).toMatchObject({ coins: 62 });
    await expect(identity.mutation(internal.rewards.youtubePurchaseQuote, { tokenHash, videoId: "abcdefghijk", contentType: "youtube_short", durationSeconds: 30, now })).rejects.toThrow(/purchased by time/);
  });

  it("serves authenticated current balances and protects the popup rate editor from conflicts", async () => {
    const t = createTest();
    const { userId, identity } = await createApprovedUser(t, "popup@example.com");
    await identity.mutation(api.rewards.initialize);
    const now = Date.now();
    const token = "popup-extension-token-000000000000000000000000000000000000";
    const tokenHash = await hash("extension-session", token);
    await t.run(async (ctx) => {
      await ctx.db.insert("extensionSessions", { tokenHash, userId, createdAt: now, expiresAt: now + 60_000 });
      const account = await ctx.db.query("accountData").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
      await ctx.db.patch(account!._id, { coins: 42 });
    });
    const auth = { Authorization: `Bearer ${token}` };
    const balance = await t.fetch("/extension/youtube/balance", { headers: auth });
    expect(await balance.json()).toMatchObject({ coins: 42, shortsExpiresAt: null });
    const original = await t.fetch("/extension/youtube/pricing-rates", { headers: auth });
    expect(original.status).toBe(200);
    const saved = await t.fetch("/extension/youtube/pricing-rates", { method: "PUT", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ standardCoinsPerMinute: 2.2, shortsCoinsPerMinute: 3.4, expectedStandard: 1.2, expectedShorts: 1.4 }) });
    expect(saved.status).toBe(200);
    const conflict = await t.fetch("/extension/youtube/pricing-rates", { method: "PUT", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ standardCoinsPerMinute: 1, shortsCoinsPerMinute: 1, expectedStandard: 1.2, expectedShorts: 1.4 }) });
    expect(conflict.status).toBe(409);
    const forged = await t.fetch("/extension/youtube/pricing-rates", { method: "PUT", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ standardCoinsPerMinute: 0, shortsCoinsPerMinute: 1000, expectedStandard: 2.2, expectedShorts: 3.4 }) });
    expect(forged.status).toBe(409);
    expect(await identity.query(api.rewards.youtubePricingRates)).toMatchObject({ standardCoinsPerMinute: 2.2, shortsCoinsPerMinute: 3.4 });
  });

  it("charges the user's saved standard rate atomically and records the applied rate on the entitlement", async () => {
    const t = createTest();
    const { userId, identity } = await createApprovedUser(t, "buyer@example.com");
    await identity.mutation(api.rewards.initialize);
    await identity.mutation(api.rewards.setYouTubePricingRates, { standardCoinsPerMinute: 2, shortsCoinsPerMinute: 3.5, flexibleCoinsPerMinute: 4 });
    await t.run(async (ctx) => {
      const account = (await ctx.db.query("accountData").collect()).find((item: Doc<"accountData">) => item.userId === userId);
      await ctx.db.patch(account!._id, { coins: 100 });
    });
    const now = Date.now();
    const tokenHash = "f".repeat(64);
    await t.run(async (ctx) => await ctx.db.insert("extensionSessions", { tokenHash, userId, createdAt: now, expiresAt: now + 60_000 }));
    const quote = await identity.mutation(internal.rewards.youtubePurchaseQuote, { tokenHash, videoId: "abcdefghijk", contentType: "youtube_video", durationSeconds: 900, now });
    const purchaseArgs = { tokenHash, videoId: "abcdefghijk", contentType: "youtube_video" as const, durationSeconds: 900, idempotencyKey: "purchase-key-0001", quoteId: quote.quoteId, now };
    expect(await identity.mutation(internal.rewards.purchaseYouTubeReward, purchaseArgs)).toMatchObject({ success: true, price: 30, alreadyProcessed: false });
    expect(await identity.mutation(internal.rewards.purchaseYouTubeReward, purchaseArgs)).toMatchObject({ success: true, price: 30, alreadyProcessed: true });
    const state = await t.run(async (ctx) => ({
      account: (await ctx.db.query("accountData").collect()).find((item: Doc<"accountData">) => item.userId === userId),
      purchases: (await ctx.db.query("libraryPurchases").collect()).filter((item: Doc<"libraryPurchases">) => item.userId === userId),
      transactions: (await ctx.db.query("walletTransactions").collect()).filter((item: Doc<"walletTransactions">) => item.userId === userId && item.type === "youtube_purchase"),
    }));
    expect(state.account?.coins).toBe(70);
    expect(state.purchases).toHaveLength(1);
    expect(state.purchases[0]).toMatchObject({ contentType: "youtube_video", contentId: "abcdefghijk", durationSeconds: 900, youtubeRateCoinsPerMinute: 2, cost: 30, transactionId: state.transactions[0]._id });
    expect(state.transactions).toHaveLength(1);
    expect(await identity.query(internal.rewards.verifyYouTubeEntitlement, { tokenHash, videoId: "abcdefghijk", contentType: "youtube_video", now })).toMatchObject({ durationSeconds: 900, expiresAt: now + 18 * 60 * 60 * 1000 });
    expect(await identity.query(internal.rewards.verifyYouTubeEntitlement, { tokenHash, videoId: "abcdefghijk", contentType: "youtube_video", now: now + 18 * 60 * 60 * 1000 })).toBeNull();
    await t.run(async (ctx) => {
      const session = (await ctx.db.query("extensionSessions").withIndex("by_hash", (q) => q.eq("tokenHash", tokenHash)).unique())!;
      await ctx.db.patch(session._id, { expiresAt: now + 60 * 86400000 });
      const account = (await ctx.db.query("accountData").withIndex("by_user", (q) => q.eq("userId", userId)).unique())!;
      await ctx.db.patch(account._id, { coins: 0 });
    });
    const laterQuote = await identity.mutation(internal.rewards.youtubePurchaseQuote, { tokenHash, videoId: "lmnopqrstuv", contentType: "youtube_video", durationSeconds: 900, now: now + 31 * 86400000 });
    await expect(identity.mutation(internal.rewards.purchaseYouTubeReward, { ...purchaseArgs, videoId: "lmnopqrstuv", idempotencyKey: "purchase-key-0002", quoteId: laterQuote.quoteId, now: now + 31 * 86400000 })).rejects.toThrow(/INSUFFICIENT_COINS/);
  });

  it("uses each user's saved rates for server quotes and rejects invalid settings", async () => {
    const t = createTest();
    const { userId, identity } = await createApprovedUser(t, "buyer@example.com");
    const now = Date.now();
    const tokenHash = "8".repeat(64);
    await t.run(async (ctx) => await ctx.db.insert("extensionSessions", { tokenHash, userId, createdAt: now, expiresAt: now + 60_000 }));
    await expect(identity.query(api.rewards.youtubePricingRates, {})).resolves.toEqual({ standardCoinsPerMinute: 1.2, shortsCoinsPerMinute: 1.4, flexibleCoinsPerMinute: 1.6 });
    await identity.mutation(api.rewards.setYouTubePricingRates, { standardCoinsPerMinute: 1.25, shortsCoinsPerMinute: 2.5, flexibleCoinsPerMinute: 1.6 });
    const standardQuote = await identity.mutation(internal.rewards.youtubePurchaseQuote, { tokenHash, videoId: "abcdefghijk", contentType: "youtube_video", durationSeconds: 900, now });
    expect(standardQuote).toMatchObject({ price: 19, rateCoinsPerMinute: 1.25, entitlementHours: 18 });
    await identity.mutation(api.rewards.initialize);
    await t.run(async (ctx) => {
      const account = await ctx.db.query("accountData").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
      await ctx.db.patch(account!._id, { coins: 50 });
    });
    await identity.mutation(api.rewards.setYouTubePricingRates, { standardCoinsPerMinute: 10, shortsCoinsPerMinute: 2.5, flexibleCoinsPerMinute: 1.6 });
    const lockedPurchase = await identity.mutation(internal.rewards.purchaseYouTubeReward, {
      tokenHash, videoId: "abcdefghijk", contentType: "youtube_video", durationSeconds: 900,
      idempotencyKey: "locked-quote-000001", quoteId: standardQuote.quoteId, now,
    });
    expect(lockedPurchase).toMatchObject({ success: true, price: 19 });
    await expect(identity.mutation(internal.rewards.youtubePurchaseQuote, { tokenHash, videoId: "lmnopqrstuv", contentType: "youtube_short", durationSeconds: 900, now })).rejects.toThrow(/purchased by time/);
    const shortsQuote = await identity.mutation(internal.rewards.youtubePurchaseQuote, { tokenHash, videoId: "lmnopqrstuv", contentType: "youtube_video", durationSeconds: 900, now });
    expect(shortsQuote).toMatchObject({ price: 150, rateCoinsPerMinute: 10 });
    await expect(identity.query(internal.rewards.extensionYouTubePricingRates, { tokenHash, now })).resolves.toEqual({ standardCoinsPerMinute: 10, shortsCoinsPerMinute: 2.5, flexibleCoinsPerMinute: 1.6 });
    await expect(identity.mutation(internal.rewards.youtubePurchaseQuote, { tokenHash, videoId: "invalid", contentType: "youtube_video", durationSeconds: 900, now })).rejects.toThrow(/Invalid YouTube/);
    await expect(identity.mutation(api.rewards.setYouTubePricingRates, { standardCoinsPerMinute: 0, shortsCoinsPerMinute: 1, flexibleCoinsPerMinute: 1 })).rejects.toThrow(/rate must be greater than 0/i);
    await expect(identity.mutation(api.rewards.setYouTubePricingRates, { standardCoinsPerMinute: 101, shortsCoinsPerMinute: 1, flexibleCoinsPerMinute: 1 })).rejects.toThrow(/rate must be greater than 0/i);
    await expect(identity.mutation(api.rewards.setYouTubePricingRates, { standardCoinsPerMinute: 1.001, shortsCoinsPerMinute: 1, flexibleCoinsPerMinute: 1 })).rejects.toThrow(/rate must be greater than 0/i);
    await expect(identity.mutation(api.rewards.setYouTubePricingRates, { standardCoinsPerMinute: Number.NaN, shortsCoinsPerMinute: 1, flexibleCoinsPerMinute: 1 })).rejects.toThrow(/rate must be greater than 0/i);
    await expect(identity.mutation(api.rewards.setYouTubePricingRates, { standardCoinsPerMinute: Number.POSITIVE_INFINITY, shortsCoinsPerMinute: 1, flexibleCoinsPerMinute: 1 })).rejects.toThrow(/rate must be greater than 0/i);
  });

  it("does not accept client-chosen user identities or expired and revoked sessions for purchases", async () => {
    const t = createTest();
    const { userId, identity } = await createApprovedUser(t, "buyer@example.com");
    await identity.mutation(api.rewards.initialize);
    const now = Date.now();
    const validHash = "1".repeat(64);
    const expiredHash = "2".repeat(64);
    const revokedHash = "3".repeat(64);
    await t.run(async (ctx) => {
      await ctx.db.insert("extensionSessions", { tokenHash: validHash, userId, createdAt: now, expiresAt: now + 60_000 });
      await ctx.db.insert("extensionSessions", { tokenHash: expiredHash, userId, createdAt: now - 100_000, expiresAt: now - 1 });
      await ctx.db.insert("extensionSessions", { tokenHash: revokedHash, userId, createdAt: now, expiresAt: now + 60_000, revokedAt: now });
      const account = (await ctx.db.query("accountData").collect()).find((item: Doc<"accountData">) => item.userId === userId);
      await ctx.db.patch(account!._id, { coins: 100 });
    });
    const args = { videoId: "abcdefghijk", contentType: "youtube_video" as const, durationSeconds: 30, idempotencyKey: "short-key-000001", now };
    const quote = await identity.mutation(internal.rewards.youtubePurchaseQuote, { tokenHash: validHash, videoId: args.videoId, contentType: args.contentType, durationSeconds: args.durationSeconds, now });
    await expect(identity.mutation(internal.rewards.purchaseYouTubeReward, { ...args, tokenHash: "4".repeat(64), quoteId: quote.quoteId })).rejects.toThrow(/expired or revoked/);
    await expect(identity.mutation(internal.rewards.purchaseYouTubeReward, { ...args, tokenHash: expiredHash, quoteId: quote.quoteId })).rejects.toThrow(/expired or revoked/);
    await expect(identity.mutation(internal.rewards.purchaseYouTubeReward, { ...args, tokenHash: revokedHash, quoteId: quote.quoteId })).rejects.toThrow(/expired or revoked/);
    await expect(identity.mutation(internal.rewards.purchaseYouTubeReward, { ...args, tokenHash: validHash, quoteId: quote.quoteId, durationSeconds: 6 * 60 * 60 + 1 })).rejects.toThrow(/Invalid YouTube/);
    await expect(identity.mutation(internal.rewards.purchaseYouTubeReward, { ...args, tokenHash: validHash, contentType: "youtube_short", quoteId: quote.quoteId })).rejects.toThrow(/Shorts use time-based access/);
    await t.run(async (ctx) => {
      const account = (await ctx.db.query("accountData").withIndex("by_user", (q) => q.eq("userId", userId)).unique())!;
      await ctx.db.patch(account._id, { coins: 0 });
    });
    await expect(identity.mutation(internal.rewards.purchaseShortsTime, { tokenHash: validHash, minutes: 5, idempotencyKey: "short-key-000002", now })).rejects.toThrow(/INSUFFICIENT_COINS/);
    await t.run(async (ctx) => {
      const account = (await ctx.db.query("accountData").withIndex("by_user", (q) => q.eq("userId", userId)).unique())!;
      await ctx.db.patch(account._id, { coins: 100 });
    });
    const shortPurchase = await identity.mutation(internal.rewards.purchaseShortsTime, { tokenHash: validHash, minutes: 5, idempotencyKey: "short-key-000003", now });
    expect(shortPurchase).toMatchObject({ success: true, price: 7 });
    expect(await identity.query(internal.rewards.verifyYouTubeEntitlement, { tokenHash: validHash, videoId: "abcdefghijk", contentType: "youtube_short", now })).toMatchObject({ expiresAt: now + 5 * 60_000, durationSeconds: null });
  });

  it("charges only the authenticated extension session through the HTTP API and verifies Shorts entitlements", async () => {
    const t = createTest();
    const { userId, identity } = await createApprovedUser(t, "buyer@example.com");
    const otherId = await t.run(async (ctx) => await ctx.db.insert("users", { email: "other@example.com", displayName: "Other", onboardingCompletedAt: Date.now(), isAnonymous: false }));
    await identity.mutation(api.rewards.initialize);
    const now = Date.now();
    const token = "http-session-token-000000000000000000000000000000000000";
    const tokenHash = await hash("extension-session", token);
    await t.run(async (ctx) => {
      await ctx.db.insert("extensionSessions", { tokenHash, userId, createdAt: now, expiresAt: now + 60_000 });
      const account = (await ctx.db.query("accountData").collect()).find((item: Doc<"accountData">) => item.userId === userId);
      await ctx.db.patch(account!._id, { coins: 100 });
    });
    await identity.mutation(api.rewards.setYouTubePricingRates, { standardCoinsPerMinute: 1.2, shortsCoinsPerMinute: 4, flexibleCoinsPerMinute: 1.6 });
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const ratesResponse = await t.fetch("/extension/youtube/pricing-rates", { headers });
    expect(ratesResponse.status).toBe(200);
    expect(await ratesResponse.json()).toEqual({ standardCoinsPerMinute: 1.2, shortsCoinsPerMinute: 4, flexibleCoinsPerMinute: 1.6, flexibleUsageEnabled: false });
    const deniedShortQuote = await t.fetch("/extension/youtube/quote", { method: "POST", headers, body: JSON.stringify({ videoId: "abcdefghijk", contentType: "youtube_short", durationSeconds: 30 }) });
    expect(deniedShortQuote.status).toBe(400);
    const quoteResponse = await t.fetch("/extension/youtube/quote", { method: "POST", headers, body: JSON.stringify({
      videoId: "abcdefghijk", contentType: "youtube_video", durationSeconds: 900,
      price: 0, rateCoinsPerMinute: 0.01, flexibleCoinsPerMinute: 100,
    }) });
    expect(quoteResponse.status).toBe(200);
    const quote = await quoteResponse.json() as { quoteId: string; price: number };
    expect(quote.price).toBe(18);
    const requestBody = {
      videoId: "abcdefghijk", contentType: "youtube_video", durationSeconds: 900,
      idempotencyKey: "http-purchase-key-01", quoteId: quote.quoteId, userId: otherId, price: 1, cost: 1,
    };
    const response = await t.fetch("/extension/youtube/purchase", { method: "POST", headers, body: JSON.stringify(requestBody) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, price: 18, alreadyProcessed: false });
    const retry = await t.fetch("/extension/youtube/purchase", { method: "POST", headers, body: JSON.stringify(requestBody) });
    expect(await retry.json()).toMatchObject({ success: true, price: 18, alreadyProcessed: true });
    const shortsRequest = { minutes: 5, idempotencyKey: "http-shorts-time-01" };
    const shortsPurchase = await t.fetch("/extension/youtube/shorts-time", { method: "POST", headers, body: JSON.stringify(shortsRequest) });
    expect(shortsPurchase.status).toBe(200);
    expect(await shortsPurchase.json()).toMatchObject({ success: true, price: 20, expiresAt: expect.any(Number) });
    const shortsRetry = await t.fetch("/extension/youtube/shorts-time", { method: "POST", headers, body: JSON.stringify(shortsRequest) });
    expect(await shortsRetry.json()).toMatchObject({ success: true, price: 20, alreadyProcessed: true });
    const entitlement = await t.fetch("/extension/youtube/entitlement?videoId=lmnopqrstuv&contentType=youtube_short", { headers });
    expect(entitlement.status).toBe(200);
    expect(await entitlement.json()).toMatchObject({ unlocked: true, durationSeconds: null });
    const state = await t.run(async (ctx) => ({
      account: (await ctx.db.query("accountData").collect()).find((item: Doc<"accountData">) => item.userId === userId),
      other: (await ctx.db.query("accountData").collect()).find((item: Doc<"accountData">) => item.userId === otherId),
      transactions: (await ctx.db.query("walletTransactions").collect()).filter((item: Doc<"walletTransactions">) => item.userId === userId),
    }));
    expect(state.account?.coins).toBe(62);
    expect(state.other).toBeUndefined();
    expect(state.transactions).toHaveLength(2);
    const noSession = await t.fetch("/extension/youtube/purchase", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestBody) });
    expect(noSession.status).toBe(401);
  });

  it("rejects concurrent purchases that exceed the shared wallet balance", async () => {
    const t = createTest();
    const { userId, identity } = await createApprovedUser(t, "buyer@example.com");
    await identity.mutation(api.rewards.initialize);
    const now = Date.now();
    const tokenHash = "7".repeat(64);
    await t.run(async (ctx) => {
      await ctx.db.insert("extensionSessions", { tokenHash, userId, createdAt: now, expiresAt: now + 60_000 });
      const account = (await ctx.db.query("accountData").collect()).find((item: Doc<"accountData">) => item.userId === userId);
      await ctx.db.patch(account!._id, { coins: 50 });
    });
    await identity.mutation(api.rewards.setYouTubePricingRates, { standardCoinsPerMinute: 36, shortsCoinsPerMinute: 1.4, flexibleCoinsPerMinute: 1.6 });
    const base = { tokenHash, contentType: "youtube_video" as const, durationSeconds: 60, now };
    const [quoteA, quoteB] = await Promise.all([
      identity.mutation(internal.rewards.youtubePurchaseQuote, { ...base, videoId: "abcdefghijk" }),
      identity.mutation(internal.rewards.youtubePurchaseQuote, { ...base, videoId: "lmnopqrstuv" }),
    ]);
    const results = await Promise.allSettled([
      identity.mutation(internal.rewards.purchaseYouTubeReward, { ...base, videoId: "abcdefghijk", idempotencyKey: "concurrent-key-0001", quoteId: quoteA.quoteId }),
      identity.mutation(internal.rewards.purchaseYouTubeReward, { ...base, videoId: "lmnopqrstuv", idempotencyKey: "concurrent-key-0002", quoteId: quoteB.quoteId }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const snapshot = await identity.query(api.rewards.snapshot);
    expect(snapshot.coins).toBe(14);
    expect(snapshot.transactions.filter((transaction) => transaction.type === "youtube_purchase")).toHaveLength(1);
  });

  it("does not charge for a valid existing entitlement and reports insufficient funds without writes", async () => {
    const t = createTest();
    const { userId, identity } = await createApprovedUser(t, "buyer@example.com");
    await identity.mutation(api.rewards.initialize);
    const now = Date.now();
    const tokenHash = "5".repeat(64);
    await t.run(async (ctx) => {
      await ctx.db.insert("extensionSessions", { tokenHash, userId, createdAt: now, expiresAt: now + 60_000 });
      await ctx.db.insert("libraryPurchases", {
        userId, rewardId: "previous-youtube", cost: 36, purchasedAt: now - 1000, idempotencyKey: "old-purchase",
        contentType: "youtube_video", contentId: "abcdefghijk", durationSeconds: 120, entitlementDays: 30,
        expiresAt: now + 100_000, transactionId: await ctx.db.insert("walletTransactions", {
          userId, amount: -36, type: "youtube_purchase", description: "Existing", referenceId: "abcdefghijk", idempotencyKey: "old-purchase", createdAt: now - 1000,
        }),
      });
    });
    const alreadyOwnedQuote = await identity.mutation(internal.rewards.youtubePurchaseQuote, { tokenHash, videoId: "abcdefghijk", contentType: "youtube_video", durationSeconds: 120, now });
    const alreadyOwned = await identity.mutation(internal.rewards.purchaseYouTubeReward, {
      tokenHash, videoId: "abcdefghijk", contentType: "youtube_video", durationSeconds: 120, idempotencyKey: "new-key-00000001", quoteId: alreadyOwnedQuote.quoteId, now,
    });
    expect(alreadyOwned).toMatchObject({ success: true, alreadyOwned: true });
    const poorQuote = await identity.mutation(internal.rewards.youtubePurchaseQuote, { tokenHash, videoId: "lmnopqrstuv", contentType: "youtube_video", durationSeconds: 120, now });
    await expect(identity.mutation(internal.rewards.purchaseYouTubeReward, {
      tokenHash, videoId: "lmnopqrstuv", contentType: "youtube_video", durationSeconds: 120, idempotencyKey: "poor-key-0000001", quoteId: poorQuote.quoteId, now,
    })).rejects.toThrow(/INSUFFICIENT_COINS/);
    const transactions = await t.run(async (ctx) => await ctx.db.query("walletTransactions").collect());
    expect(transactions).toHaveLength(1);
  });

  it("allows a confirmed transaction to be recovered after its display quote expires", async () => {
    const t = createTest();
    const { userId, identity } = await createApprovedUser(t, "retry-after-expiry@example.com");
    await identity.mutation(api.rewards.initialize);
    const now = Date.now();
    const tokenHash = "9".repeat(64);
    await t.run(async (ctx) => {
      await ctx.db.insert("extensionSessions", { tokenHash, userId, createdAt: now, expiresAt: now + 60 * 60_000 });
      const account = (await ctx.db.query("accountData").withIndex("by_user", (q) => q.eq("userId", userId)).unique())!;
      await ctx.db.patch(account._id, { coins: 10 });
    });
    const quote = await identity.mutation(internal.rewards.youtubePurchaseQuote, { tokenHash, videoId: "abcdefghijk", contentType: "youtube_video", durationSeconds: 60, now });
    const first = await identity.mutation(internal.rewards.purchaseYouTubeReward, {
      tokenHash, videoId: "abcdefghijk", contentType: "youtube_video", durationSeconds: 60,
      idempotencyKey: "recovery-expiry-key-01", quoteId: quote.quoteId, now,
    });
    expect(first).toMatchObject({ success: true, price: 2 });
    const retry = await identity.mutation(internal.rewards.purchaseYouTubeReward, {
      tokenHash, videoId: "abcdefghijk", contentType: "youtube_video", durationSeconds: 60,
      idempotencyKey: "recovery-expiry-key-01", quoteId: quote.quoteId, now: now + 6 * 60_000,
    });
    expect(retry).toMatchObject({ success: true, alreadyProcessed: true, price: 2, expiresAt: now + 18 * 60 * 60_000 });
    expect(await identity.query(api.rewards.snapshot)).toMatchObject({ coins: 8 });
  });

  it("rejects network failures without claiming success and allows retries with the same idempotency key", async () => {
    const t = createTest();
    const { userId, identity } = await createApprovedUser(t, "buyer@example.com");
    await identity.mutation(api.rewards.initialize);
    const now = Date.now();
    const tokenHash = "6".repeat(64);
    await t.run(async (ctx) => {
      await ctx.db.insert("extensionSessions", { tokenHash, userId, createdAt: now, expiresAt: now + 60_000 });
      const account = (await ctx.db.query("accountData").collect()).find((item: Doc<"accountData">) => item.userId === userId);
      await ctx.db.patch(account!._id, { coins: 36 });
    });
    await identity.mutation(api.rewards.setYouTubePricingRates, { standardCoinsPerMinute: 36, shortsCoinsPerMinute: 1.4, flexibleCoinsPerMinute: 1.6 });
    const quote = await identity.mutation(internal.rewards.youtubePurchaseQuote, { tokenHash, videoId: "abcdefghijk", contentType: "youtube_video", durationSeconds: 60, now });
    const args = { tokenHash, videoId: "abcdefghijk", contentType: "youtube_video" as const, durationSeconds: 60, idempotencyKey: "retry-key-0000001", quoteId: quote.quoteId, now };
    const first = await identity.mutation(internal.rewards.purchaseYouTubeReward, args);
    const retry = await identity.mutation(internal.rewards.purchaseYouTubeReward, args);
    expect(first.success && retry.success).toBe(true);
    const transactions = await t.run(async (ctx) => await ctx.db.query("walletTransactions").collect());
    expect(transactions).toHaveLength(1);
    expect(transactions[0].amount).toBe(-36);
  });

  it("revokes every extension session when beta approval is revoked", async () => {
    const t = createTest();
    const admin = await createApprovedUser(t, ADMIN_EMAIL);
    const userId = await t.run(async (ctx) => await ctx.db.insert("users", { email: "friend@example.com", displayName: "Friend", onboardingCompletedAt: Date.now(), emailVerificationTime: Date.now(), isAnonymous: false }));
    const friend = t.withIdentity({ subject: `${userId}|friend`, email: "friend@example.com" });
    await t.run(async (ctx) => {
      await ctx.db.insert("betaAccess", { userId, status: "approved", requestedAt: Date.now(), updatedAt: Date.now() });
      await ctx.db.insert("extensionSessions", { tokenHash: "e".repeat(64), userId, createdAt: Date.now(), expiresAt: Date.now() + 60_000 });
    });
    await admin.identity.mutation(api.access.revokeUser, { userId });
    expect(await t.query(internal.access.assertExtensionSession, { tokenHash: "e".repeat(64), now: Date.now() })).toBeNull();
    await expect(friend.query(api.access.extensionSessions, {})).rejects.toThrow(/not been approved/);
  });
});