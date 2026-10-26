import { getAuthUserId } from "@convex-dev/auth/server";
import { accessFor } from "./access";
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";

function validDisplayName(value: string | undefined) {
  if (!value || !value.trim() || value.trim().length > 40) return false;
  return Array.from(value).every((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point > 31 && (point < 127 || point > 159);
  });
}

/**
 * Get the current signed in user. Returns null if the user is not signed in.
 * Usage: const signedInUser = await ctx.runQuery(api.authHelpers.currentUser);
 * THIS FUNCTION IS READ-ONLY. Authorization must remain consistent with the beta bootstrap flow.
 */
export const currentUser = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const user = await ctx.db.get(userId);
    if (!user) return null;
    const approvalRequired = process.env.BETA_REQUIRE_APPROVAL !== "false";
    const profileAlreadyExists = validDisplayName(user.displayName) || validDisplayName(user.name);
    let access: { status: "pending" | "approved" | "revoked" } | null = null;
    if (approvalRequired) {
      access = await accessFor(ctx, userId);
      if (access?.status === "revoked") throw new ConvexError("Your account has not been approved for the private beta.");
      const configuredEmail = process.env.BETA_ADMIN_EMAIL?.trim().toLowerCase();
      const eligibleInitialAdmin = Boolean(!user.role && user.email && !user.isAnonymous && user.emailVerificationTime && configuredEmail === user.email.toLowerCase());
      if (!eligibleInitialAdmin && access?.status !== "approved") throw new ConvexError("Your account has not been approved for the private beta.");
    }
    const onboardingCompletedAt = profileAlreadyExists ? user.onboardingCompletedAt ?? user._creationTime : undefined;
    return { ...user, onboardingCompletedAt };
  },
});

export const completeOnboarding = mutation({
  args: { displayName: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new ConvexError("Sign in to continue.");
    const user = await ctx.db.get(userId);
    if (!user) throw new ConvexError("Account not found.");
    const approvalRequired = process.env.BETA_REQUIRE_APPROVAL !== "false";
    if (approvalRequired) {
      const access = await accessFor(ctx, userId);
      if (access?.status === "revoked") throw new ConvexError("Your account has not been approved for the private beta.");
      const configuredEmail = process.env.BETA_ADMIN_EMAIL?.trim().toLowerCase();
      const initialAdministrator = Boolean(!user.role && user.email && !user.isAnonymous && user.emailVerificationTime && configuredEmail === user.email.toLowerCase() && !access);
      if (access?.status !== "approved" && !initialAdministrator) throw new ConvexError("Your account has not been approved for the private beta.");
    }
    if (!validDisplayName(args.displayName)) {
      throw new ConvexError("Choose a name between 1 and 40 characters without control characters.");
    }
    const displayName = args.displayName.trim();
    const access = approvalRequired
      ? await accessFor(ctx, userId)
      : null;
    if (access?.status === "revoked") throw new ConvexError("Your account has not been approved for the private beta.");
    if (approvalRequired && access?.status !== "approved") {
      const configuredEmail = process.env.BETA_ADMIN_EMAIL?.trim().toLowerCase();
      const initialAdministrator = Boolean(!user.role && user.email && !user.isAnonymous && user.emailVerificationTime && configuredEmail === user.email.toLowerCase() && !access);
      if (!initialAdministrator) throw new ConvexError("Your account has not been approved for the private beta.");
    }
    const alreadyComplete = validDisplayName(user.displayName) || validDisplayName(user.name);
    const savedName = alreadyComplete
      ? (user.displayName && validDisplayName(user.displayName) ? user.displayName : user.name!)
      : displayName;
    await ctx.db.patch(userId, {
      displayName: savedName,
      onboardingCompletedAt: alreadyComplete ? user.onboardingCompletedAt ?? user._creationTime : Date.now(),
    });
    return { displayName: savedName, onboardingCompleted: true };
  },
});
