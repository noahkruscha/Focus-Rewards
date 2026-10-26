import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";

// Read deployment-controlled settings per invocation so dashboard changes take effect without a client-side bypass.
function approvalRequired() {
  return process.env.BETA_REQUIRE_APPROVAL !== "false";
}

function invitationsEnabled() {
  return process.env.BETA_INVITATIONS_ENABLED !== "false";
}

const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_INVITATION_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
const PAIRING_CODE_LIFETIME_MS = 5 * 60 * 1000;
const EXTENSION_SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const ACCESS_DENIED = "Your account has not been approved for the private beta.";

async function signedInUserId(ctx: QueryCtx | MutationCtx) {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw new ConvexError("Sign in to continue.");
  return userId;
}

async function accessFor(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
  return await ctx.db.query("betaAccess").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
}

function hasCompletedProfile(user: { displayName?: string; name?: string } | null) {
  const name = user?.displayName ?? user?.name;
  return Boolean(name && name.trim() && name.trim().length <= 40 && Array.from(name).every((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point > 31 && (point < 127 || point > 159);
  }));
}

export async function requireApprovedUser(ctx: QueryCtx | MutationCtx) {
  const userId = await signedInUserId(ctx);
  if (approvalRequired()) {
    const access = await accessFor(ctx, userId);
    if (!access || access.status !== "approved") throw new ConvexError(ACCESS_DENIED);
  }
  if (!hasCompletedProfile(await ctx.db.get(userId))) throw new ConvexError("Complete your profile setup to continue.");
  return userId;
}

export async function requireAdministrator(ctx: QueryCtx | MutationCtx) {
  const userId = await signedInUserId(ctx);
  const user = await ctx.db.get(userId);
  if (!user || user.role !== "admin") throw new ConvexError("Administrator access required.");
  if (approvalRequired()) {
    const access = await accessFor(ctx, userId);
    if (access?.status !== "approved") throw new ConvexError(ACCESS_DENIED);
  }
  return userId;
}

async function hashCode(code: string) {
  const bytes = new TextEncoder().encode(`focus-rewards-beta-invite:v1:${code}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashSecret(purpose: "extension-pair" | "extension-session", secret: string) {
  const bytes = new TextEncoder().encode(`focus-rewards:${purpose}:v1:${secret}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function encodeBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function normalizeInvitationCode(code: string) {
  const trimmed = code.trim();
  const compact = Array.from(trimmed).filter((character) => character.trim() !== "" && character !== "-").join("");
  return /^[A-Fa-f0-9]{48}$/.test(compact) ? compact.toUpperCase() : trimmed;
}

function invitationCodeLabel(code: string) {
  return `••••${code.slice(-4)}`;
}

export const status = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return { authenticated: false, approved: false, onboardingComplete: false, administrator: false, approvalRequired: approvalRequired() };
    const user = await ctx.db.get(userId);
    const access = await accessFor(ctx, userId);
    const approved = !approvalRequired() || access?.status === "approved";
    const configuredAdminEmail = process.env.BETA_ADMIN_EMAIL?.trim().toLowerCase();
    return {
      authenticated: true,
      approved,
      onboardingComplete: hasCompletedProfile(user),
      administrator: approved && user?.role === "admin",
      canClaimInitialAdministrator: Boolean(
        !access && user?.email && !user.isAnonymous && user.emailVerificationTime &&
        configuredAdminEmail === user.email.toLowerCase()
      ),
      approvalRequired: approvalRequired(),
      status: access?.status ?? "pending",
    };  },
});



export const createExtensionPairingCode = action({
  args: {},
  handler: async (ctx): Promise<{ code: string; expiresAt: number }> => {
    const userId = await ctx.runQuery(internal.access.assertApprovedUser, {});
    const now = Date.now();
    const random = new Uint8Array(24);
    crypto.getRandomValues(random);
    const code = encodeBase64Url(random);
    const codeHash = await hashSecret("extension-pair", code);
    const expiresAt = now + PAIRING_CODE_LIFETIME_MS;
    await ctx.runMutation(internal.access.storeExtensionPairingCode, { codeHash, userId, now, expiresAt });
    return { code, expiresAt };
  },
});

export const storeExtensionPairingCode = internalMutation({
  args: { codeHash: v.string(), userId: v.id("users"), now: v.number(), expiresAt: v.number() },
  handler: async (ctx, args) => {
    const userId = await requireApprovedUser(ctx);
    if (userId !== args.userId || !/^[a-f0-9]{64}$/.test(args.codeHash) || !Number.isSafeInteger(args.now) || args.expiresAt !== args.now + PAIRING_CODE_LIFETIME_MS || args.now > Date.now() + 5_000) {
      throw new ConvexError("Invalid extension pairing request.");
    }
    const existingCodes = await ctx.db.query("extensionPairingCodes").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
    for (const existing of existingCodes) {
      if (existing.usedAt === undefined && existing.revokedAt === undefined && existing.expiresAt > args.now) {
        await ctx.db.patch(existing._id, { revokedAt: args.now });
      }
    }
    await ctx.db.insert("extensionPairingCodes", { codeHash: args.codeHash, userId, createdAt: args.now, expiresAt: args.expiresAt });
  },
});

export const requestApproval = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await signedInUserId(ctx);
    const existing = await accessFor(ctx, userId);
    if (existing?.status === "approved") return { approved: true };
    if (!existing) {
      const now = Date.now();
      await ctx.db.insert("betaAccess", { userId, status: "pending", requestedAt: now, updatedAt: now });
    }
    return { approved: false };  },
});



export const createInvitation = action({
  args: { recipientEmail: v.string(), expiresAt: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ code: string; expiresAt: number }> => {
    if (!invitationsEnabled()) throw new ConvexError("New invitations are temporarily disabled.");
    const recipientEmail = args.recipientEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail) || recipientEmail.length > 254) {
      throw new ConvexError("Enter a valid email address for the invited account.");
    }
    const adminId = await ctx.runQuery(internal.access.assertAdministrator, {});
    const now = Date.now();
    const expiresAt = args.expiresAt ?? now + INVITATION_LIFETIME_MS;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + MAX_INVITATION_LIFETIME_MS) {
      throw new ConvexError("Choose an expiry date within the next 90 days.");
    }
    const random = new Uint8Array(24);
    crypto.getRandomValues(random);
    const code = Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
    const codeHash = await hashCode(code);
    const label = invitationCodeLabel(code);
    await ctx.runMutation(internal.access.storeInvitation, { codeHash, recipientEmail, expiresAt, adminId, label });
    return { code, expiresAt };  },
});



export const validateInvitation = mutation({
  args: { code: v.string(), email: v.string() },
  handler: async (ctx, args) => {
    if (!approvalRequired() || !invitationsEnabled()) return { valid: false };
    const normalizedCode = normalizeInvitationCode(args.code);
    if (!(/^[A-F0-9]{48}$/.test(normalizedCode) || /^[A-Za-z0-9_-]{32}$/.test(normalizedCode))) return { valid: false };
    const email = args.email.trim().toLowerCase();
    const at = email.indexOf("@");
    if (at <= 0 || at !== email.lastIndexOf("@") || email.length > 254 || !email.slice(at + 1).includes(".")) return { valid: false };
    const codeHash = await hashCode(normalizedCode);
    const invitation = await ctx.db.query("betaInvitations").withIndex("by_hash", (q) => q.eq("codeHash", codeHash)).unique();
    return { valid: Boolean(invitation && invitation.recipientEmail === email && invitation.usedAt === undefined && invitation.revokedAt === undefined && invitation.expiresAt > Date.now()) };
  },
});



export const claimInvitation = mutation({
  args: { code: v.string() },
  handler: async (ctx, args) => {
    if (!approvalRequired()) throw new ConvexError("Invitation approval is disabled for this deployment.");
    const userId = await signedInUserId(ctx);
    const normalizedCode = normalizeInvitationCode(args.code);
    if (!(/^[A-F0-9]{48}$/.test(normalizedCode) || /^[A-Za-z0-9_-]{32}$/.test(normalizedCode))) {
      throw new ConvexError("Invitation code is invalid, expired, revoked, or already used.");
    }
    const codeHash = await hashCode(normalizedCode);
    const invitation = await ctx.db.query("betaInvitations").withIndex("by_hash", (q) => q.eq("codeHash", codeHash)).unique();
    const now = Date.now();
    if (!invitation || invitation.revokedAt !== undefined || invitation.usedAt !== undefined || invitation.expiresAt <= now) {
      throw new ConvexError("Invitation code is invalid, expired, revoked, or already used.");
    }
    const user = await ctx.db.get(userId);
    if (!user?.email || user.isAnonymous || !user.emailVerificationTime || user.email.toLowerCase() !== invitation.recipientEmail) {
      throw new ConvexError("This invitation is for a different verified email account.");
    }
    const access = await accessFor(ctx, userId);
    if (access?.status === "approved") throw new ConvexError("This account already has beta access; the invitation was not used.");
    if (access) await ctx.db.patch(access._id, { status: "approved", updatedAt: now, approvedAt: now, invitationId: invitation._id, invitationCodeLabel: invitation.codeLabel });
    else await ctx.db.insert("betaAccess", { userId, status: "approved", requestedAt: now, updatedAt: now, approvedAt: now, invitationId: invitation._id, invitationCodeLabel: invitation.codeLabel });
    await ctx.db.patch(invitation._id, { usedAt: now, claimedBy: userId });
    return { approved: true };  },
});



export const redeemExtensionPairingCode = internalMutation({
  args: { codeHash: v.string(), sessionHash: v.string(), now: v.number() },
  handler: async (ctx, args) => {
    const pairing = await ctx.db.query("extensionPairingCodes").withIndex("by_hash", (q) => q.eq("codeHash", args.codeHash)).unique();
    if (!pairing || pairing.usedAt !== undefined || pairing.revokedAt !== undefined || pairing.expiresAt <= args.now) {
      throw new ConvexError("Pairing code is invalid, expired, revoked, or already used.");
    }
    if (!/^[a-f0-9]{64}$/.test(args.codeHash) || !/^[a-f0-9]{64}$/.test(args.sessionHash) || !Number.isSafeInteger(args.now) || args.now > Date.now() + 5_000) {
      throw new ConvexError("Invalid extension credential request.");
    }
    const user = await ctx.db.get(pairing.userId);
    const access = await accessFor(ctx, pairing.userId);
    if (!user || user.isAnonymous || (approvalRequired() && access?.status !== "approved")) {
      throw new ConvexError(ACCESS_DENIED);
    }
    const expiresAt = args.now + EXTENSION_SESSION_LIFETIME_MS;
    await ctx.db.patch(pairing._id, { usedAt: args.now });
    const sessionId = await ctx.db.insert("extensionSessions", {
      tokenHash: args.sessionHash,
      userId: pairing.userId,
      createdAt: args.now,
      expiresAt,
    });
    return { sessionId, email: user.email ?? null, expiresAt };
  },
});

export const revokeExtensionSessionByHash = internalMutation({
  args: { tokenHash: v.string(), now: v.number() },
  handler: async (ctx, args) => {
    const session = await ctx.db.query("extensionSessions").withIndex("by_hash", (q) => q.eq("tokenHash", args.tokenHash)).unique();
    if (session && session.revokedAt === undefined && session.expiresAt > args.now) {
      await ctx.db.patch(session._id, { revokedAt: args.now });
    }
  },
});

export const assertExtensionSession = internalQuery({
  args: { tokenHash: v.string(), now: v.number() },
  handler: async (ctx, args) => {
    const session = await ctx.db.query("extensionSessions").withIndex("by_hash", (q) => q.eq("tokenHash", args.tokenHash)).unique();
    if (!session || session.revokedAt !== undefined || session.expiresAt <= args.now) return null;
    const user = await ctx.db.get(session.userId);
    const access = await accessFor(ctx, session.userId);
    if (!user || user.isAnonymous || (approvalRequired() && access?.status !== "approved")) return null;
    return { userId: session.userId, tokenHash: args.tokenHash, email: user.email ?? null, expiresAt: session.expiresAt };
  },
});

export const extensionSessions = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireApprovedUser(ctx);
    const currentUser = await ctx.db.get(userId);
    const sessions = currentUser?.role === "admin"
      ? await ctx.db.query("extensionSessions").collect()
      : await ctx.db.query("extensionSessions").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
    return sessions.map(({ _id, userId: ownerId, createdAt, expiresAt, revokedAt }) => ({
      id: _id,
      userId: ownerId,
      createdAt,
      expiresAt,
      revoked: revokedAt !== undefined,
    }));
  },
});

export const revokeExtensionSession = mutation({
  args: { sessionId: v.id("extensionSessions") },
  handler: async (ctx, args) => {
    const userId = await requireApprovedUser(ctx);
    const session = await ctx.db.get(args.sessionId);
    if (!session) return;
    const currentUser = await ctx.db.get(userId);
    if (session.userId !== userId && currentUser?.role !== "admin") throw new ConvexError("Extension credential not found.");
    if (session.userId !== userId && !await accessFor(ctx, session.userId).then((access) => access?.status === "approved")) throw new ConvexError("Extension credential not found.");
    if (session.revokedAt === undefined) await ctx.db.patch(session._id, { revokedAt: Date.now() });
  },
});

export const adminOverview = query({
  args: {},
  handler: async (ctx) => {
    await requireAdministrator(ctx);
    const [users, accessRecords, invitations] = await Promise.all([
      ctx.db.query("users").collect(),
      ctx.db.query("betaAccess").collect(),
      ctx.db.query("betaInvitations").collect(),
    ]);
    const statusByUser = new Map(accessRecords.map((entry) => [entry.userId, entry.status]));
    const userById = new Map(users.map((user) => [user._id, user]));
    return {
      invitationsEnabled: invitationsEnabled(),
      users: users.map((user) => {
        const access = accessRecords.find((entry) => entry.userId === user._id);
        return {
          userId: user._id,
          email: user.email ?? null,
          name: user.displayName ?? user.name ?? null,
          createdAt: user._creationTime,
          anonymous: user.isAnonymous ?? false,
          role: user.role ?? null,
          status: statusByUser.get(user._id) ?? "pending",
          invited: access?.invitationId !== undefined,
          requestedAt: access?.requestedAt ?? null,
          approvedAt: access?.approvedAt ?? null,
          updatedAt: access?.updatedAt ?? null,
          invitationId: access?.invitationId ?? null,
          invitationCodeLabel: access?.invitationCodeLabel ?? null,
        };
      }),
      invitationCounts: {
        available: invitations.filter((item) => item.revokedAt === undefined && item.usedAt === undefined && item.expiresAt > Date.now()).length,
        redeemed: invitations.filter((item) => item.usedAt !== undefined).length,
      },
      pendingCount: accessRecords.filter((item) => item.status === "pending").length,
      invitations: invitations.map(({ _id, recipientEmail, expiresAt, revokedAt, usedAt, createdAt, claimedBy, codeLabel }) => {
        const redeemedUser = claimedBy ? userById.get(claimedBy) : undefined;
        return {
          id: _id,
          codeLabel: codeLabel ?? "Invitation",
          recipientEmail,
          expiresAt,
          revoked: revokedAt !== undefined,
          used: usedAt !== undefined,
          usedAt: usedAt ?? null,
          claimedBy: claimedBy ?? null,
          redeemedBy: redeemedUser ? { name: redeemedUser.displayName ?? redeemedUser.name ?? null, email: redeemedUser.email ?? null } : null,
          createdAt,
          status: revokedAt !== undefined ? "revoked" as const : usedAt !== undefined ? "redeemed" as const : expiresAt <= Date.now() ? "expired" as const : "available" as const,
        };
      }),
    };  },
});



export const approveUser = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    if (!approvalRequired()) throw new ConvexError("Manual beta approval is disabled for this deployment.");
    const adminId = await requireAdministrator(ctx);
    const user = await ctx.db.get(args.userId);
    if (!user) throw new ConvexError("User not found.");
    if (!user.email || user.isAnonymous || !user.emailVerificationTime) throw new ConvexError("Only accounts with a verified email can be approved.");
    const existing = await accessFor(ctx, args.userId);
    const now = Date.now();
    if (existing) await ctx.db.patch(existing._id, { status: "approved", updatedAt: now, approvedAt: now, invitationId: undefined, invitationCodeLabel: undefined, updatedBy: adminId });
    else await ctx.db.insert("betaAccess", { userId: args.userId, status: "approved", requestedAt: now, updatedAt: now, approvedAt: now, updatedBy: adminId });  },
});



export const revokeUser = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    if (!approvalRequired()) throw new ConvexError("Manual beta approval is disabled for this deployment.");
    const adminId = await requireAdministrator(ctx);
    if (args.userId === adminId) throw new ConvexError("Use a different administrator account to revoke your own access.");
    const existing = await accessFor(ctx, args.userId);
    if (!existing || existing.status !== "approved") return;
    const now = Date.now();
    await ctx.db.patch(existing._id, { status: "revoked", updatedAt: now, updatedBy: adminId });
    const pairingCodes = await ctx.db.query("extensionPairingCodes").withIndex("by_user", (q) => q.eq("userId", args.userId)).collect();
    for (const code of pairingCodes) {
      if (code.revokedAt === undefined && code.usedAt === undefined) await ctx.db.patch(code._id, { revokedAt: now });
    }
    const sessions = await ctx.db.query("extensionSessions").withIndex("by_user", (q) => q.eq("userId", args.userId)).collect();
    for (const session of sessions) {
      if (session.revokedAt === undefined) await ctx.db.patch(session._id, { revokedAt: now });
    }
  },
});



export const revokeInvitation = mutation({
  args: { invitationId: v.id("betaInvitations") },
  handler: async (ctx, args) => {
    const adminId = await requireAdministrator(ctx);
    const invitation = await ctx.db.get(args.invitationId);
    if (invitation && invitation.createdBy !== adminId) throw new ConvexError("Invitation not found.");
    if (invitation && invitation.revokedAt === undefined && invitation.usedAt === undefined) {
      await ctx.db.patch(invitation._id, { revokedAt: Date.now() });
    }  },
});



export const activeInvitationCount = internalQuery({
  args: {},
  handler: async (ctx) => {
    const adminId = await requireAdministrator(ctx);
    const now = Date.now();
    const invitations = await ctx.db.query("betaInvitations").withIndex("by_creator_time", (q) => q.eq("createdBy", adminId)).collect();
    return invitations.filter((invitation) => invitation.revokedAt === undefined && invitation.usedAt === undefined && invitation.expiresAt > now).length;  },
});



export const assertAdministrator = internalQuery({
  args: {},
  handler: async (ctx) => await requireAdministrator(ctx),
});

export const assertApprovedUser = internalQuery({
  args: {},
  handler: async (ctx) => await requireApprovedUser(ctx),
});

export const storeInvitation = internalMutation({
  args: { codeHash: v.string(), recipientEmail: v.string(), expiresAt: v.number(), adminId: v.id("users"), label: v.string() },
  handler: async (ctx, args) => {
    const currentAdminId = await requireAdministrator(ctx);
    if (currentAdminId !== args.adminId) throw new ConvexError("Administrator identity changed; retry invitation creation.");
    const createdBy = currentAdminId;
    const now = Date.now();
    const invitations = await ctx.db.query("betaInvitations").withIndex("by_creator_time", (q) => q.eq("createdBy", createdBy)).collect();
    const activeCount = invitations.filter((invitation) => invitation.revokedAt === undefined && invitation.usedAt === undefined && invitation.expiresAt > now).length;
    if (activeCount >= 10) throw new ConvexError("Revoke or wait for an existing invitation before creating another.");
    if (args.expiresAt <= now || args.expiresAt > now + MAX_INVITATION_LIFETIME_MS) throw new ConvexError("Invitation expiry must be within the allowed lifetime.");
    if (!/^[a-f0-9]{64}$/.test(args.codeHash) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args.recipientEmail)) throw new ConvexError("Invalid invitation data.");
    if (!/^••••[A-F0-9]{4}$/.test(args.label)) throw new ConvexError("Invalid invitation data.");
    await ctx.db.insert("betaInvitations", { codeHash: args.codeHash, codeLabel: args.label, recipientEmail: args.recipientEmail, createdBy, createdAt: now, expiresAt: args.expiresAt });  },
});



export const _grantInitialAdministrator = mutation({
  args: {},
  handler: async (ctx) => {
    if (!approvalRequired()) throw new ConvexError("Initial beta administrator setup is disabled for this deployment.");
    const userId = await signedInUserId(ctx);
    const user = await ctx.db.get(userId);
    if (!user?.email || user.isAnonymous || !user.emailVerificationTime) throw new ConvexError("An existing verified-email account is required.");
    if (process.env.BETA_ADMIN_EMAIL?.trim().toLowerCase() !== user.email.toLowerCase()) {
      throw new ConvexError("This account is not the configured initial administrator.");
    }
    if (user.role === "admin") throw new ConvexError("The initial administrator has already been configured.");
    if (user.role) throw new ConvexError("This account already has a conflicting role.");
    const existingAdministrator = await ctx.db.query("users").filter((q) => q.eq(q.field("role"), "admin")).first();
    if (existingAdministrator) throw new ConvexError("The initial administrator has already been configured.");
    const existingApproval = await accessFor(ctx, userId);
    if (existingApproval?.status === "revoked") throw new ConvexError("A revoked account cannot initialize administrator access.");
    await ctx.db.patch(userId, { role: "admin" });
    const access = await accessFor(ctx, userId);
    const now = Date.now();
    if (access) await ctx.db.patch(access._id, { status: "approved", updatedAt: now, approvedAt: now, invitationId: undefined, invitationCodeLabel: undefined });
    else await ctx.db.insert("betaAccess", { userId, status: "approved", requestedAt: now, updatedAt: now, approvedAt: now });
    return { administrator: true };
  },
});
