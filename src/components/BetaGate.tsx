import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { useMutation, useQuery } from "convex/react";
import { useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Loader2, LockKeyhole, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { resolveBetaGateView } from "./betaGateView";

export function BetaGate({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated, user, signOut } = useAuth();
  const status = useQuery(api.access.status, isAuthenticated ? {} : "skip");
  const requestApproval = useMutation(api.access.requestApproval);
  const claimInvitation = useMutation(api.access.claimInvitation);
  const claimInitialAdministrator = useMutation(api.access._grantInitialAdministrator);
  const completeOnboarding = useMutation(api.users.completeOnboarding);
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);

  async function submitInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      await claimInvitation({ code: code.trim() });
      setCode("");
      toast.success("Private beta access approved.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The invitation could not be claimed.");
    } finally {
      setBusy(false);
    }
  }

  async function submitName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await completeOnboarding({ displayName });
      toast.success(`Welcome, ${result.displayName}.`);
      navigate("/dashboard", { replace: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save your profile.");
    } finally {
      setBusy(false);
    }
  }

  if (isLoading || (isAuthenticated && status === undefined)) {
    return <main className="flex min-h-screen items-center justify-center bg-background"><Loader2 className="size-6 animate-spin text-muted-foreground" /></main>;
  }
  const gateView = resolveBetaGateView(isAuthenticated, status, user?.onboardingCompletedAt);
  if (gateView === "content") return children;
  if (gateView === "approval" && !status) return children;
  if (gateView === "onboarding") {
    if (!user) return <main className="flex min-h-screen items-center justify-center bg-background"><Loader2 className="size-6 animate-spin text-muted-foreground" /></main>;
    return <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-md border-white/10 bg-card/90">
        <CardHeader className="text-center"><div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary"><ShieldCheck className="size-5" /></div><CardTitle className="text-2xl tracking-tight">Make this space yours</CardTitle><CardDescription>Your name will be displayed in Focus Rewards. You can use just one name.</CardDescription></CardHeader>
        <CardContent><form onSubmit={(event) => void submitName(event)} className="space-y-4"><label htmlFor="onboarding-display-name" className="text-sm font-medium">What should we call you?</label><Input id="onboarding-display-name" autoComplete="nickname" autoFocus maxLength={40} required value={displayName} onChange={(event) => setDisplayName(event.target.value)} aria-describedby="onboarding-name-help" className="focus-visible:ring-2" /><p id="onboarding-name-help" className="text-xs text-muted-foreground">Up to 40 characters. Your email remains your sign-in identity.</p><Button className="w-full" type="submit" disabled={busy || !displayName.trim()}>{busy ? "Saving…" : "Continue"}</Button></form></CardContent>
      </Card>
    </main>;
  }
  if (status?.canClaimInitialAdministrator && !status.administrator) {
    return <main className="flex min-h-screen items-center justify-center bg-background p-6"><Card className="w-full max-w-md"><CardHeader className="text-center"><ShieldCheck className="mx-auto size-8 text-primary" /><CardTitle>Configure your existing account</CardTitle><CardDescription>Your verified email matches the administrator configured for this deployment. This one-time step preserves your existing account and reward data.</CardDescription></CardHeader><CardContent><Button className="w-full" disabled={busy} onClick={() => { setBusy(true); void claimInitialAdministrator({}).then(() => toast.success("Administrator account configured.")).catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Could not configure administrator access.")).finally(() => setBusy(false)); }}>Configure administrator</Button><Button variant="ghost" className="mt-2 w-full" disabled={busy} onClick={() => { setBusy(true); void signOut().finally(() => setBusy(false)); }}>Sign out</Button></CardContent></Card></main>;
  }

  if (!status) return children;
  return <main className="flex min-h-screen items-center justify-center bg-background p-6">
    <Card className="w-full max-w-md border-white/10 bg-card/90">
      <CardHeader className="text-center"><div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-muted"><LockKeyhole className="size-5 text-muted-foreground" /></div><CardTitle>{status.status === "revoked" ? "Access revoked" : "Private beta approval"}</CardTitle><CardDescription>{status.status === "revoked" ? "Your Focus Rewards beta access has been revoked. Contact the administrator if you think this is a mistake." : "Your account is signed in, but protected Focus Rewards data is unavailable until access is approved."}</CardDescription></CardHeader>
      {status.status !== "revoked" && <CardContent className="space-y-4">
        <form onSubmit={(event) => void submitInvitation(event)} className="space-y-3"><label htmlFor="beta-invitation" className="text-sm font-medium">Have an invitation for this email?</label><Input id="beta-invitation" autoComplete="off" value={code} onChange={(event) => setCode(event.target.value)} placeholder="Paste your private invitation code" minLength={32} maxLength={64} required /><Button className="w-full" disabled={busy || code.trim().length < 32}>{busy ? "Checking invitation…" : "Claim invitation"}</Button></form>
        <div className="text-center text-sm text-muted-foreground">or</div>
        <Button variant="outline" className="w-full" disabled={busy} onClick={() => { setBusy(true); void requestApproval({}).then(() => toast.success("Approval request recorded. An administrator can review it under User Access.")).catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Could not request approval.")).finally(() => setBusy(false)); }}>Request manual approval</Button>
      </CardContent>}
      <CardContent className="space-y-3"><p className="text-center text-xs text-muted-foreground">Access is checked on the server and bound to your signed-in account.</p><Button variant="ghost" className="w-full" disabled={busy} onClick={() => { setBusy(true); void signOut().finally(() => setBusy(false)); }}>Sign out or switch account</Button></CardContent>
    </Card>
  </main>;
}
