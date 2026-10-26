import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@/components/ui/input-otp";

import { useAuth } from "@/hooks/use-auth";
import { api } from "@/convex/_generated/api";
import { useMutation, useQuery } from "convex/react";
import { ArrowRight, Coins, Loader2, LockKeyhole, Mail, UserX, Zap, Ticket } from "lucide-react";
import { Suspense, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { continueAsGuestIfNoSavedAccount, createGuestRecoveryCredential, getPendingGuestRecoveryCredential, hasKnownGuestOnDevice, recoverGuestAccount, saveGuestRecoveryCredential } from "@/lib/guestRecovery";

interface AuthProps {
  redirectAfterAuth?: string;
}

function resolveRedirectAfterAuth(
  returnTo: string | null,
  fallback = "/dashboard",
) {
  if (returnTo?.startsWith("/") && !returnTo.startsWith("//")) {
    return returnTo;
  }
  return fallback;
}

function Auth({ redirectAfterAuth }: AuthProps = {}) {
  const { isLoading: authLoading, isAuthenticated, signIn } = useAuth();
  const validateInvitation = useMutation(api.access.validateInvitation);
  const claimInvitation = useMutation(api.access.claimInvitation);
  const registerGuestRecovery = useMutation(api.access.registerGuestRecoveryCredential);
  const authStatus = useQuery(api.access.status, isAuthenticated ? {} : "skip");
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = resolveRedirectAfterAuth(
    searchParams.get("returnTo"),
    redirectAfterAuth,
  );
  const [step, setStep] = useState<"signIn" | { email: string }>("signIn");
  const [signupMode, setSignupMode] = useState(false);
  const [invitationCode, setInvitationCode] = useState("");
  const [pendingInvitationCode, setPendingInvitationCode] = useState<string | null>(null);
  const invitationClaimRef = useRef<Promise<unknown> | null>(null);
  const [otp, setOtp] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guestChoiceOpen, setGuestChoiceOpen] = useState(false);
  const [newGuestConfirmationOpen, setNewGuestConfirmationOpen] = useState(false);
  const [guestRecoveryError, setGuestRecoveryError] = useState<string | null>(null);
  const [guestRecoveryPending, setGuestRecoveryPending] = useState(false);
  const [guestRecoveryRetry, setGuestRecoveryRetry] = useState(0);
  const guestAttemptRef = useRef(false);
  const guestSignInInProgressRef = useRef(false);

  useEffect(() => {
    if (!authLoading && isAuthenticated && !pendingInvitationCode && !guestRecoveryPending) {
      navigate(redirect);
    }
  }, [authLoading, guestRecoveryPending, isAuthenticated, navigate, pendingInvitationCode, redirect]);

  useEffect(() => {
    if (!isAuthenticated || !pendingInvitationCode) return;
    let cancelled = false;
    invitationClaimRef.current ??= claimInvitation({ code: pendingInvitationCode });
    void invitationClaimRef.current.then(() => {
      if (!cancelled) navigate(redirect, { replace: true });
    }).catch((claimError: unknown) => {
      if (cancelled) return;
      const message = claimError instanceof Error ? claimError.message : "The invitation could not be claimed.";
      setError(message);
      toast.error(message);
      setPendingInvitationCode(null);
      invitationClaimRef.current = null;
      navigate(redirect, { replace: true });
    });
    return () => { cancelled = true; };
  }, [claimInvitation, isAuthenticated, navigate, pendingInvitationCode, redirect]);
  const handleEmailSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      const formData = new FormData(event.currentTarget);
      const email = String(formData.get("email") ?? "").trim().toLowerCase();
      formData.set("email", email);
      if (signupMode) {
        const result = await validateInvitation({ code: invitationCode, email });
        if (!result.valid) throw new Error("That invitation is invalid, expired, revoked, used, or intended for another email.");
        setPendingInvitationCode(invitationCode.trim());
      }
      await signIn("email-otp", formData);
      setStep({ email });
      setIsLoading(false);
    } catch (error) {
      setPendingInvitationCode(null);
      setError(
        error instanceof Error
          ? error.message
          : "Failed to send verification code. Please try again.",
      );
      setIsLoading(false);
    }
  };

  const handleOtpSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      const formData = new FormData(event.currentTarget);
      await signIn("email-otp", formData);
      if (!pendingInvitationCode) navigate(redirect);
    } catch (error) {
      // Keep the invitation in memory so an incorrect OTP attempt can be retried.
      // It is only claimed after Convex Auth establishes the verified session.
      setError(error instanceof Error ? error.message : "The verification code you entered is incorrect.");
      setIsLoading(false);

      setOtp("");
    }
  };

  const handleGuestLogin = async () => {
    if (guestAttemptRef.current) return;
    guestAttemptRef.current = true;
    setIsLoading(true);
    setError(null);
    setGuestRecoveryError(null);
    try {
      if (isAuthenticated || hasKnownGuestOnDevice(window.localStorage)) {
        setGuestChoiceOpen(true);
        return;
      }
      setGuestRecoveryPending(true);
      guestSignInInProgressRef.current = true;
      const created = await continueAsGuestIfNoSavedAccount(window.localStorage, signIn, () => {
        saveGuestRecoveryCredential(window.localStorage, createGuestRecoveryCredential(), "pending");
      });
      guestSignInInProgressRef.current = false;
      if (created) setGuestRecoveryRetry((retry) => retry + 1);
      else setGuestRecoveryPending(false);
    } catch (error) {
      guestSignInInProgressRef.current = false;
      if (getPendingGuestRecoveryCredential(window.localStorage)) {
        setGuestRecoveryError(error instanceof Error ? error.message : "Guest sign-in could not be confirmed. Recover the account or retry before creating another.");
        setGuestChoiceOpen(true);
      } else {
        setGuestRecoveryPending(false);
        setError(`Unable to continue as a guest: ${error instanceof Error ? error.message : "Please try again."}`);
      }
    } finally {
      guestAttemptRef.current = false;
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (!isAuthenticated || !authStatus?.guestAccount || guestSignInInProgressRef.current) return;
    const credential = getPendingGuestRecoveryCredential(window.localStorage);
    if (!credential) return;
    let cancelled = false;
    void registerGuestRecovery({ credential }).then(() => {
      if (!cancelled) {
        saveGuestRecoveryCredential(window.localStorage, credential, "ready");
        setGuestRecoveryPending(false);
        setGuestRecoveryError(null);
        setGuestRecoveryRetry(0);
      }
    }).catch(() => {
      if (!cancelled) {
        setGuestRecoveryPending(true);
        setGuestRecoveryError("Guest sign-in succeeded, but its recovery credential could not be saved. Do not sign out until you retry.");
      }
    });
    return () => { cancelled = true; };
  }, [authStatus?.guestAccount, guestRecoveryRetry, isAuthenticated, registerGuestRecovery]);

  const handleRecoverGuest = async () => {
    if (guestAttemptRef.current) return;
    guestAttemptRef.current = true;
    setIsLoading(true);
    setGuestRecoveryError(null);
    try {
      await recoverGuestAccount(window.localStorage, signIn);
      setGuestChoiceOpen(false);
      navigate(redirect, { replace: true });
    } catch (recoveryError) {
      setGuestRecoveryError(recoveryError instanceof Error ? recoveryError.message : "The existing account could not be restored.");
    } finally {
      guestAttemptRef.current = false;
      setIsLoading(false);
    }
  };

  const handleCreateSeparateGuest = async () => {
    if (guestAttemptRef.current) return;
    guestAttemptRef.current = true;
    setIsLoading(true);
    setGuestRecoveryError(null);
    const credential = createGuestRecoveryCredential();
    setGuestRecoveryPending(true);
    guestSignInInProgressRef.current = true;
    try {
      saveGuestRecoveryCredential(window.localStorage, credential, "pending");
      const result = await signIn("anonymous", {});
      if (!result.signingIn) throw new Error("Guest sign-in did not establish an authenticated session.");
      guestSignInInProgressRef.current = false;
      setGuestRecoveryRetry((retry) => retry + 1);
      setNewGuestConfirmationOpen(false);
      setGuestChoiceOpen(false);
    } catch (createError) {
      guestSignInInProgressRef.current = false;
      setGuestRecoveryPending(false);
      setGuestRecoveryError(createError instanceof Error ? createError.message : "A new account could not be created.");
      setNewGuestConfirmationOpen(false);
      setGuestChoiceOpen(true);
    } finally {
      guestAttemptRef.current = false;
      setIsLoading(false);
    }
  };

  return (
    <div className="auth-shell">
      <a className="auth-brand" href="/" aria-label="Focus Rewards home"><span className="brand-mark"><Zap size={16} fill="currentColor" /></span> Focus Rewards<span className="brand-period">.</span></a>
      <div className="auth-stage">
        <div className="auth-aside"><span className="auth-aside-icon"><Coins size={20} /></span><span className="landing-eyebrow"><i /> A PERSONAL REWARD SYSTEM</span><h1>Focus on what matters.<br /><span>Enjoy what you earn.</span></h1><p>Sign in to keep your focus sessions, tasks and reward wallet together in your own space.</p><div className="auth-aside-note"><LockKeyhole size={14} /> Your activity is saved privately on this device.</div></div>
        <Card className="auth-card">

          {step === "signIn" ? (
            <>              <CardHeader className="text-center">
                <div className="flex justify-center">
                  <span className="auth-card-mark"><Zap size={17} fill="currentColor" /></span>
                </div>
                <CardTitle className="text-xl">Welcome to Focus Rewards</CardTitle>
                <CardDescription>
                  Enter your email to sign in or create your personal space.
                </CardDescription>
                <Button type="button" variant="link" className="mt-2 h-auto" onClick={() => { setSignupMode((value) => !value); setError(null); }}>
                  <Ticket className="mr-1 size-4" />{signupMode ? "Sign in without an invitation" : "Sign up with an invitation code"}
                </Button>
              </CardHeader>
              <form onSubmit={handleEmailSubmit}>
                <CardContent>
                  {signupMode && <label className="mb-3 grid gap-1 text-sm font-medium" htmlFor="signup-invitation-code">Invitation code<Input id="signup-invitation-code" autoComplete="off" value={invitationCode} onChange={(event) => setInvitationCode(event.target.value)} placeholder="Paste your invitation code" minLength={32} maxLength={64} required disabled={isLoading} /></label>}
                  <div className="relative flex items-center gap-2">
                    <div className="relative flex-1">
                      <Mail className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                      <Input
                        name="email"
                        placeholder="name@example.com"
                        type="email"
                        className="pl-9"
                        disabled={isLoading}
                        required
                      />
                    </div>
                    <Button
                      type="submit"
                      variant="outline"
                      size="icon"
                      disabled={isLoading}
                    >
                      {isLoading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <ArrowRight className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                  {error && (
                    <p className="mt-2 text-sm text-red-500">{error}</p>
                  )}
                  {guestRecoveryPending && <p className="mt-2 text-sm text-amber-500">The new guest account is being secured for recovery before continuing.</p>}
                  {isAuthenticated && authStatus?.guestAccount && guestRecoveryPending && <div role="alert" className="mt-2 text-sm text-destructive">{guestRecoveryError || "Guest account recovery is being secured."}<Button type="button" variant="link" disabled={isLoading} onClick={() => setGuestRecoveryRetry((retry) => retry + 1)}>Retry</Button></div>}
                  {guestRecoveryError && !isAuthenticated && <p role="alert" className="mt-2 text-sm text-destructive">{guestRecoveryError}</p>}
                  
                  <div className="mt-4">
                    <div className="relative">
                      <div className="absolute inset-0 flex items-center">
                        <span className="w-full border-t" />
                      </div>
                      <div className="relative flex justify-center text-xs uppercase">
                        <span className="bg-background px-2 text-muted-foreground">
                          Or
                        </span>
                      </div>
                    </div>
                    
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full mt-4"
                      onClick={handleGuestLogin}
                      disabled={isLoading}
                    >
                      <UserX className="mr-2 h-4 w-4" />
                      Continue without an email
                    </Button>
                  </div>
                </CardContent>
              </form>
            </>
          ) : (
            <>
              <CardHeader className="text-center mt-4">
                <CardTitle>Check your inbox</CardTitle>
                <CardDescription>
                  Enter the sign-in code we sent to {step.email}.
                </CardDescription>
              </CardHeader>
              <form onSubmit={handleOtpSubmit}>
                <CardContent className="pb-4">
                  <input type="hidden" name="email" value={step.email} />
                  <input type="hidden" name="code" value={otp} />

                  <div className="flex justify-center">
                    <InputOTP
                      value={otp}
                      onChange={setOtp}
                      maxLength={6}
                      disabled={isLoading}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && otp.length === 6 && !isLoading) {
                          // Find the closest form and submit it
                          const form = (e.target as HTMLElement).closest("form");
                          if (form) {
                            form.requestSubmit();
                          }
                        }
                      }}
                    >
                      <InputOTPGroup>
                        {Array.from({ length: 6 }).map((_, index) => (
                          <InputOTPSlot key={index} index={index} />
                        ))}
                      </InputOTPGroup>
                    </InputOTP>
                  </div>
                  {error && (
                    <p className="mt-2 text-sm text-red-500 text-center">
                      {error}
                    </p>
                  )}
                  <p className="text-sm text-muted-foreground text-center mt-4">
                    Didn't receive a code?{" "}
                    <Button
                      variant="link"
                      className="p-0 h-auto"
                      type="button"
                      onClick={() => { setPendingInvitationCode(null); invitationClaimRef.current = null; setStep("signIn"); setOtp(""); setError(null); }}
                    >
                      Try again
                    </Button>
                  </p>
                </CardContent>
                <CardFooter className="flex-col gap-2">
                  <Button
                    type="submit"
                    className="w-full"
                    disabled={isLoading || otp.length !== 6}
                  >
                    {isLoading ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Verifying...
                      </>
                    ) : (
                      <>
                        Verify code
                        <ArrowRight className="ml-2 h-4 w-4" />
                      </>
                    )}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => { setPendingInvitationCode(null); invitationClaimRef.current = null; setStep("signIn"); }}
                    disabled={isLoading}
                    className="w-full"
                  >
                    Use different email
                  </Button>
                </CardFooter>
              </form>
            </>
          )}

          <div className="auth-card-foot"><LockKeyhole size={12} /> Your account is secured with email verification.</div>
        </Card>
      </div>
      <AlertDialog open={guestChoiceOpen} onOpenChange={(open) => { if (!isLoading) setGuestChoiceOpen(open); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>An account is already saved in this browser</AlertDialogTitle>
            <AlertDialogDescription>Choose whether to restore the account linked to its saved recovery credential or deliberately create a separate account. Existing coins, sessions, rewards, and beta approval will not be moved or deleted.</AlertDialogDescription>
          </AlertDialogHeader>
          {guestRecoveryError && <p role="alert" className="text-sm text-destructive">{guestRecoveryError}</p>}
          {guestRecoveryPending && isAuthenticated && authStatus?.guestAccount && <Button type="button" variant="link" disabled={isLoading} onClick={() => setGuestRecoveryRetry((retry) => retry + 1)}>Retry saving guest account recovery</Button>}
          {!isAuthenticated && guestRecoveryPending && <Button type="button" variant="link" disabled={isLoading} onClick={() => { setGuestChoiceOpen(false); void handleGuestLogin(); }}>Retry guest sign-in with recovery</Button>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isLoading}>Cancel</AlertDialogCancel>
            <Button type="button" variant="outline" disabled={isLoading} onClick={() => setNewGuestConfirmationOpen(true)}>Create a new account</Button>
            <Button type="button" disabled={isLoading} onClick={() => void handleRecoverGuest()}>{isLoading ? <Loader2 className="size-4 animate-spin" /> : "Continue with existing account"}</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={newGuestConfirmationOpen} onOpenChange={(open) => { if (!isLoading) setNewGuestConfirmationOpen(open); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Create a separate Focus Rewards account?</AlertDialogTitle>
            <AlertDialogDescription>This creates a new guest account with separate data. Your existing account and its approval status remain unchanged. You can recover the new account only while its recovery credential stays saved in this browser.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isLoading}>Go back</AlertDialogCancel>
            <Button type="button" disabled={isLoading} onClick={() => void handleCreateSeparateGuest()}>{isLoading ? <Loader2 className="size-4 animate-spin" /> : "Confirm new account"}</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <footer className="auth-footer">FOCUS FIRST <i /> ENJOY IT AFTER</footer>
    </div>
  );
}

export default function AuthPage(props: AuthProps) {
  return (
    <Suspense>
      <Auth {...props} />
    </Suspense>
  );
}
