import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { useMutation, useQuery } from "convex/react";
import { useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Loader2, LockKeyhole, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

export function BetaGate({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated, signOut } = useAuth();
  const status = useQuery(api.access.status, isAuthenticated ? {} : "skip");
  const requestApproval = useMutation(api.access.requestApproval);
  const claimInvitation = useMutation(api.access.claimInvitation);
  const claimInitialAdministrator = useMutation(api.access._grantInitialAdministrator);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
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

  if (isLoading || (isAuthenticated && status === undefined)) {
    return <main className="flex min-h-screen items-center justify-center bg-background"><Loader2 className="size-6 animate-spin text-muted-foreground" /></main>;
  }
  if (!isAuthenticated || !status?.approvalRequired || status.approved) return children;
  if (status.status === "revoked" && status.administrator) return children;

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="flex justify-center"><div className="mb-3 flex size-12 items-center justify-center rounded-full bg-muted"><LockKeyhole className="size-5 text-muted-foreground" /></div></div>
          <CardTitle>{status.administrator ? "Administrator access" : status.status === "revoked" ? "Access revoked" : "Private beta approval"}</CardTitle>
          <CardDescription>{status.status === "revoked" ? "Your Focus Rewards beta access has been revoked. Contact the administrator if you think this is a mistake." : "This account is signed in, but protected Focus Rewards data remains unavailable until the administrator approves it."}</CardDescription>
        </CardHeader>
        {status.canClaimInitialAdministrator && !status.administrator && <CardContent><Button className="w-full" disabled={busy} onClick={() => { setBusy(true); void claimInitialAdministrator({}).then(() => toast.success("Administrator account configured.")).catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Could not configure administrator access.")).finally(() => setBusy(false)); }}><ShieldCheck className="mr-2 size-4" />Configure this existing account as administrator</Button></CardContent>}
        {status.status !== "revoked" && !status.administrator && <CardContent className="space-y-4">
          <form onSubmit={submit} className="space-y-3">
            <label htmlFor="beta-invitation" className="text-sm font-medium">Have an invitation for this email?</label>
            <Input id="beta-invitation" autoComplete="off" value={code} onChange={(event) => setCode(event.target.value)} placeholder="Paste your private invitation code" minLength={32} maxLength={64} required />
            <Button className="w-full" disabled={busy || code.trim().length < 32}>{busy ? "Checking invitation…" : "Claim invitation"}</Button>
          </form>
          <div className="text-center text-sm text-muted-foreground">or</div>
          <Button variant="outline" className="w-full" disabled={busy} onClick={() => { setBusy(true); void requestApproval({}).then(() => toast.success("Approval request recorded.")).catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Could not request approval.")).finally(() => setBusy(false)); }}>Request manual approval</Button>
        </CardContent>}
        <CardContent className="space-y-3"><p className="text-center text-xs text-muted-foreground">Signed in as {status.authenticated ? "your verified account" : ""}. Account data is checked on the server, not in this page.</p><Button variant="ghost" className="w-full" disabled={busy} onClick={() => { setBusy(true); void signOut().finally(() => setBusy(false)); }}>Sign out or switch account</Button></CardContent>
      </Card>
    </main>
  );
}
