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
const ACCESS_DENIED = "Your account has not been approved for the private beta.";

async function signedInUserId(ctx: QueryCtx | MutationCtx) {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw new ConvexError("Sign in to continue.");
  return userId;
}

async function accessFor(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
  return await ctx.db.query("betaAccess").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
}

export async function requireApprovedUser(ctx: QueryCtx | MutationCtx) {
  const userId = await signedInUserId(ctx);
  if (approvalRequired()) {
    const access = await accessFor(ctx, userId);
    if (!access || access.status !== "approved") throw new ConvexError(ACCESS_DENIED);
  }
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

function encodeBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const status = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return { authenticated: false, approved: false, administrator: false, approvalRequired: approvalRequired() };
    const user = await ctx.db.get(userId);
    const access = await accessFor(ctx, userId);
    const approved = !approvalRequired() || access?.status === "approved";
    const configuredAdminEmail = process.env.BETA_ADMIN_EMAIL?.trim().toLowerCase();
    return {
      authenticated: true,
      approved,
      administrator: approved && user?.role === "admin",
      canClaimInitialAdministrator: Boolean(
        user?.email && !user.isAnonymous && user.emailVerificationTime &&
        configuredAdminEmail === user.email.toLowerCase()
      ),
      approvalRequired: approvalRequired(),
      status: access?.status ?? "pending",
    };  },
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
  args: { recipientEmail: v.string() },
  handler: async (ctx, args): Promise<{ code: string; expiresAt: number }> => {
    if (!invitationsEnabled()) throw new ConvexError("New invitations are temporarily disabled.");
    const recipientEmail = args.recipientEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail) || recipientEmail.length > 254) {
      throw new ConvexError("Enter a valid email address for the invited account.");
    }
    const adminId = await ctx.runQuery(internal.access.assertAdministrator, {});
    const random = new Uint8Array(24);
    crypto.getRandomValues(random);
    const code = encodeBase64Url(random);
    const codeHash = await hashCode(code);
    const expiresAt = Date.now() + INVITATION_LIFETIME_MS;
    await ctx.runMutation(internal.access.storeInvitation, { codeHash, recipientEmail, expiresAt, adminId });
    return { code, expiresAt };  },
});



export const claimInvitation = mutation({
  args: { code: v.string() },
  handler: async (ctx, args) => {
    if (!approvalRequired()) throw new ConvexError("Invitation approval is disabled for this deployment.");
    const userId = await signedInUserId(ctx);
    if (args.code.length < 32 || args.code.length > 64 || !/^[A-Za-z0-9_-]+$/.test(args.code)) {
      throw new ConvexError("Invitation code is invalid, expired, revoked, or already used.");
    }
    const codeHash = await hashCode(args.code);
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
    if (access?.status === "approved") {
      await ctx.db.patch(invitation._id, { usedAt: now, claimedBy: userId });
      return { approved: true };
    }
    if (access) await ctx.db.patch(access._id, { status: "approved", updatedAt: now });
    else await ctx.db.insert("betaAccess", { userId, status: "approved", requestedAt: now, updatedAt: now });
    await ctx.db.patch(invitation._id, { usedAt: now, claimedBy: userId });
    return { approved: true };  },
});



export const adminOverview = query({
  args: {},
  handler: async (ctx) => {
    const adminId = await requireAdministrator(ctx);
    const [users, accessRecords, invitations] = await Promise.all([
      ctx.db.query("users").collect(),
      ctx.db.query("betaAccess").collect(),
      ctx.db.query("betaInvitations").withIndex("by_creator_time", (q) => q.eq("createdBy", adminId)).collect(),
    ]);
    const statusByUser = new Map(accessRecords.map((entry) => [entry.userId, entry.status]));
    return {
      invitationsEnabled: invitationsEnabled(),
      users: users.map((user) => ({
        userId: user._id,
        email: user.email ?? null,
        name: user.name ?? null,
        anonymous: user.isAnonymous ?? false,
        role: user.role ?? null,
        status: statusByUser.get(user._id) ?? "pending",
      })),
      invitations: invitations.map(({ _id, recipientEmail, expiresAt, revokedAt, usedAt, createdAt }) => ({
        id: _id,
        recipientEmail,
        expiresAt,
        revoked: revokedAt !== undefined,
        used: usedAt !== undefined,
        createdAt,
      })),
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
    if (existing) await ctx.db.patch(existing._id, { status: "approved", updatedAt: now, updatedBy: adminId });
    else await ctx.db.insert("betaAccess", { userId: args.userId, status: "approved", requestedAt: now, updatedAt: now, updatedBy: adminId });  },
});



export const revokeUser = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    if (!approvalRequired()) throw new ConvexError("Manual beta approval is disabled for this deployment.");
    const adminId = await requireAdministrator(ctx);
    if (args.userId === adminId) throw new ConvexError("Use a different administrator account to revoke your own access.");
    const existing = await accessFor(ctx, args.userId);
    if (!existing || existing.status !== "approved") return;
    await ctx.db.patch(existing._id, { status: "revoked", updatedAt: Date.now(), updatedBy: adminId });  },
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

export const storeInvitation = internalMutation({
  args: { codeHash: v.string(), recipientEmail: v.string(), expiresAt: v.number(), adminId: v.id("users") },
  handler: async (ctx, args) => {
    const currentAdminId = await requireAdministrator(ctx);
    if (currentAdminId !== args.adminId) throw new ConvexError("Administrator identity changed; retry invitation creation.");
    const createdBy = currentAdminId;
    const now = Date.now();
    const invitations = await ctx.db.query("betaInvitations").withIndex("by_creator_time", (q) => q.eq("createdBy", createdBy)).collect();
    const activeCount = invitations.filter((invitation) => invitation.revokedAt === undefined && invitation.usedAt === undefined && invitation.expiresAt > now).length;
    if (activeCount >= 10) throw new ConvexError("Revoke or wait for an existing invitation before creating another.");
    if (args.expiresAt <= now || args.expiresAt > now + INVITATION_LIFETIME_MS) throw new ConvexError("Invitation expiry must be within the allowed lifetime.");
    if (!/^[a-f0-9]{64}$/.test(args.codeHash) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args.recipientEmail)) throw new ConvexError("Invalid invitation data.");
    await ctx.db.insert("betaInvitations", { codeHash: args.codeHash, recipientEmail: args.recipientEmail, createdBy, createdAt: now, expiresAt: args.expiresAt });  },
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
    if (access) await ctx.db.patch(access._id, { status: "approved", updatedAt: now });
    else await ctx.db.insert("betaAccess", { userId, status: "approved", requestedAt: now, updatedAt: now });
    return { administrator: true };
  },
});
