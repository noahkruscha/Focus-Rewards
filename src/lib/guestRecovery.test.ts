import { describe, expect, it, vi } from "vitest";
import {
  GUEST_RECOVERY_STORAGE_KEY,
  continueAsGuestIfNoSavedAccount,
  registerCurrentGuestRecoveryCredential,
  getKnownGuestRecoveryCredential,
  getPendingGuestRecoveryCredential,
  hasKnownGuestOnDevice,
  hasReadyGuestRecoveryCredential,
  recoverGuestAccount,
  saveGuestRecoveryCredential,
} from "./guestRecovery";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

const credential = "a".repeat(43);

describe("guest recovery storage helpers", () => {
  it("does not mistake arbitrary device data for proof of a recoverable guest", () => {
    const storage = memoryStorage();
    storage.setItem("focusRewardsKnownGuestOnDevice", "1");
    expect(hasKnownGuestOnDevice(storage)).toBe(false);
    storage.setItem(GUEST_RECOVERY_STORAGE_KEY, JSON.stringify([{ credential: "not-a-valid-token", createdAt: Date.now(), state: "ready" }]));
    expect(hasKnownGuestOnDevice(storage)).toBe(false);
    expect(getKnownGuestRecoveryCredential(storage)).toBeNull();
  });

  it("continues normally for a browser with no recoverable guest and prompts rather than creating over a saved account", async () => {
    const storage = memoryStorage();
    const signIn = vi.fn().mockResolvedValue({ signingIn: true });
    const beforeSignIn = vi.fn();
    await expect(continueAsGuestIfNoSavedAccount(storage, signIn, beforeSignIn)).resolves.toBe(true);
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(beforeSignIn).toHaveBeenCalledTimes(1);
    saveGuestRecoveryCredential(storage, credential, "ready");
    await expect(continueAsGuestIfNoSavedAccount(storage, signIn, beforeSignIn)).resolves.toBe(false);
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(beforeSignIn).toHaveBeenCalledTimes(1);
    expect(hasReadyGuestRecoveryCredential(storage)).toBe(true);
  });

  it("saves a guest recovery credential only after the backend confirms its link", async () => {
    const storage = memoryStorage();
    const register = vi.fn().mockResolvedValue({ registered: true });
    await registerCurrentGuestRecoveryCredential(storage, register, credential);
    expect(register).toHaveBeenCalledWith({ credential });
    expect(hasKnownGuestOnDevice(storage)).toBe(true);
    expect(hasReadyGuestRecoveryCredential(storage)).toBe(true);
    expect(getKnownGuestRecoveryCredential(storage)).toBe(credential);
  });

  it("does not mark a failed recovery registration ready or overwrite the previous credential", async () => {
    const storage = memoryStorage();
    const firstRegister = vi.fn().mockResolvedValue({ registered: true });
    await registerCurrentGuestRecoveryCredential(storage, firstRegister, credential);
    await expect(registerCurrentGuestRecoveryCredential(storage, vi.fn().mockRejectedValue(new Error("network down")), "b".repeat(43))).rejects.toThrow("network down");
    expect(getKnownGuestRecoveryCredential(storage)).toBe(credential);
    saveGuestRecoveryCredential(storage, credential, "pending");
    expect(getKnownGuestRecoveryCredential(storage)).toBe(credential);
    expect(getPendingGuestRecoveryCredential(storage)).toBe("b".repeat(43));
    expect(hasReadyGuestRecoveryCredential(storage)).toBe(true);
    expect(JSON.parse(storage.getItem(GUEST_RECOVERY_STORAGE_KEY) ?? "[]")).toHaveLength(2);
    const attempts = vi.fn().mockResolvedValue({ signingIn: true });
    await expect(continueAsGuestIfNoSavedAccount(storage, attempts)).resolves.toBe(false);
    expect(attempts).not.toHaveBeenCalled();
  });

  it("preserves an unconfirmed credential after network failure so it can recover a possibly-created guest", async () => {
    const storage = memoryStorage();
    const beforeSignIn = vi.fn(() => saveGuestRecoveryCredential(storage, credential, "pending"));
    const signIn = vi.fn().mockRejectedValue(new Error("network down"));
    await expect(continueAsGuestIfNoSavedAccount(storage, signIn, beforeSignIn)).rejects.toThrow(/could not be confirmed/);
    expect(hasKnownGuestOnDevice(storage)).toBe(true);
    expect(hasReadyGuestRecoveryCredential(storage)).toBe(false);
    expect(getPendingGuestRecoveryCredential(storage)).toBe(credential);
    await recoverGuestAccount(storage, vi.fn().mockResolvedValue({ signingIn: true }));
    expect(getKnownGuestRecoveryCredential(storage)).toBe(credential);
  });

  it("restores only with a saved credential and preserves it if recovery fails", async () => {
    const storage = memoryStorage();
    await registerCurrentGuestRecoveryCredential(storage, vi.fn().mockResolvedValue({ registered: true }), credential);
    const signIn = vi.fn().mockResolvedValue({ signingIn: true });
    await recoverGuestAccount(storage, signIn);
    expect(signIn).toHaveBeenCalledWith("guest-recovery", { mode: "recover", recoveryCredential: credential });
    await expect(recoverGuestAccount(storage, vi.fn().mockResolvedValue({ signingIn: false }))).rejects.toThrow(/could not be restored/);
    expect(getKnownGuestRecoveryCredential(storage)).toBe(credential);
    const secondStorage = memoryStorage();
    saveGuestRecoveryCredential(secondStorage, credential, "pending");
    saveGuestRecoveryCredential(secondStorage, "b".repeat(43), "ready");
    const secondSignIn = vi.fn().mockResolvedValue({ signingIn: true });
    await recoverGuestAccount(secondStorage, secondSignIn);
    expect(secondSignIn).toHaveBeenCalledWith("guest-recovery", { mode: "recover", recoveryCredential: "b".repeat(43) });
    await expect(recoverGuestAccount(memoryStorage(), signIn)).rejects.toThrow(/No recoverable guest credential/);
  });

  it("rejects malformed credentials before registering them", async () => {
    const register = vi.fn();
    await expect(registerCurrentGuestRecoveryCredential(memoryStorage(), register, "bad")).rejects.toThrow(/Invalid guest recovery credential/);
    expect(register).not.toHaveBeenCalled();
  });
});
