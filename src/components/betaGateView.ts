export type BetaGateStatus = {
  approvalRequired: boolean;
  approved: boolean;
  onboardingComplete: boolean;
};

export function resolveBetaGateView(
  isAuthenticated: boolean,
  status: BetaGateStatus | undefined,
  onboardingCompletedAt?: number,
): "approval" | "onboarding" | "content" {
  if (isAuthenticated && status?.approvalRequired && !status.approved) return "approval";
  if (isAuthenticated && status && !status.onboardingComplete && !onboardingCompletedAt) return "onboarding";
  return "content";
}
