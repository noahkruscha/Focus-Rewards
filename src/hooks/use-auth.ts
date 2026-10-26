import { api } from "@/convex/_generated/api";
import { useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth, useQuery } from "convex/react";

export function useAuth() {
  const { isLoading: isAuthLoading, isAuthenticated } = useConvexAuth();
  const access = useQuery(api.access.status, isAuthenticated ? {} : "skip");
  const canReadProfile = Boolean(
    isAuthenticated && access &&
    (!access.approvalRequired || access.approved || access.canClaimInitialAdministrator),
  );
  const user = useQuery(api.users.currentUser, canReadProfile ? {} : "skip");
  const { signIn, signOut } = useAuthActions();
  const isLoading = isAuthLoading || (isAuthenticated && access === undefined) || (canReadProfile && user === undefined);

  return { isLoading, isAuthenticated, user, userId: user?._id ?? null, signIn, signOut };
}
