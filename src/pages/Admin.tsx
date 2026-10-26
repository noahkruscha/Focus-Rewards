import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAction, useMutation, useQuery } from "convex/react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import { ArrowLeft, Copy, Loader2, Search, ShieldCheck, ShieldX, Ticket, UserCheck, UserRoundX } from "lucide-react";
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
  const [expiresAtInput, setExpiresAtInput] = useState("");
  const [invitation, setInvitation] = useState<{ code: string; expiresAt: number; recipientEmail: string } | null>(null);
  const [userFilter, setUserFilter] = useState<"all" | "pending" | "approved" | "revoked">("all");
  const [userSearch, setUserSearch] = useState("");
  const [invitationNotice, setInvitationNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyUser, setBusyUser] = useState<string | null>(null);

  async function invite(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      const recipient = email.trim().toLowerCase();
      const result = await createInvitation({ recipientEmail: recipient, expiresAt: expiresAtInput ? new Date(expiresAtInput).getTime() : undefined });
      setInvitation({ ...result, recipientEmail: recipient });
      setInvitationNotice("Invitation code generated. Copy it now; it will not be shown again.");
      toast.success("Single-use invitation created. Copy it now; it will not be shown again.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create invitation.");
    } finally {
      setBusy(false);
    }
  }

  async function copyCode() {
    if (!invitation) return;
    try {
      await navigator.clipboard.writeText(invitation.code);
      setInvitationNotice("Invitation copied to clipboard.");
      toast.success("Invitation copied. Share it privately only with its named recipient.");
    } catch {
      setInvitationNotice("Clipboard access failed. Select and copy the code manually.");
      toast.error("Could not access clipboard.");
    }
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

  const normalizedSearch = userSearch.trim().toLowerCase();
  const filteredUsers = useMemo(() => overview?.users.filter((user) =>
    (userFilter === "all" || user.status === userFilter) &&
    `${user.name ?? ""} ${user.email ?? ""}`.toLowerCase().includes(normalizedSearch),
  ) ?? [], [overview?.users, userFilter, normalizedSearch]);
  if (authLoading || overview === undefined) return <main className="flex min-h-screen items-center justify-center bg-background"><Loader2 className="size-6 animate-spin text-muted-foreground" /></main>;
  if (overview === null) return <main className="p-8">Administrator access required.</main>;

  return <main className="min-h-screen bg-background p-4 text-foreground sm:p-8">
    <div className="mx-auto max-w-4xl space-y-6">
      <Button variant="ghost" onClick={() => navigate("/dashboard")}><ArrowLeft className="mr-2 size-4" /> Back to Focus Rewards</Button>
      <header><div className="flex items-center gap-3"><ShieldCheck className="size-7 text-primary" /><div><h1 className="text-3xl font-bold tracking-tight">Private beta access</h1><p className="text-muted-foreground">Review accounts and issue recipient-bound invitations.</p></div></div></header>

      <section aria-labelledby="invitation-codes-heading" className="space-y-4">
        <header><h2 id="invitation-codes-heading" className="text-2xl font-semibold tracking-tight">Invitation Codes</h2><p className="text-sm text-muted-foreground">Invite an exact verified email, or approve someone manually under User Access. Codes can be used once.</p></header>
        <Card><CardHeader><CardTitle>Create an invitation code</CardTitle><CardDescription>{overview.invitationsEnabled ? "Codes have 192 bits of randomness, are stored only as hashes, and expire within 90 days." : "New invitations are disabled by deployment configuration."}</CardDescription></CardHeader><CardContent className="space-y-4">
          <form onSubmit={(event) => void invite(event)} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]"><label className="grid gap-1 text-sm">Recipient email<Input type="email" required maxLength={254} autoComplete="email" placeholder="friend@example.com" value={email} onChange={(event) => setEmail(event.target.value)} /></label><label className="grid gap-1 text-sm">Expires on<Input type="datetime-local" value={expiresAtInput} onChange={(event) => setExpiresAtInput(event.target.value)} /></label><Button className="self-end" disabled={busy || !overview.invitationsEnabled}><Ticket className="size-4" />{busy ? "Generating…" : "Generate code"}</Button></form>
          <p className="text-sm text-muted-foreground" aria-live="polite">Available: {overview.invitationCounts.available} · Redeemed: {overview.invitationCounts.redeemed}</p>
          {invitation && <div className="space-y-2 rounded-md border p-4"><p className="text-sm">Generated code · expires {new Date(invitation.expiresAt).toLocaleString()}. It is shown only once.</p><code className="block break-all rounded bg-muted p-3 text-base tracking-wider">{invitation.code}</code><Button type="button" variant="outline" onClick={() => void copyCode()}><Copy className="size-4" />Copy code</Button><p className="text-xs text-muted-foreground">Share privately with {invitation.recipientEmail}; do not place it in a URL or public channel.</p><p className="text-xs" aria-live="polite">{invitationNotice}</p></div>}
        </CardContent></Card>
        <Card><CardHeader><CardTitle>All invitation codes</CardTitle><CardDescription>Only masked code labels and invitation metadata are returned. Code hashes are never sent to the browser.</CardDescription></CardHeader><CardContent className="space-y-3">
          {!overview.invitations.length ? <p className="py-6 text-center text-sm text-muted-foreground">No invitation codes have been created.</p> : overview.invitations.map((item) => <div key={item.id} className="grid gap-2 border-b pb-3 last:border-0 sm:grid-cols-[1fr_auto] sm:items-center"><div className="min-w-0"><p className="font-medium">{item.codeLabel} · {item.recipientEmail}</p><p className="text-xs text-muted-foreground">Created {new Date(item.createdAt).toLocaleString()} · {item.status}{item.redeemedBy ? ` · Redeemed by ${item.redeemedBy.name ?? item.redeemedBy.email ?? "account"}` : ""}{item.usedAt ? ` on ${new Date(item.usedAt).toLocaleString()}` : ""}</p></div>{item.status === "available" && <Button type="button" variant="outline" size="sm" onClick={() => { void revokeInvitation({ invitationId: item.id }).then(() => toast.success("Invitation code revoked.")).catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Could not revoke invitation.")); }}><ShieldX className="size-4" />Revoke code</Button>}</div>)}
        </CardContent></Card>
      </section>

      <section aria-labelledby="user-access-heading" className="space-y-4"><header><h2 id="user-access-heading" className="text-2xl font-semibold tracking-tight">User Access</h2><p className="text-sm text-muted-foreground">Invitations and manual review both grant beta access, but invitations never assign administrator privileges.</p></header>
      <Card><CardHeader><CardTitle>Accounts</CardTitle><CardDescription>Approval and revocation are enforced by every protected Convex operation.</CardDescription></CardHeader><CardContent className="space-y-3"><div className="grid gap-3 sm:grid-cols-[1fr_auto]"><label className="relative grid gap-1 text-sm">Search name or email<span className="relative"><Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input className="pl-9" value={userSearch} onChange={(event) => setUserSearch(event.target.value)} /></span></label><label className="grid gap-1 text-sm">Filter status<select className="h-9 rounded-md border bg-background px-3" value={userFilter} onChange={(event) => setUserFilter(event.target.value as typeof userFilter)}><option value="all">All users</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="revoked">Revoked</option></select></label></div>{filteredUsers.map((user) => <div key={user.userId} className="flex flex-col gap-3 border-b py-3 last:border-0 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><p className="truncate font-medium">{user.name ?? "Name not set"} · {user.email ?? "No email"}</p><p className="text-xs text-muted-foreground">{user.status} · Created {new Date(user.createdAt).toLocaleDateString()}{user.requestedAt ? ` · Requested ${new Date(user.requestedAt).toLocaleDateString()}` : ""}{user.approvedAt ? ` · Approved ${new Date(user.approvedAt).toLocaleDateString()}` : ""}{user.updatedAt ? ` · Updated ${new Date(user.updatedAt).toLocaleDateString()}` : ""}{user.invited ? ` · Invitation ${user.invitationCodeLabel ?? "redeemed"}` : " · Manual or pending workflow"}{user.role === "admin" ? " · administrator" : ""}</p></div>{user.role !== "admin" && <div className="flex gap-2">{user.status === "approved" ? <Button variant="destructive" size="sm" disabled={busyUser === user.userId} onClick={() => void changeAccess(user.userId, false)}><UserRoundX className="mr-2 size-4" />Revoke</Button> : <Button size="sm" disabled={busyUser === user.userId || user.anonymous} onClick={() => void changeAccess(user.userId, true)}><UserCheck className="mr-2 size-4" />Approve</Button>}</div>}</div>)}{!filteredUsers.length && <p className="py-6 text-center text-sm text-muted-foreground">No users match this filter.</p>}</CardContent></Card></section>

      <p className="text-xs text-muted-foreground">To disable new invitations or remove the temporary approval requirement, change the server-side Convex deployment variables documented in README.md. Never make these changes in client code.</p>
    </div>
  </main>;
}
