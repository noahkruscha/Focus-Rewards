import { convexTest } from "convex-test";
import type { TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { resolveBetaGateView, resolveOnboardingDisplayName } from "../components/betaGateView";
import type { Doc } from "./_generated/dataModel";

const modules = {
  "./_generated/api.js": () => import("./_generated/api.js"),
  "./_generated/server.js": () => import("./_generated/server.js"),
  "./access.ts": () => import("./access"),
  "./rewards.ts": () => import("./rewards"),
  "./http.ts": () => import("./http"),
  "./users.ts": () => import("./users"),
};
const ADMIN_EMAIL = "owner@example.com";

function createTest() {
  process.env.BETA_REQUIRE_APPROVAL = "true";
  process.env.BETA_INVITATIONS_ENABLED = "true";
  process.env.BETA_ADMIN_EMAIL = ADMIN_EMAIL;
  return convexTest(schema, modules as never) as TestConvex<typeof schema>;
}

async function createUser(t: ReturnType<typeof createTest>, email: string, displayName = "Beta member") {
  return await t.run(async (ctx) => await ctx.db.insert("users", {
    email,
    displayName,
    ...(displayName.trim() ? { onboardingCompletedAt: Date.now() } : {}),
    emailVerificationTime: Date.now(),
    isAnonymous: false,
  }));
}

async function makeAdmin(t: ReturnType<typeof createTest>) {
  const adminId = await t.run(async (ctx) => await ctx.db.insert("users", {
    email: ADMIN_EMAIL,
    displayName: "Owner",
    onboardingCompletedAt: Date.now(),
    emailVerificationTime: Date.now(),
    isAnonymous: false,
  }));
  const admin = t.withIdentity({ subject: `${adminId}|session-admin`, email: ADMIN_EMAIL });
  await admin.mutation(api.access._grantInitialAdministrator);
  return { adminId, admin };
}

describe("private beta access", () => {
  it("shows onboarding to an approved account without a profile instead of the approval-waiting screen", () => {
    expect(resolveBetaGateView(true, {
      approvalRequired: true,
      approved: true,
      onboardingComplete: false,
      administrator: false,
      canClaimInitialAdministrator: false,
    }, "/dashboard")).toBe("onboarding");
    expect(resolveBetaGateView(true, {
      approvalRequired: true,
      approved: false,
      onboardingComplete: false,
      administrator: false,
      canClaimInitialAdministrator: false,
    }, "/dashboard")).toBe("approval");
    expect(resolveBetaGateView(true, {
      approvalRequired: true,
      approved: true,
      onboardingComplete: false,
      administrator: true,
      canClaimInitialAdministrator: false,
    }, "/admin")).toBe("content");
    expect(resolveBetaGateView(true, {
      approvalRequired: true,
      approved: false,
      onboardingComplete: true,
      administrator: false,
      canClaimInitialAdministrator: true,
    }, "/dashboard")).toBe("administrator-bootstrap");
  });

  it("prefills onboarding from a saved beta-request name while allowing edits and legacy fallbacks", () => {
    expect(resolveOnboardingDisplayName("  Jamie  ", undefined, undefined, false, "")).toBe("  Jamie  ");
    expect(resolveOnboardingDisplayName(null, "Profile Name", undefined, false, "")).toBe("Profile Name");
    expect(resolveOnboardingDisplayName(null, null, "Legacy Name", false, "")).toBe("Legacy Name");
    expect(resolveOnboardingDisplayName("Jamie", undefined, undefined, true, "Jordan")).toBe("Jordan");
    expect(resolveOnboardingDisplayName(null, null, null, false, "")).toBe("");
  });

  it("preserves the existing administrator account and existing reward data during bootstrap", async () => {
    const t = createTest();
    const adminId = await t.run(async (ctx) => await ctx.db.insert("users", {
      email: ADMIN_EMAIL,
      displayName: "Owner",
      onboardingCompletedAt: Date.now(),
      emailVerificationTime: Date.now(),
      isAnonymous: false,
    }));
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

  it("allows the bootstrapped administrator to manage access before onboarding without opening rewards", async () => {
    const t = createTest();
    const userId = await t.run(async (ctx) => await ctx.db.insert("users", {
      email: ADMIN_EMAIL,
      emailVerificationTime: Date.now(),
      isAnonymous: false,
    }));
    const admin = t.withIdentity({ subject: `${userId}|bootstrap-admin`, email: ADMIN_EMAIL });
    expect((await admin.query(api.access.status)).canClaimInitialAdministrator).toBe(true);
    await admin.mutation(api.access._grantInitialAdministrator);
    const bootstrapStatus = await admin.query(api.access.status);
    expect(resolveBetaGateView(true, bootstrapStatus, "/dashboard")).toBe("onboarding");
    expect(resolveBetaGateView(true, bootstrapStatus, "/admin")).toBe("content");
    await expect(admin.query(api.rewards.snapshot)).rejects.toThrow(/Complete your profile setup/);
    expect((await admin.query(api.access.adminOverview)).users.some((user) => user.userId === userId && user.role === "admin")).toBe(true);
    await admin.mutation(api.users.completeOnboarding, { displayName: "Owner" });
    expect((await admin.query(api.access.status)).onboardingComplete).toBe(true);
    expect((await admin.query(api.access.adminOverview)).users.some((user) => user.userId === userId && user.role === "admin")).toBe(true);
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
    expect(resolveBetaGateView(true, await admin.query(api.access.status), "/admin")).toBe("content");
  });

  it("creates recipient-bound hashed invitations, approves only the verified invited account, and rejects reuse", async () => {
    const t = createTest();
    const { admin } = await makeAdmin(t);
    const { code } = await admin.action(api.access.createInvitation, { recipientEmail: "Friend@Example.com" });
    expect(code).toHaveLength(48);
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

  it("creates a generic invitation code that an authenticated guest can claim once", async () => {
    const t = createTest();
    const { admin } = await makeAdmin(t);
    const { code } = await admin.action(api.access.createInvitation, {});
    expect((await admin.query(api.access.adminOverview)).invitations[0].recipientEmail).toBeUndefined();
    expect((await t.mutation(api.access.validateInvitation, { code })).valid).toBe(true);
    const guestId = await t.run(async (ctx) => await ctx.db.insert("users", { isAnonymous: true }));
    const guest = t.withIdentity({ subject: `${guestId}|guest`, isAnonymous: true });
    await guest.mutation(api.access.claimInvitation, { code });
    expect((await guest.query(api.access.status)).approved).toBe(true);
    await expect(guest.mutation(api.access.claimInvitation, { code })).rejects.toThrow(/invalid, expired, revoked, or already used/);
    await expect(guest.query(api.rewards.snapshot)).rejects.toThrow(/Complete your profile setup/);
  });

  it("validates without consuming and normalizes an invitation code and recipient email", async () => {
    const t = createTest();
    const { admin } = await makeAdmin(t);
    const { code } = await admin.action(api.access.createInvitation, { recipientEmail: "Friend@Example.com" });
    expect((await t.mutation(api.access.validateInvitation, { code: ` ${code.toLowerCase()} `, email: " friend@example.com " })).valid).toBe(true);
    const invitations = await t.run(async (ctx) => await ctx.db.query("betaInvitations").collect());
    expect(invitations[0].usedAt).toBeUndefined();
    expect((await t.mutation(api.access.validateInvitation, { code, email: "wrong@example.com" })).valid).toBe(false);
    expect((await t.mutation(api.access.validateInvitation, { code, email: "friend@@example.com" })).valid).toBe(false);
    expect((await t.mutation(api.access.validateInvitation, { code, email: "friend..name@example.com" })).valid).toBe(false);
    expect((await t.mutation(api.access.validateInvitation, { code: "A".repeat(48), email: "friend@example.com" })).valid).toBe(false);
  });

  it("rejects unauthenticated claims and invitation creation, while a normal user cannot mint invitations", async () => {
    const t = createTest();
    await expect(t.mutation(api.access.claimInvitation, { code: "A".repeat(32) })).rejects.toThrow(/Sign in/);
    await expect(t.action(api.access.createInvitation, { recipientEmail: "friend@example.com" })).rejects.toThrow();
    const userId = await createUser(t, "user@example.com");
    const user = t.withIdentity({ subject: `${userId}|s`, email: "user@example.com" });
    await expect(user.action(api.access.createInvitation, { recipientEmail: "friend@example.com" })).rejects.toThrow();
    await expect(user.mutation(api.access.approveUser, { userId })).rejects.toThrow();
    await expect(user.mutation(api.access.approveEmail, { email: "user@example.com" })).rejects.toThrow();
    await expect(user.mutation(api.access.revokeEmailAccess, { email: "user@example.com" })).rejects.toThrow();
  });

  it("rejects expired and revoked invitation codes", async () => {
    const t = createTest();
    const { admin } = await makeAdmin(t);
    const recipientId = await createUser(t, "friend@example.com");
    const friend = t.withIdentity({ subject: `${recipientId}|s`, email: "friend@example.com" });
    const expiredCode = "A".repeat(48);
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
    const matchingInvitation = await t.run(async (ctx) => (await ctx.db.query("betaInvitations").collect()).find((item: Doc<"betaInvitations">) => item.codeHash === generatedHash));
    expect(matchingInvitation).toBeDefined();
    await admin.mutation(api.access.revokeInvitation, { invitationId: matchingInvitation!._id });
    const afterRevoke = await admin.query(api.access.adminOverview);
    expect(afterRevoke.invitations.find((item) => item.id === matchingInvitation!._id)?.status).toBe("revoked");
    await expect(friend.mutation(api.access.claimInvitation, { code })).rejects.toThrow(/invalid, expired, revoked, or already used/);
  });

  it("links guest recovery only to the authenticated anonymous user and never creates or changes an account", async () => {
    const t = createTest();
    const guestId = await t.run(async (ctx) => await ctx.db.insert("users", { isAnonymous: true }));
    const otherId = await t.run(async (ctx) => await ctx.db.insert("users", { isAnonymous: true }));
    const guest = t.withIdentity({ subject: `${guestId}|guest`, isAnonymous: true });
    const other = t.withIdentity({ subject: `${otherId}|other`, isAnonymous: true });
    const credential = "A".repeat(43);
    const replacementCredential = "B".repeat(43);
    await expect(t.mutation(api.access.registerGuestRecoveryCredential, { credential })).rejects.toThrow(/Sign in/);
    await expect(guest.mutation(api.access.registerGuestRecoveryCredential, { credential: "invalid" })).rejects.toThrow(/Invalid guest recovery credential/);
    await expect(guest.mutation(api.access.registerGuestRecoveryCredential, { credential })).resolves.toEqual({ registered: true });
    await expect(guest.mutation(api.access.registerGuestRecoveryCredential, { credential })).resolves.toEqual({ registered: true });
    await expect(other.mutation(api.access.registerGuestRecoveryCredential, { credential })).rejects.toThrow(/already linked to another account/);
    const verifiedUserId = await createUser(t, "verified@example.com");
    const verified = t.withIdentity({ subject: `${verifiedUserId}|verified`, email: "verified@example.com" });
    await expect(verified.mutation(api.access.registerGuestRecoveryCredential, { credential: replacementCredential })).rejects.toThrow(/signed-in guest account/);
    await expect(guest.mutation(api.access.registerGuestRecoveryCredential, { credential: replacementCredential })).resolves.toEqual({ registered: true });
    await expect(t.run(async (ctx) => ({
      users: await ctx.db.query("users").collect(),
      accounts: await ctx.db.query("authAccounts").collect(),
    }))).resolves.toMatchObject({
      users: expect.arrayContaining([expect.objectContaining({ _id: guestId, isAnonymous: true }), expect.objectContaining({ _id: otherId, isAnonymous: true })]),
      accounts: expect.arrayContaining([
        expect.objectContaining({ userId: guestId, provider: "guest-recovery", providerAccountId: expect.not.stringContaining(credential) }),
        expect.objectContaining({ userId: guestId, provider: "guest-recovery", providerAccountId: expect.not.stringContaining(replacementCredential) }),
      ]),
    });
  });

  it("returns a validated saved requester name only to the authenticated account, including after admin approval", async () => {
    const t = createTest();
    const { admin } = await makeAdmin(t);
    const firstId = await t.run(async (ctx) => await ctx.db.insert("users", { isAnonymous: true }));
    const secondId = await t.run(async (ctx) => await ctx.db.insert("users", { isAnonymous: true }));
    const first = t.withIdentity({ subject: `${firstId}|first-guest`, isAnonymous: true });
    const second = t.withIdentity({ subject: `${secondId}|second-guest`, isAnonymous: true });
    await first.mutation(api.access.requestApproval, { requesterName: "  Jamie  " });
    await t.run(async (ctx) => {
      const access = await ctx.db.query("betaAccess").withIndex("by_user", (q) => q.eq("userId", firstId)).unique();
      expect(access?.requesterName).toBe("Jamie");
    });
    await expect(first.query(api.access.status)).resolves.toMatchObject({ requesterName: "Jamie", approved: false, status: "pending" });
    await expect(second.query(api.access.status)).resolves.toMatchObject({ requesterName: null, approved: false, status: "pending" });
    await admin.mutation(api.access.approveUser, { userId: firstId });
    await expect(first.query(api.access.status)).resolves.toMatchObject({ requesterName: "Jamie", approved: true, status: "approved" });
    await t.run(async (ctx) => {
      const access = await ctx.db.query("betaAccess").withIndex("by_user", (q) => q.eq("userId", firstId)).unique();
      await ctx.db.patch(access!._id, { requesterName: "\u0000Invalid" });
    });
    await expect(first.query(api.access.status)).resolves.toMatchObject({ requesterName: null, approved: true, status: "approved" });
  });

  it("creates a named manual approval request for a signed-in guest and only an admin may approve it", async () => {
    const t = createTest();
    const { admin } = await makeAdmin(t);
    const guestId = await t.run(async (ctx) => await ctx.db.insert("users", { isAnonymous: true }));
    const guest = t.withIdentity({ subject: `${guestId}|guest`, isAnonymous: true });
    await expect(guest.mutation(api.access.requestApproval, { requesterName: "  Jamie  " })).resolves.toEqual({ approved: false });
    await expect(guest.query(api.rewards.snapshot)).rejects.toThrow(/not been approved/);
    const pending = await admin.query(api.access.adminOverview);
    expect(pending.users.find((user) => user.userId === guestId)?.requesterName).toBe("Jamie");
    expect((await guest.query(api.access.status)).requesterName).toBe("Jamie");
    await expect(guest.mutation(api.access.approveUser, { userId: guestId })).rejects.toThrow();
    await admin.mutation(api.access.approveUser, { userId: guestId });
    expect((await guest.query(api.access.status)).approved).toBe(true);
    expect((await guest.query(api.access.status)).requesterName).toBe("Jamie");
    await expect(guest.mutation(api.access.requestApproval, { requesterName: "Another name" })).resolves.toEqual({ approved: true });
    await expect(guest.mutation(api.access.requestApproval, { requesterName: "\u0000" })).rejects.toThrow(/control characters/);
  });

  it("keeps manually approved users on the existing access workflow", async () => {
    const t = createTest();
    const { admin } = await makeAdmin(t);
    const userId = await t.run(async (ctx) => await ctx.db.insert("users", { email: "manual@example.com", emailVerificationTime: Date.now(), isAnonymous: false }));
    const manualUser = t.withIdentity({ subject: `${userId}|manual`, email: "manual@example.com" });
    await manualUser.mutation(api.access.requestApproval, { requesterName: "Manual member" });
    await admin.mutation(api.access.approveUser, { userId });
    await manualUser.mutation(api.users.completeOnboarding, { displayName: "Manual member" });
    expect((await manualUser.query(api.users.currentUser))?._id).toBe(userId);
    expect((await manualUser.query(api.rewards.snapshot)).initialized).toBe(false);
  });

  it("pre-approves email addresses for the matching verified account and allows revocation", async () => {
    const t = createTest();
    const { admin } = await makeAdmin(t);
    await admin.mutation(api.access.approveEmail, { email: " NEW.User@example.com " });
    expect((await t.mutation(api.access.validateInvitation, { code: "A".repeat(48) })).valid).toBe(false);
    const pending = await admin.query(api.access.adminOverview);
    expect(pending.emailAccess).toContainEqual(expect.objectContaining({ email: "new.user@example.com", status: "approved" }));
    const userId = await createUser(t, "new.user@example.com");
    const user = t.withIdentity({ subject: `${userId}|email-user`, email: "new.user@example.com" });
    expect((await user.query(api.access.status)).approved).toBe(true);
    expect((await admin.query(api.access.adminOverview)).users.find((entry) => entry.userId === userId)?.status).toBe("approved");
    await admin.mutation(api.access.revokeEmailAccess, { email: "NEW.USER@example.com" });
    expect((await user.query(api.access.status)).approved).toBe(false);
    await expect(user.query(api.rewards.snapshot)).rejects.toThrow(/not been approved/);
    await expect(admin.mutation(api.access.approveEmail, { email: "new.user@example.com" })).rejects.toThrow(/Restore it from User Access/);
    await admin.mutation(api.access.restoreUserAccess, { userId });
    expect((await user.query(api.access.status)).approved).toBe(true);
    await admin.mutation(api.access.revokeUser, { userId });
    await expect(user.query(api.rewards.snapshot)).rejects.toThrow(/not been approved/);
    await expect(admin.mutation(api.access.approveEmail, { email: "new.user@example.com" })).rejects.toThrow(/Restore it from User Access/);
    await admin.mutation(api.access.restoreUserAccess, { userId });
    expect((await user.query(api.access.status)).approved).toBe(true);
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

  it("does not allow a revoked user to regain access by claiming a new invitation", async () => {
    const t = createTest();
    const { admin } = await makeAdmin(t);
    const userId = await createUser(t, "friend@example.com");
    await admin.mutation(api.access.approveUser, { userId });
    await admin.mutation(api.access.revokeUser, { userId });
    const { code } = await admin.action(api.access.createInvitation, { recipientEmail: "friend@example.com" });
    const friend = t.withIdentity({ subject: `${userId}|friend`, email: "friend@example.com" });
    await expect(friend.mutation(api.access.claimInvitation, { code })).rejects.toThrow(/revoked/);
    const access = await t.run(async (ctx) => await ctx.db.query("betaAccess").withIndex("by_user", (q) => q.eq("userId", userId)).unique());
    expect(access?.status).toBe("revoked");
  });

  it("persists onboarding once, rejects unapproved users, and protects existing names", async () => {
    const t = createTest();
    const { admin } = await makeAdmin(t);
    const friendId = await t.run(async (ctx) => await ctx.db.insert("users", { email: "friend@example.com", emailVerificationTime: Date.now(), isAnonymous: false }));
    const friend = t.withIdentity({ subject: `${friendId}|friend`, email: "friend@example.com" });
    await expect(friend.mutation(api.users.completeOnboarding, { displayName: "Friend" })).rejects.toThrow(/not been approved/);
    await admin.mutation(api.access.approveUser, { userId: friendId });
    expect((await friend.query(api.users.currentUser))?.onboardingCompletedAt).toBeUndefined();
    await friend.mutation(api.users.completeOnboarding, { displayName: "  Friend  " });
    const completed = await friend.query(api.users.currentUser);
    expect(completed?.displayName).toBe("Friend");
    expect(completed?.onboardingCompletedAt).toBeDefined();
    expect((await friend.query(api.users.currentUser))?.onboardingCompletedAt).toBe(completed?.onboardingCompletedAt);
    await friend.mutation(api.users.completeOnboarding, { displayName: "Changed" });
    expect((await friend.query(api.users.currentUser))?.displayName).toBe("Friend");
    await expect(friend.mutation(api.users.completeOnboarding, { displayName: "\u0000" })).rejects.toThrow(/control characters/);
    await expect(t.mutation(api.users.completeOnboarding, { displayName: "Name" })).rejects.toThrow(/Sign in/);
  });

  it("allows only one account to claim a single-use invitation, including concurrent attempts", async () => {
    const t = createTest();
    const { admin } = await makeAdmin(t);
    await expect(admin.action(api.access.createInvitation, { recipientEmail: "friend..name@example.com" })).rejects.toThrow(/valid email/);
    const { code } = await admin.action(api.access.createInvitation, { recipientEmail: "friend@example.com" });
    const firstId = await createUser(t, "friend@example.com");
    const secondId = await createUser(t, "friend@example.com");
    const first = t.withIdentity({ subject: `${firstId}|first`, email: "friend@example.com" });
    const second = t.withIdentity({ subject: `${secondId}|second`, email: "friend@example.com" });
    const claims = await Promise.allSettled([
      first.mutation(api.access.claimInvitation, { code }),
      second.mutation(api.access.claimInvitation, { code }),
    ]);
    expect(claims.filter((claim) => claim.status === "fulfilled")).toHaveLength(1);
    expect(claims.filter((claim) => claim.status === "rejected")).toHaveLength(1);
    const accessRecords = await t.run(async (ctx) => await ctx.db.query("betaAccess").collect());
    expect(accessRecords.filter((record) => record.status === "approved")).toHaveLength(2);
    const invitations = await t.run(async (ctx) => await ctx.db.query("betaInvitations").collect());
    expect(invitations[0].claimedBy === firstId || invitations[0].claimedBy === secondId).toBe(true);
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