export const LEGACY_DATA_KEY = "momentum-v1";
export const LEGACY_BACKUP_KEY = "momentum-v1-migration-backup";

export type LegacySnapshot = {
  coins: number; dailyCap: number; taskBonus: number;
  sessions: Array<{ id: string; activity: string; minutes: number; coins: number; finishedAt: number }>;
  tasks: Array<{ id: string; title: string; completed: boolean; completedAt: number | null; rewardCoins: number; bonusAwarded?: boolean }>;
  taskRewards: Array<{ taskId: string; title: string; coins: number; awardedAt: number }>;
  videoUnlocks: Array<{ videoId: string; unlockedAt: number; cost: number }>;
};
export type MigrationPreview = { snapshot: LegacySnapshot; snapshotHash: string; eventNet: number; reconcileCoins: number; consistent: boolean; warnings: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const LEGACY_REWARD_PRICES: Record<string, number> = {
  "quiet-morning": 24,
  "studio-sessions": 32,
  "deep-work": 20,
  "soft-focus": 28,
  "paper-garden": 16,
  "ocean-breath": 26,
};

function validTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= Date.now() + 5 * 60_000;
}

function requireUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label} found; the original data has been kept for manual review.`);
}

export function parseLegacySnapshot(raw: string): LegacySnapshot {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)) throw new Error("Legacy Focus Rewards data is not a JSON object.");
  const { coins, dailyCap, taskBonus } = value;
  if (!Number.isSafeInteger(coins) || Number(coins) < 0) throw new Error("Legacy coin balance is invalid; your original data has been kept.");
  if (!Number.isInteger(dailyCap) || Number(dailyCap) < 1 || Number(dailyCap) > 500) throw new Error("Legacy daily cap is invalid; your original data has been kept.");
  if (!Number.isInteger(taskBonus) || Number(taskBonus) < 0 || Number(taskBonus) > 100) throw new Error("Legacy task bonus is invalid; your original data has been kept.");
  const sessions = Array.isArray(value.sessions) ? value.sessions : [];
  const tasks = Array.isArray(value.tasks) ? value.tasks : [];
  const taskRewards = Array.isArray(value.taskRewards) ? value.taskRewards : [];
  const videoUnlocks = Array.isArray(value.videoUnlocks) ? value.videoUnlocks : [];
  if (sessions.length > 5000 || tasks.length > 1000 || taskRewards.length > 5000 || videoUnlocks.length > 1000) throw new Error("Saved data exceeds safe migration limits; export it for manual review.");
  const validSessions = sessions.filter((item): item is LegacySnapshot["sessions"][number] =>
    isRecord(item) && typeof item.id === "string" && item.id.length > 0 && item.id.length <= 200 &&
    ["Studying", "Reading", "Coding"].includes(String(item.activity)) && Number.isSafeInteger(item.minutes) && Number(item.minutes) >= 1 && Number(item.minutes) <= 180 &&
    Number.isSafeInteger(item.coins) && Number(item.coins) >= 0 && Number(item.coins) <= 500 && validTimestamp(item.finishedAt),
  );
  const validTasks = tasks.filter((item): item is LegacySnapshot["tasks"][number] =>
    isRecord(item) && typeof item.id === "string" && item.id.length > 0 && item.id.length <= 200 &&
    typeof item.title === "string" && item.title.trim().length > 0 && item.title.length <= 100 &&
    typeof item.completed === "boolean" && (item.completedAt === null || validTimestamp(item.completedAt)) &&
    Number.isSafeInteger(item.rewardCoins) && Number(item.rewardCoins) >= 0 && Number(item.rewardCoins) <= 1000 &&
    (item.bonusAwarded === undefined || typeof item.bonusAwarded === "boolean"),
  );
  const validRewards = taskRewards.filter((item): item is LegacySnapshot["taskRewards"][number] =>
    isRecord(item) && typeof item.taskId === "string" && item.taskId.length > 0 && item.taskId.length <= 200 &&
    typeof item.title === "string" && item.title.trim().length > 0 && item.title.length <= 100 &&
    Number.isSafeInteger(item.coins) && Number(item.coins) >= 0 && Number(item.coins) <= 1000 && validTimestamp(item.awardedAt),
  );
  const validUnlocks = videoUnlocks.filter((item): item is LegacySnapshot["videoUnlocks"][number] =>
    isRecord(item) && typeof item.videoId === "string" && Object.prototype.hasOwnProperty.call(LEGACY_REWARD_PRICES, item.videoId) &&
    validTimestamp(item.unlockedAt) && Number.isSafeInteger(item.cost) && item.cost === LEGACY_REWARD_PRICES[item.videoId],
  );
  if (validSessions.length !== sessions.length || validTasks.length !== tasks.length || validRewards.length !== taskRewards.length || validUnlocks.length !== videoUnlocks.length) throw new Error("Some saved history entries are malformed. The original data has been kept; migration needs manual review.");
  requireUnique(validSessions.map((item) => item.id), "session IDs");
  requireUnique(validTasks.map((item) => item.id), "task IDs");
  requireUnique(validRewards.map((item) => item.taskId), "task reward records");
  requireUnique(validUnlocks.map((item) => item.videoId), "reward purchases");
  return { coins: Number(coins), dailyCap: Number(dailyCap), taskBonus: Number(taskBonus), sessions: validSessions, tasks: validTasks, taskRewards: validRewards, videoUnlocks: validUnlocks };
}

export async function previewLegacyMigration(storage: Storage): Promise<MigrationPreview | null> {
  const raw = storage.getItem(LEGACY_DATA_KEY);
  if (!raw) return null;
  const snapshot = parseLegacySnapshot(raw);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  const snapshotHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const taskRewards = snapshot.taskRewards.length ? snapshot.taskRewards : snapshot.tasks.filter((task) => task.completed && task.bonusAwarded).map((task) => ({ taskId: task.id, title: task.title, coins: task.rewardCoins, awardedAt: task.completedAt ?? 0 }));
  const eventNet = snapshot.sessions.reduce((sum, item) => sum + item.coins, 0) + taskRewards.reduce((sum, item) => sum + item.coins, 0) - snapshot.videoUnlocks.reduce((sum, item) => sum + item.cost, 0);
  const reconcileCoins = snapshot.coins - eventNet;
  const warnings: string[] = [];
  if (reconcileCoins !== 0) warnings.push(`Saved balance differs from listed transactions by ${reconcileCoins} coins; a clearly labeled reconciliation is required.`);
  if (reconcileCoins < 0) warnings.push("History exceeds the saved balance. Automatic import is blocked for manual review.");
  const rewardsByTask = new Set(taskRewards.map((reward) => reward.taskId));
  if (snapshot.tasks.some((task) => task.completed && task.bonusAwarded && !rewardsByTask.has(task.id))) warnings.push("A completed task has no matching reward record; it will be imported as completed without a second award.");
  return { snapshot, snapshotHash, eventNet, reconcileCoins, consistent: reconcileCoins === 0, warnings };
}

export function preserveLegacyBackup(storage: Storage, raw: string, snapshotHash: string): void {
  const backup = storage.getItem(LEGACY_BACKUP_KEY);
  if (backup) {
    const parsed: unknown = JSON.parse(backup);
    if (!isRecord(parsed) || parsed.snapshotHash !== snapshotHash) throw new Error("A different legacy backup already exists; export it before continuing.");
    return;
  }
  storage.setItem(LEGACY_BACKUP_KEY, JSON.stringify({ snapshotHash, preservedAt: Date.now(), raw }));
}
