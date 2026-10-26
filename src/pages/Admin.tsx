import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAction, useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import { ArrowLeft, Copy, Loader2, ShieldCheck, ShieldX, Ticket, UserCheck, UserRoundX } from "lucide-react";
import { useNavigate } from "react-router";

export function Admin() {
  const { isLoading: authLoading } = useAuth();
  const navigate = useNavigate();
  const overview = useQuery(api.access.adminOverview, authLoading ? "skip" : {});
  const createInvitation = useAction(api.access.createInvitation);
  const approveUser = useMutation(api.access.approveUser);
  const revokeUser = useMutation(api.access.revokeUser);
  const revokeInvitation = useMutation(api.access.revokeInvitation);
  const [email, setEmail] = useState("");
  const [invitation, setInvitation] = useState<{ code: string; expiresAt: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyUser, setBusyUser] = useState<string | null>(null);

  async function invite(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await createInvitation({ recipientEmail: email });
      setInvitation(result);
      setEmail("");
      toast.success("Single-use invitation created. Copy it now; it will not be shown again.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create invitation.");
    } finally {
      setBusy(false);
    }
  }

  async function copyCode() {
    if (!invitation) return;
    await navigator.clipboard.writeText(invitation.code);
    toast.success("Invitation copied. Share it privately only with its named recipient.");
  }

  async function changeAccess(userId: Id<"users">, approve: boolean) {
    setBusyUser(userId);
    try {
      if (approve) await approveUser({ userId });
      else await revokeUser({ userId });
      toast.success(approve ? "Account approved." : "Account access revoked.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not change account access.");
    } finally {
      setBusyUser(null);
    }
  }

  const now = new Date();
  const currentTime = now.getTime();
  if (authLoading || overview === undefined) return <main className="flex min-h-screen items-center justify-center bg-background"><Loader2 className="size-6 animate-spin text-muted-foreground" /></main>;
  if (overview === null) return <main className="p-8">Administrator access required.</main>;

  return <main className="min-h-screen bg-background p-4 text-foreground sm:p-8">
    <div className="mx-auto max-w-4xl space-y-6">
      <Button variant="ghost" onClick={() => navigate("/dashboard")}><ArrowLeft className="mr-2 size-4" /> Back to Focus Rewards</Button>
      <header><div className="flex items-center gap-3"><ShieldCheck className="size-7 text-primary" /><div><h1 className="text-3xl font-bold tracking-tight">Private beta access</h1><p className="text-muted-foreground">Review accounts and issue recipient-bound invitations.</p></div></div></header>

      <Card><CardHeader><CardTitle>Create an invitation</CardTitle><CardDescription>{overview.invitationsEnabled ? "Codes expire after seven days, can be claimed once, and only work for the email address entered here." : "New invitations are disabled by deployment configuration."}</CardDescription></CardHeader><CardContent className="space-y-4">
        <form onSubmit={(event) => void invite(event)} className="flex flex-col gap-3 sm:flex-row"><Input type="email" required maxLength={254} autoComplete="email" placeholder="friend@example.com" value={email} onChange={(event) => setEmail(event.target.value)} /><Button disabled={busy || !overview.invitationsEnabled}><Ticket className="mr-2 size-4" />{busy ? "Creating…" : "Generate invitation"}</Button></form>
        {invitation && <div className="space-y-2 rounded-md border p-4"><p className="text-sm">Expires {new Date(invitation.expiresAt).toLocaleString()}. This code is shown only once.</p><code className="block break-all rounded bg-muted p-3 text-sm">{invitation.code}</code><Button variant="outline" onClick={() => void copyCode()}><Copy className="mr-2 size-4" />Copy invitation</Button><p className="text-xs text-muted-foreground">Deliver the code privately to the exact email address it was created for. Do not send it in a URL or public channel.</p></div>}
      </CardContent></Card>

      <Card><CardHeader><CardTitle>Accounts</CardTitle><CardDescription>Approval and revocation are enforced by every protected Convex operation.</CardDescription></CardHeader><CardContent className="space-y-3">{overview.users.map((user) => <div key={user.userId} className="flex flex-col gap-3 border-b pb-3 last:border-0 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><p className="truncate font-medium">{user.email ?? user.name ?? "Anonymous account"}</p><p className="text-xs text-muted-foreground">{user.status} · {user.anonymous ? "anonymous" : "email account"}{user.role === "admin" ? " · administrator" : ""}</p></div>{user.role !== "admin" && <div className="flex gap-2">{user.status === "approved" ? <Button variant="destructive" size="sm" disabled={busyUser === user.userId} onClick={() => void changeAccess(user.userId, false)}><UserRoundX className="mr-2 size-4" />Revoke</Button> : <Button size="sm" disabled={busyUser === user.userId || user.anonymous} onClick={() => void changeAccess(user.userId, true)}><UserCheck className="mr-2 size-4" />Approve</Button>}</div>}</div>)}{!overview.users.length && <p className="py-6 text-center text-sm text-muted-foreground">No accounts found.</p>}</CardContent></Card>

      <Card><CardHeader><CardTitle>Outstanding invitations</CardTitle><CardDescription>Codes are stored as hashes; expired and used codes cannot grant access.</CardDescription></CardHeader><CardContent className="space-y-3">{overview.invitations.filter((item) => !item.used && !item.revoked && item.expiresAt > currentTime).map((item) => <div key={item.id} className="flex items-center justify-between gap-3 border-b pb-3 last:border-0"><div className="min-w-0"><p className="truncate font-medium">{item.recipientEmail}</p><p className="text-xs text-muted-foreground">Expires {new Date(item.expiresAt).toLocaleString()}</p></div><Button variant="outline" size="sm" onClick={() => { void revokeInvitation({ invitationId: item.id }).then(() => toast.success("Invitation revoked.")).catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Could not revoke invitation.")); }}><ShieldX className="mr-2 size-4" />Revoke code</Button></div>)}{overview.invitations.every((item) => item.used || item.revoked || item.expiresAt <= currentTime) && <p className="py-6 text-center text-sm text-muted-foreground">No active invitations.</p>}</CardContent></Card>

      <p className="text-xs text-muted-foreground">To disable new invitations or remove the temporary approval requirement, change the server-side Convex deployment variables documented in README.md. Never make these changes in client code.</p>
    </div>
  </main>;
}
