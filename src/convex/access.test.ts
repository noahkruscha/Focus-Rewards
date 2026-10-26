import { convexTest } from "convex-test";
import type { TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";

const modules = {
  "./_generated/api.js": () => import("./_generated/api.js"),
  "./_generated/server.js": () => import("./_generated/server.js"),
  "./access.ts": () => import("./access"),
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

async function createUser(t: ReturnType<typeof createTest>, email: string) {
  return await t.run(async (ctx) => await ctx.db.insert("users", {
    email,
    emailVerificationTime: Date.now(),
    isAnonymous: false,
  }));
}

async function makeAdmin(t: ReturnType<typeof createTest>) {
  const adminId = await createUser(t, ADMIN_EMAIL);
  const admin = t.withIdentity({ subject: `${adminId}|session-admin`, email: ADMIN_EMAIL });
  await admin.mutation(api.access._grantInitialAdministrator);
  return { adminId, admin };
}

describe("private beta access", () => {
  it("preserves the existing administrator account and existing reward data during bootstrap", async () => {
    const t = createTest();
    const adminId = await createUser(t, ADMIN_EMAIL);
    await t.run(async (ctx) => {
      await ctx.db.insert("accountData", { userId: adminId, coins: 47, dailyCap: 99, taskBonus: 8 });
      await ctx.db.insert("tasks", { userId: adminId, title: "Existing", completed: false, completedAt: null, rewardCoins: 3 });
    });
    const existingIdentity = t.withIdentity({ subject: `${adminId}|existing-session`, email: ADMIN_EMAIL });
    expect((await existingIdentity.query(api.users.currentUser))?._id).toBe(adminId);
    await existingIdentity.mutation(api.access._grantInitialAdministrator);
    const { user, account, tasks } = await t.run(async (ctx) => ({
      user: await ctx.db.get(adminId),
      account: (await ctx.db.query("accountData").collect()).find((item: Doc<"accountData">) => item.userId === adminId),
      tasks: (await ctx.db.query("tasks").collect()).filter((item: Doc<"tasks">) => item.userId === adminId),
    }));
    expect(user?.role).toBe("admin");
    await expect(t.withIdentity({ subject: `${adminId}|existing-session`, email: ADMIN_EMAIL }).mutation(api.access._grantInitialAdministrator)).rejects.toThrow(/already been configured/);
    expect(account?.coins).toBe(47);
    expect(tasks).toHaveLength(1);
  });

  it("does not allow an unsigned, unverified, or differently authenticated account to bootstrap the administrator", async () => {
    const t = createTest();
    await expect(t.mutation(api.access._grantInitialAdministrator)).rejects.toThrow();
    const otherId = await createUser(t, "other@example.com");
    await expect(t.withIdentity({ subject: `${otherId}|s`, email: "other@example.com" }).mutation(api.access._grantInitialAdministrator)).rejects.toThrow();
    const unverifiedId = await t.run(async (ctx) => await ctx.db.insert("users", { email: ADMIN_EMAIL, isAnonymous: false }));
    const unverified = t.withIdentity({ subject: `${unverifiedId}|s`, email: ADMIN_EMAIL });
    await expect(unverified.query(api.users.currentUser)).rejects.toThrow(/not been approved/);
    await expect(unverified.mutation(api.access._grantInitialAdministrator)).rejects.toThrow(/verified-email/);
  });

  it("blocks unapproved users from protected rewards APIs and rejects identity overrides", async () => {
    const t = createTest();
    const { adminId, admin } = await makeAdmin(t);
    const memberId = await createUser(t, "friend@example.com");
    const member = t.withIdentity({ subject: `${memberId}|friend-session`, email: "friend@example.com" });
    await expect(member.query(api.users.currentUser)).rejects.toThrow(/not been approved/);
    await expect(member.query(api.rewards.snapshot)).rejects.toThrow(/not been approved/);
    await expect(member.mutation(api.rewards.initialize)).rejects.toThrow(/not been approved/);
    await expect(member.mutation(api.access.approveUser, { userId: adminId })).rejects.toThrow();
    await expect(member.mutation(api.access._grantInitialAdministrator)).rejects.toThrow();
    await expect(t.mutation(api.access._grantInitialAdministrator)).rejects.toThrow();
    expect((await admin.query(api.access.status)).administrator).toBe(true);
  });

  it("creates recipient-bound hashed invitations, approves only the verified invited account, and rejects reuse", async () => {
    const t = createTest();
    const { admin } = await makeAdmin(t);
    const { code } = await admin.action(api.access.createInvitation, { recipientEmail: "Friend@Example.com" });
    expect(code).toHaveLength(32);
    const stored = await t.run(async (ctx) => await ctx.db.query("betaInvitations").collect());
    expect(stored).toHaveLength(1);
    expect(stored[0].codeHash).not.toBe(code);
    expect(stored[0].recipientEmail).toBe("friend@example.com");
    const wrongId = await createUser(t, "not-friend@example.com");
    const wrong = t.withIdentity({ subject: `${wrongId}|s`, email: "not-friend@example.com" });
    await expect(wrong.mutation(api.access.claimInvitation, { code })).rejects.toThrow(/different verified email/);
    const friendId = await createUser(t, "friend@example.com");
    const friend = t.withIdentity({ subject: `${friendId}|s`, email: "friend@example.com" });
    await friend.mutation(api.access.claimInvitation, { code });
    await expect(friend.mutation(api.access.claimInvitation, { code })).rejects.toThrow(/invalid, expired, revoked, or already used/);
    expect((await friend.query(api.rewards.snapshot)).initialized).toBe(false);
    const invitations = await t.run(async (ctx) => await ctx.db.query("betaInvitations").collect());
    expect(invitations[0].usedAt).toBeDefined();
    expect(invitations[0].claimedBy).toBe(friendId);
  });

  it("rejects unauthenticated claims and invitation creation, while a normal user cannot mint invitations", async () => {
    const t = createTest();
    await expect(t.mutation(api.access.claimInvitation, { code: "A".repeat(32) })).rejects.toThrow(/Sign in/);
    await expect(t.action(api.access.createInvitation, { recipientEmail: "friend@example.com" })).rejects.toThrow();
    const userId = await createUser(t, "user@example.com");
    const user = t.withIdentity({ subject: `${userId}|s`, email: "user@example.com" });
    await expect(user.action(api.access.createInvitation, { recipientEmail: "friend@example.com" })).rejects.toThrow();
    await expect(user.mutation(api.access.approveUser, { userId })).rejects.toThrow();
  });

  it("rejects expired and revoked invitation codes", async () => {
    const t = createTest();
    const { admin } = await makeAdmin(t);
    const recipientId = await createUser(t, "friend@example.com");
    const friend = t.withIdentity({ subject: `${recipientId}|s`, email: "friend@example.com" });
    const expiredCode = "A".repeat(32);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`focus-rewards-beta-invite:v1:${expiredCode}`));
    const expiredHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    await t.run(async (ctx) => {
      const adminUser = await ctx.db.query("users").filter((q) => q.eq(q.field("email"), ADMIN_EMAIL)).unique();
      await ctx.db.insert("betaInvitations", { codeHash: expiredHash, recipientEmail: "friend@example.com", createdBy: adminUser!._id, createdAt: Date.now() - 100, expiresAt: Date.now() - 1 });
    });
    await expect(friend.mutation(api.access.claimInvitation, { code: expiredCode })).rejects.toThrow(/invalid, expired, revoked, or already used/);
    const { code } = await admin.action(api.access.createInvitation, { recipientEmail: "friend@example.com" });
    const generatedHashDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`focus-rewards-beta-invite:v1:${code}`));
    const generatedHash = Array.from(new Uint8Array(generatedHashDigest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const overview = await admin.query(api.access.adminOverview);
    const invitation = overview.invitations.find((item: { id: string; recipientEmail: string; used: boolean; revoked: boolean }) => item.recipientEmail === "friend@example.com" && !item.used && !item.revoked && !overview.invitations.some((other: { id: string; used: boolean }) => other.id !== item.id && other.used));
    expect(invitation).toBeDefined();
    const matchingInvitation = await t.run(async (ctx) => (await ctx.db.query("betaInvitations").collect()).find((item: Doc<"betaInvitations">) => item.codeHash === generatedHash));
    expect(matchingInvitation).toBeDefined();
    await admin.mutation(api.access.revokeInvitation, { invitationId: matchingInvitation!._id });
    const afterRevoke = await admin.query(api.access.adminOverview);
    expect(afterRevoke.invitations.find((item: { id: string }) => item.id === matchingInvitation!._id)?.revoked).toBe(true);
    await expect(friend.mutation(api.access.claimInvitation, { code })).rejects.toThrow(/invalid, expired, revoked, or already used/);
  });

  it("allows admin approvals, enforces per-user data isolation, ignores spoofed user IDs, and revokes immediately", async () => {
    const t = createTest();
    const { adminId, admin } = await makeAdmin(t);
    const firstId = await createUser(t, "first@example.com");
    const secondId = await createUser(t, "second@example.com");
    const first = t.withIdentity({ subject: `${firstId}|s1`, email: "first@example.com" });
    const second = t.withIdentity({ subject: `${secondId}|s2`, email: "second@example.com" });
    await admin.mutation(api.access.approveUser, { userId: firstId });
    await admin.mutation(api.access.approveUser, { userId: secondId });
    await first.mutation(api.rewards.initialize);
    await second.mutation(api.rewards.initialize);
    await first.mutation(api.rewards.createTask, { title: "Private task", rewardCoins: 3, idempotencyKey: "create-1" });
    expect((await second.query(api.rewards.snapshot)).tasks).toHaveLength(0);
    await expect(first.mutation(api.access.approveUser, { userId: secondId })).rejects.toThrow();
    await admin.mutation(api.access.revokeUser, { userId: firstId });
    await expect(first.query(api.rewards.snapshot)).rejects.toThrow(/not been approved/);
    await expect(admin.mutation(api.access.revokeUser, { userId: adminId })).rejects.toThrow(/different administrator account/);
    expect((await second.query(api.rewards.snapshot)).initialized).toBe(true);
    await t.run(async (ctx) => {
      const account = (await ctx.db.query("accountData").collect()).find((item: Doc<"accountData">) => item.userId === firstId);
      expect(account).toBeDefined();
      expect((await ctx.db.query("tasks").collect()).filter((item: Doc<"tasks">) => item.userId === firstId)).toHaveLength(1);
    });
  });

  it("allows only one account to claim a single-use invitation", async () => {
    const t = createTest();
    const { admin } = await makeAdmin(t);
    const { code } = await admin.action(api.access.createInvitation, { recipientEmail: "friend@example.com" });
    const firstId = await createUser(t, "friend@example.com");
    const secondId = await createUser(t, "friend@example.com");
    const first = t.withIdentity({ subject: `${firstId}|first`, email: "friend@example.com" });
    const second = t.withIdentity({ subject: `${secondId}|second`, email: "friend@example.com" });
    await first.mutation(api.access.claimInvitation, { code });
    await expect(second.mutation(api.access.claimInvitation, { code })).rejects.toThrow(/invalid, expired, revoked, or already used/);
    const accessRecords = await t.run(async (ctx) => await ctx.db.query("betaAccess").collect());
    expect(accessRecords.filter((record) => record.status === "approved")).toHaveLength(2);
  });

  it("rejects tampered prices and charges only once for duplicate concurrent purchases", async () => {
    const t = createTest();
    const { admin } = await makeAdmin(t);
    const userId = await createUser(t, "buyer@example.com");
    const buyer = t.withIdentity({ subject: `${userId}|buyer-session`, email: "buyer@example.com" });
    await admin.mutation(api.access.approveUser, { userId });
    await buyer.mutation(api.rewards.initialize);
    await t.run(async (ctx) => {
      const account = (await ctx.db.query("accountData").collect()).find((item: Doc<"accountData">) => item.userId === userId);
      await ctx.db.patch(account!._id, { coins: 50 });
    });
    await expect(buyer.mutation(api.rewards.purchaseReward, { rewardId: "quiet-morning", cost: 1, idempotencyKey: "tampered" })).rejects.toThrow(/Unknown reward or price changed/);
    const purchases = await Promise.all([
      buyer.mutation(api.rewards.purchaseReward, { rewardId: "quiet-morning", cost: 24, idempotencyKey: "purchase-a" }),
      buyer.mutation(api.rewards.purchaseReward, { rewardId: "quiet-morning", cost: 24, idempotencyKey: "purchase-b" }),
    ]);
    expect(purchases.filter((purchase) => !purchase.alreadyPurchased)).toHaveLength(1);
    const snapshot = await buyer.query(api.rewards.snapshot);
    expect(snapshot.coins).toBe(26);
    expect(snapshot.videoUnlocks.filter((purchase) => purchase.videoId === "quiet-morning")).toHaveLength(1);
    expect(snapshot.transactions.filter((transaction) => transaction.type === "library_purchase")).toHaveLength(1);
  });

  it("uses Web Crypto to generate independent invitation codes", async () => {
    const t = createTest();
    const { admin } = await makeAdmin(t);
    const [first, second] = await Promise.all([
      admin.action(api.access.createInvitation, { recipientEmail: "friend@example.com" }),
      admin.action(api.access.createInvitation, { recipientEmail: "friend@example.com" }),
    ]);
    expect(first.code).not.toBe(second.code);
    expect(first.expiresAt).toBeGreaterThan(Date.now());
    expect((await admin.query(api.access.adminOverview)).invitations).toHaveLength(2);
  });
});
