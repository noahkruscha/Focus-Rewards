export type BetaGateStatus = {
  approvalRequired: boolean;
  approved: boolean;
  administrator: boolean;
  canClaimInitialAdministrator: boolean;
  onboardingComplete: boolean;
};

export function resolveBetaGateView(
  isAuthenticated: boolean,
  status: BetaGateStatus | undefined,
  pathname: string,
): "approval" | "administrator-bootstrap" | "onboarding" | "content" {
  if (isAuthenticated && status?.canClaimInitialAdministrator && !status.administrator) return "administrator-bootstrap";
  // Admin workflows remain available to an authorized administrator even if
  // that account still needs to finish onboarding. Convex still guards the route.
  if (isAuthenticated && pathname === "/admin" && status?.administrator) return "content";
  if (isAuthenticated && status?.approvalRequired && !status.approved) return "approval";
  if (isAuthenticated && status && !status.onboardingComplete) return "onboarding";
  return "content";
}
