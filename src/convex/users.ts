import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import { query } from "./_generated/server";

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
    if (approvalRequired) {
      const access = await ctx.db.query("betaAccess").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
      if (access?.status === "approved") return user;
      const configuredEmail = process.env.BETA_ADMIN_EMAIL?.trim().toLowerCase();
      const eligibleInitialAdmin = Boolean(user.email && !user.isAnonymous && user.emailVerificationTime && configuredEmail === user.email.toLowerCase());
      if (!eligibleInitialAdmin) throw new ConvexError("Your account has not been approved for the private beta.");
    }
    return user;
  },
});
