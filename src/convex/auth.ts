// THIS FILE IS READ ONLY. Do not touch this file unless you are correctly adding a new auth provider in accordance to the vly auth documentation

import { convexAuth, retrieveAccount } from "@convex-dev/auth/server";
import { Anonymous } from "@convex-dev/auth/providers/Anonymous";
import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import { emailOtp } from "./auth/emailOtp";

const guestRecovery = ConvexCredentials({
  id: "guest-recovery",
  authorize: async (credentials, ctx) => {
    const recoveryCredential = credentials.recoveryCredential;
    if (typeof recoveryCredential !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(recoveryCredential)
      || credentials.mode !== "recover") return null;
    const tokenHash = await hashGuestRecoveryCredential(recoveryCredential);
    const existing = await retrieveAccount(ctx, { provider: "guest-recovery", account: { id: tokenHash } }).catch(() => null);
    return existing?.user.isAnonymous ? { userId: existing.user._id } : null;
  },
});

async function hashGuestRecoveryCredential(credential: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`focus-rewards:guest-recovery:v1:${credential}`));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [emailOtp, Anonymous, guestRecovery],
});