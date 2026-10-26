export const GUEST_RECOVERY_STORAGE_KEY = "focusRewardsGuestRecoveryCredentials";

export type GuestRecoveryEntry = {
  credential: string;
  createdAt: number;
  state: "pending" | "ready";
};

export type GuestSignIn = (
  provider: string,
  params: Record<string, string>,
) => Promise<{ signingIn: boolean }>;

export type RegisterGuestRecovery = (args: { credential: string }) => Promise<{ registered: boolean }>;

const CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function readGuestRecoveryCredentials(storage: Pick<Storage, "getItem">): GuestRecoveryEntry[] {
  const raw = storage.getItem(GUEST_RECOVERY_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const valid = parsed.filter((entry): entry is GuestRecoveryEntry =>
      typeof entry === "object" && entry !== null
      && "credential" in entry && typeof entry.credential === "string" && CREDENTIAL_PATTERN.test(entry.credential)
      && "createdAt" in entry && typeof entry.createdAt === "number" && Number.isSafeInteger(entry.createdAt)
      && "state" in entry && (entry.state === "pending" || entry.state === "ready"),
    );
    return [...new Map(valid.map((entry) => [entry.credential, entry])).values()];
  } catch {
    return [];
  }
}

export function saveGuestRecoveryCredential(
  storage: Pick<Storage, "getItem" | "setItem">,
  credential: string,
  state: GuestRecoveryEntry["state"],
): GuestRecoveryEntry[] {
  if (!CREDENTIAL_PATTERN.test(credential)) throw new Error("Invalid guest recovery credential.");
  const previous = readGuestRecoveryCredentials(storage);
  const existing = previous.find((entry) => entry.credential === credential);
  if (state === "pending" && existing?.state === "ready") return previous;
  const entry: GuestRecoveryEntry = { credential, createdAt: existing?.createdAt ?? Date.now(), state };
  const next = [...previous.filter((item) => item.credential !== credential), entry];
  storage.setItem(GUEST_RECOVERY_STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function createGuestRecoveryCredential(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Presence only prompts for a choice; the server-checked credential authenticates recovery. */
export function hasKnownGuestOnDevice(storage: Pick<Storage, "getItem">): boolean {
  return readGuestRecoveryCredentials(storage).length > 0;
}

export function getKnownGuestRecoveryCredential(storage: Pick<Storage, "getItem">): string | null {
  const entries = readGuestRecoveryCredentials(storage);
  return [...entries].reverse().find((entry) => entry.state === "ready")?.credential ?? null;
}

export function hasReadyGuestRecoveryCredential(storage: Pick<Storage, "getItem">): boolean {
  return readGuestRecoveryCredentials(storage).some((entry) => entry.state === "ready");
}

export function getPendingGuestRecoveryCredential(storage: Pick<Storage, "getItem">): string | null {
  const entries = readGuestRecoveryCredentials(storage);
  return [...entries].reverse().find((entry) => entry.state === "pending")?.credential ?? null;
}

export async function continueAsGuestIfNoSavedAccount(
  storage: Pick<Storage, "getItem" | "setItem">,
  signIn: GuestSignIn,
  beforeSignIn?: () => void,
): Promise<boolean> {
  if (hasKnownGuestOnDevice(storage)) return false;
  beforeSignIn?.();
  try {
    const result = await signIn("anonymous", {});
    if (!result.signingIn) throw new Error("Guest sign-in did not establish an authenticated session.");
    return true;
  } catch {
    // The request may have reached the server even if its response was lost.
    // Keep the pending credential so retry can recover instead of creating anew.
    throw new Error("Guest sign-in could not be confirmed. Try again or recover this account using its saved recovery code.");
  }
}

export async function registerCurrentGuestRecoveryCredential(
  storage: Pick<Storage, "getItem" | "setItem">,
  registerRecovery: RegisterGuestRecovery,
  credential = createGuestRecoveryCredential(),
): Promise<void> {
  if (!CREDENTIAL_PATTERN.test(credential)) throw new Error("Invalid guest recovery credential.");
  saveGuestRecoveryCredential(storage, credential, "pending");
  const registration = await registerRecovery({ credential });
  if (!registration.registered) throw new Error("A recovery credential could not be linked to this guest account.");
  saveGuestRecoveryCredential(storage, credential, "ready");
}

export async function recoverGuestAccount(
  storage: Pick<Storage, "getItem" | "setItem">,
  signIn: GuestSignIn,
): Promise<void> {
  const entries = readGuestRecoveryCredentials(storage);
  const credential = [...entries].reverse().find((entry) => entry.state === "ready")?.credential
    ?? [...entries].reverse().find((entry) => entry.state === "pending")?.credential
    ?? null;
  if (!credential) throw new Error("No recoverable guest credential is saved in this browser.");
  const result = await signIn("guest-recovery", { mode: "recover", recoveryCredential: credential });
  if (!result.signingIn) throw new Error("This guest account could not be restored with the saved credential.");
  saveGuestRecoveryCredential(storage, credential, "ready");
}
