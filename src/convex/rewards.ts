import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

const TASK_REWARD_MAX = 1000;
const MAX_SESSION_MINUTES = 180;
const LEGACY_TRANSACTION_TYPES = {
  focus: "legacy_focus_reward",
  task: "legacy_task_reward",
  purchase: "legacy_library_purchase",
} as const;

async function authenticatedUserId(ctx: QueryCtx | MutationCtx) {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw new ConvexError("Sign in to access your Focus Rewards data.");
  return userId;
}

async function accountFor(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
  return await ctx.db.query("accountData").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
}

async function requireAccount(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
  const account = await accountFor(ctx, userId);
  if (!account) throw new ConvexError("Account data is not initialized.");
  return account;
}

async function recordTransaction(ctx: MutationCtx, args: {
  userId: Id<"users">; amount: number; type: Doc<"walletTransactions">["type"];
  description: string; referenceType?: string; referenceId?: string; idempotencyKey: string; createdAt?: number;
}) {
  if (!Number.isSafeInteger(args.amount) || args.amount === 0 || !args.idempotencyKey.trim()) throw new ConvexError("Invalid wallet transaction.");
  const previous = await ctx.db.query("walletTransactions")
    .withIndex("by_user_idempotency", (q) => q.eq("userId", args.userId).eq("idempotencyKey", args.idempotencyKey)).unique();
  if (previous) return false;
  const account = await requireAccount(ctx, args.userId);
  const nextBalance = account.coins + args.amount;
  if (!Number.isSafeInteger(nextBalance) || nextBalance < 0) throw new ConvexError("Insufficient coins.");
  await ctx.db.patch(account._id, { coins: nextBalance });
  await ctx.db.insert("walletTransactions", { ...args, createdAt: args.createdAt ?? Date.now() });
  return true;
}

export const snapshot = query({
  args: {},
  handler: async (ctx) => {
    const userId = await authenticatedUserId(ctx);
    const account = await accountFor(ctx, userId);
    const [tasks, sessions, purchases, transactions] = await Promise.all([
      ctx.db.query("tasks").withIndex("by_user", (q) => q.eq("userId", userId)).collect(),
      ctx.db.query("focusSessions").withIndex("by_user", (q) => q.eq("userId", userId)).collect(),
      ctx.db.query("libraryPurchases").withIndex("by_user", (q) => q.eq("userId", userId)).collect(),
      ctx.db.query("walletTransactions").withIndex("by_user_time", (q) => q.eq("userId", userId)).order("desc").take(500),
    ]);
    return {
      initialized: Boolean(account), coins: account?.coins ?? 0, dailyCap: account?.dailyCap ?? 120,
      taskBonus: account?.taskBonus ?? 5, migrationCompletedAt: account?.migrationCompletedAt ?? null,
      migrationReport: account?.migrationReport ?? null,
      tasks: tasks.map(({ _id, title, completed, completedAt, rewardCoins, rewardAwarded }) => ({ id: String(_id), title, completed, completedAt, rewardCoins, rewardAwarded: rewardAwarded ?? completed })),
      sessions: sessions.filter((session) => session.status === "complete").map(({ _id, activity, minutes, coins, finishedAt }) => ({ id: String(_id), activity, minutes: minutes ?? 0, coins: coins ?? 0, finishedAt: finishedAt ?? 0 })),
      active: sessions.find((session) => session.status === "active") ?? null,
      videoUnlocks: purchases.map(({ _id, rewardId, purchasedAt, cost }) => ({ id: String(_id), videoId: rewardId, unlockedAt: purchasedAt, cost })),
      transactions: transactions.map(({ _id, amount, type, description, referenceType, referenceId, idempotencyKey, createdAt }) => ({ id: String(_id), amount, type, description, referenceType, referenceId, idempotencyKey, createdAt })),
    };
  },
});

export const initialize = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await authenticatedUserId(ctx);
    const existing = await accountFor(ctx, userId);
    if (existing) return existing._id;
    return await ctx.db.insert("accountData", { userId, coins: 0, dailyCap: 120, taskBonus: 5 });
  },
});

export const setSettings = mutation({
  args: { dailyCap: v.number(), taskBonus: v.number() },
  handler: async (ctx, args) => {
    const userId = await authenticatedUserId(ctx);
    if (!Number.isInteger(args.dailyCap) || args.dailyCap < 1 || args.dailyCap > 500) throw new ConvexError("Daily cap must be between 1 and 500.");
    if (!Number.isInteger(args.taskBonus) || args.taskBonus < 0 || args.taskBonus > 100) throw new ConvexError("Default task reward must be between 0 and 100.");
    const account = await requireAccount(ctx, userId);
    await ctx.db.patch(account._id, { dailyCap: args.dailyCap, taskBonus: args.taskBonus });
  },
});

export const createTask = mutation({
  args: { title: v.string(), rewardCoins: v.number(), idempotencyKey: v.string() },
  handler: async (ctx, args) => {
    const userId = await authenticatedUserId(ctx);
    await requireAccount(ctx, userId);
    const title = args.title.trim();
    if (!title || title.length > 100 || !Number.isInteger(args.rewardCoins) || args.rewardCoins < 0 || args.rewardCoins > TASK_REWARD_MAX || !args.idempotencyKey.trim()) throw new ConvexError("Invalid task details.");
    const existing = await ctx.db.query("tasks").withIndex("by_user_legacy", (q) => q.eq("userId", userId).eq("legacyId", `create:${args.idempotencyKey}`)).unique();
    if (existing) return existing._id;
    return await ctx.db.insert("tasks", { userId, legacyId: `create:${args.idempotencyKey}`, title, rewardCoins: args.rewardCoins, completed: false, completedAt: null });
  },
});

export const editTask = mutation({
  args: { taskId: v.id("tasks"), title: v.string(), rewardCoins: v.number() },
  handler: async (ctx, args) => {
    const userId = await authenticatedUserId(ctx);
    const task = await ctx.db.get(args.taskId);
    if (!task || task.userId !== userId) throw new ConvexError("Task not found.");
    const title = args.title.trim();
    if (task.completed || !title || title.length > 100 || !Number.isInteger(args.rewardCoins) || args.rewardCoins < 0 || args.rewardCoins > TASK_REWARD_MAX) throw new ConvexError("Invalid task update.");
    await ctx.db.patch(task._id, { title, rewardCoins: args.rewardCoins });
  },
});

export const deleteTask = mutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const userId = await authenticatedUserId(ctx);
    const task = await ctx.db.get(args.taskId);
    if (!task || task.userId !== userId) throw new ConvexError("Task not found.");
    if (!task.completed) await ctx.db.delete(task._id);
  },
});

export const completeTask = mutation({
  args: { taskId: v.id("tasks"), idempotencyKey: v.string() },
  handler: async (ctx, args) => {
    const userId = await authenticatedUserId(ctx);
    const task = await ctx.db.get(args.taskId);
    if (!task || task.userId !== userId) throw new ConvexError("Task not found.");
    if (!args.idempotencyKey.trim()) throw new ConvexError("Missing request ID.");
    if (task.completed) return { alreadyCompleted: true };
    const completedAt = Date.now();
    await ctx.db.patch(task._id, { completed: true, completedAt, rewardAwarded: true });
    if (task.rewardCoins > 0) await recordTransaction(ctx, {
      userId, amount: task.rewardCoins, type: "task_reward", description: `Task complete · ${task.title}`,
      referenceType: "task", referenceId: String(task._id), idempotencyKey: `task:${task._id}`,
    });
    return { alreadyCompleted: false };
  },
});

export const startSession = mutation({
  args: { activity: v.string(), durationMinutes: v.number(), startedAt: v.number(), idempotencyKey: v.string() },
  handler: async (ctx, args) => {
    const userId = await authenticatedUserId(ctx);
    await requireAccount(ctx, userId);
    if (!["Studying", "Reading", "Coding"].includes(args.activity) || !Number.isInteger(args.durationMinutes) || args.durationMinutes < 1 || args.durationMinutes > MAX_SESSION_MINUTES || !args.idempotencyKey.trim()) throw new ConvexError("Invalid focus session.");
    const now = Date.now();
    if (!Number.isSafeInteger(args.startedAt) || args.startedAt > now + 5_000 || args.startedAt < now - 30_000) throw new ConvexError("Invalid session start time.");
    const previous = await ctx.db.query("focusSessions").withIndex("by_user_legacy", (q) => q.eq("userId", userId).eq("legacyId", `active:${args.idempotencyKey}`)).unique();
    if (previous) return previous._id;
    const active = await ctx.db.query("focusSessions").withIndex("by_user", (q) => q.eq("userId", userId)).filter((q) => q.eq(q.field("status"), "active")).first();
    if (active) throw new ConvexError("Finish or cancel your active session first.");
    return await ctx.db.insert("focusSessions", { userId, activity: args.activity, durationMinutes: args.durationMinutes, elapsedMs: 0, startedAt: args.startedAt, status: "active", legacyId: `active:${args.idempotencyKey}` });
  },
});

export const updateActiveSession = mutation({
  args: { sessionId: v.id("focusSessions"), elapsedMs: v.number(), startedAt: v.union(v.number(), v.null()), status: v.union(v.literal("active"), v.literal("cancelled")) },
  handler: async (ctx, args) => {
    const userId = await authenticatedUserId(ctx);
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.userId !== userId || session.status !== "active") throw new ConvexError("Active session not found.");
    const now = Date.now();
    const elapsedWindow = session.elapsedMs + (session.startedAt === null ? 0 : Math.max(0, now - session.startedAt));
    if (!Number.isFinite(args.elapsedMs) || args.elapsedMs < session.elapsedMs || args.elapsedMs > Math.min(session.durationMinutes * 60_000, elapsedWindow + 30_000) || (args.startedAt !== null && args.startedAt > now)) throw new ConvexError("Invalid session update.");
    await ctx.db.patch(session._id, { elapsedMs: args.elapsedMs, startedAt: args.startedAt, status: args.status });
  },
});

export const finishSession = mutation({
  args: { sessionId: v.id("focusSessions"), elapsedMs: v.number(), idempotencyKey: v.string() },
  handler: async (ctx, args) => {
    const userId = await authenticatedUserId(ctx);
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.userId !== userId) throw new ConvexError("Session not found.");
    if (session.status === "complete") return { alreadyCompleted: true };
    const elapsedMs = Math.max(session.elapsedMs, args.elapsedMs);
    if (session.status !== "active" || !Number.isFinite(elapsedMs) || elapsedMs < 60_000 || elapsedMs > session.durationMinutes * 60_000 || !args.idempotencyKey.trim()) throw new ConvexError("Session duration is not eligible for a reward.");
    const finishedAt = Date.now();
    const elapsedWindow = session.elapsedMs + (session.startedAt === null ? 0 : Math.max(0, finishedAt - session.startedAt));
    if (elapsedMs > elapsedWindow + 30_000) throw new ConvexError("The recorded focus time exceeds elapsed real time.");
    const minutes = Math.floor(elapsedMs / 60_000);
    const allSessions = await ctx.db.query("focusSessions").withIndex("by_user", (q) => q.eq("userId", userId)).filter((q) => q.eq(q.field("status"), "complete")).collect();
    const todayStart = new Date(finishedAt); todayStart.setHours(0, 0, 0, 0);
    const todaySessions = allSessions.filter((item) => (item.finishedAt ?? 0) >= todayStart.getTime());
    const previousMinutes = todaySessions.reduce((sum, item) => sum + (item.minutes ?? 0), 0);
    const earnedToday = todaySessions.reduce((sum, item) => sum + (item.coins ?? 0), 0);
    const cumulative = (totalMinutes: number) => Math.floor(12 * Math.log1p(Math.max(0, totalMinutes) / 10));
    const account = await requireAccount(ctx, userId);
    const coins = Math.max(0, Math.min(account.dailyCap - earnedToday, cumulative(previousMinutes + minutes) - cumulative(previousMinutes)));
    await ctx.db.patch(session._id, { status: "complete", elapsedMs, startedAt: null, minutes, coins, finishedAt });
    if (coins > 0) await recordTransaction(ctx, {
      userId, amount: coins, type: "focus_reward", description: `${session.activity} focus · ${minutes} min`,
      referenceType: "focusSession", referenceId: String(session._id), idempotencyKey: `focus:${session._id}`,
    });
    return { alreadyCompleted: false, coins, minutes };
  },
});

export const purchaseReward = mutation({
  args: { rewardId: v.string(), cost: v.number(), idempotencyKey: v.string() },
  handler: async (ctx, args) => {
    const userId = await authenticatedUserId(ctx);
    await requireAccount(ctx, userId);
    if (!args.rewardId.trim() || !Number.isSafeInteger(args.cost) || args.cost <= 0 || !args.idempotencyKey.trim()) throw new ConvexError("Invalid reward purchase.");
    const existingRequest = await ctx.db.query("libraryPurchases").withIndex("by_user_idempotency", (q) => q.eq("userId", userId).eq("idempotencyKey", args.idempotencyKey)).unique();
    if (existingRequest) return { alreadyPurchased: true };
    const alreadyBought = await ctx.db.query("libraryPurchases").withIndex("by_user_reward", (q) => q.eq("userId", userId).eq("rewardId", args.rewardId)).unique();
    if (alreadyBought) return { alreadyPurchased: true };
    const catalog: Record<string, number> = { "quiet-morning": 24, "studio-sessions": 32, "deep-work": 20, "soft-focus": 28, "paper-garden": 16, "ocean-breath": 26 };
    if (catalog[args.rewardId] !== args.cost) throw new ConvexError("Unknown reward or price changed.");
    const purchasedAt = Date.now();
    await recordTransaction(ctx, { userId, amount: -args.cost, type: "library_purchase", description: `Reward unlocked · ${args.rewardId}`, referenceType: "reward", referenceId: args.rewardId, idempotencyKey: `purchase:${args.rewardId}`, createdAt: purchasedAt });
    await ctx.db.insert("libraryPurchases", { userId, rewardId: args.rewardId, cost: args.cost, purchasedAt, idempotencyKey: args.idempotencyKey });
    return { alreadyPurchased: false };
  },
});

export const previewLegacyMigration = query({
  args: { migrationKey: v.string() },
  handler: async (ctx, args) => {
    const userId = await authenticatedUserId(ctx);
    if (args.migrationKey !== "momentum-v1") throw new ConvexError("Unsupported migration source.");
    const account = await accountFor(ctx, userId);
    return { alreadyMigrated: Boolean(account?.migrationCompletedAt), currentCoins: account?.coins ?? 0 };
  },
});

export const importLegacyData = mutation({
  args: {
    migrationKey: v.string(), confirmed: v.boolean(), snapshotHash: v.string(), oldBalance: v.number(), dailyCap: v.number(), taskBonus: v.number(), reconcileCoins: v.number(),
    tasks: v.array(v.object({ id: v.string(), title: v.string(), completed: v.boolean(), completedAt: v.union(v.number(), v.null()), rewardCoins: v.number(), bonusAwarded: v.boolean() })),
    sessions: v.array(v.object({ id: v.string(), activity: v.string(), minutes: v.number(), coins: v.number(), finishedAt: v.number() })),
    taskRewards: v.array(v.object({ taskId: v.string(), title: v.string(), coins: v.number(), awardedAt: v.number() })),
    videoUnlocks: v.array(v.object({ videoId: v.string(), unlockedAt: v.number(), cost: v.number() })),
  },
  handler: async (ctx, args) => {
    const userId = await authenticatedUserId(ctx);
    if (args.migrationKey !== "momentum-v1" || !args.confirmed || !args.snapshotHash || !Number.isSafeInteger(args.oldBalance) || args.oldBalance < 0) throw new ConvexError("Migration requires a reviewed, valid legacy snapshot.");
    if (!Number.isInteger(args.dailyCap) || args.dailyCap < 1 || args.dailyCap > 500 || !Number.isInteger(args.taskBonus) || args.taskBonus < 0 || args.taskBonus > 100) throw new ConvexError("Invalid legacy settings.");
    if (args.tasks.length > 1000 || args.sessions.length > 5000 || args.taskRewards.length > 5000 || args.videoUnlocks.length > 1000) throw new ConvexError("Legacy snapshot exceeds import limits.");
    if (!/^[a-f0-9]{64}$/.test(args.snapshotHash)) throw new ConvexError("Invalid legacy snapshot fingerprint.");
    const validIds = (ids: string[]) => ids.every((id) => id.length > 0 && id.length <= 200) && new Set(ids).size === ids.length;
    if (!validIds(args.tasks.map((item) => item.id)) || !validIds(args.sessions.map((item) => item.id)) || !validIds(args.taskRewards.map((item) => item.taskId)) || !validIds(args.videoUnlocks.map((item) => item.videoId))) throw new ConvexError("Duplicate or invalid legacy identifiers.");
    let account = await accountFor(ctx, userId);
    if (account?.migrationCompletedAt) return { alreadyMigrated: true };
    if (account) {
      const [existingTasks, existingSessions, existingPurchases, existingTransactions] = await Promise.all([
        ctx.db.query("tasks").withIndex("by_user", (q) => q.eq("userId", userId)).first(),
        ctx.db.query("focusSessions").withIndex("by_user", (q) => q.eq("userId", userId)).first(),
        ctx.db.query("libraryPurchases").withIndex("by_user", (q) => q.eq("userId", userId)).first(),
        ctx.db.query("walletTransactions").withIndex("by_user_time", (q) => q.eq("userId", userId)).first(),
      ]);
      if (account.coins !== 0 || existingTasks || existingSessions || existingPurchases || existingTransactions) throw new ConvexError("This account already has rewards activity. Legacy import is blocked to avoid overwriting or duplicating account data.");
    }
    if (!account) {
      const accountId = await ctx.db.insert("accountData", { userId, coins: 0, dailyCap: args.dailyCap, taskBonus: args.taskBonus });
      account = await ctx.db.get(accountId);
    }
    const taskIds = new Map<string, Id<"tasks">>();
    const derivedTaskRewards = args.taskRewards.length ? args.taskRewards : args.tasks.filter((task) => task.completed && task.bonusAwarded).map((task) => ({ taskId: task.id, title: task.title, coins: task.rewardCoins, awardedAt: task.completedAt ?? 0 }));
    for (const task of args.tasks) {
      if (!task.id.trim() || !task.title.trim() || task.title.length > 100 || !Number.isSafeInteger(task.rewardCoins) || task.rewardCoins < 0 || task.rewardCoins > TASK_REWARD_MAX || (task.completed && (!Number.isSafeInteger(task.completedAt) || task.completedAt! < 0))) throw new ConvexError("Legacy task data needs review before import.");
      if (!task.id.trim() || !task.title.trim() || task.title.length > 100 || !Number.isSafeInteger(task.rewardCoins) || task.rewardCoins < 0 || task.rewardCoins > TASK_REWARD_MAX || (task.completed && task.completedAt !== null && (!Number.isSafeInteger(task.completedAt) || task.completedAt < 0))) throw new ConvexError("Legacy task data needs review before import.");
      const id = await ctx.db.insert("tasks", { userId, legacyId: `legacy:${args.snapshotHash}:task:${task.id}`, title: task.title, completed: task.completed, completedAt: task.completedAt, rewardCoins: task.rewardCoins, rewardAwarded: task.completed && task.bonusAwarded });
      taskIds.set(task.id, id);
    }
    const sessionIds = new Map<string, Id<"focusSessions">>();
    for (const session of args.sessions) {
      if (!session.id.trim() || !["Studying", "Reading", "Coding"].includes(session.activity) || !Number.isSafeInteger(session.minutes) || session.minutes < 1 || session.minutes > MAX_SESSION_MINUTES || !Number.isSafeInteger(session.coins) || session.coins < 0 || session.coins > 500 || !Number.isSafeInteger(session.finishedAt) || session.finishedAt < 0) throw new ConvexError("Legacy session data needs review before import.");
      const id = await ctx.db.insert("focusSessions", { userId, legacyId: `legacy:${args.snapshotHash}:session:${session.id}`, activity: session.activity, durationMinutes: Math.max(1, session.minutes), elapsedMs: session.minutes * 60_000, startedAt: null, status: "complete", minutes: session.minutes, coins: session.coins, finishedAt: session.finishedAt });
      sessionIds.set(session.id, id);
    }
    for (const reward of derivedTaskRewards) {
      const taskId = taskIds.get(reward.taskId);
      if (!taskId || !reward.title.trim() || reward.title.length > 100 || !Number.isSafeInteger(reward.coins) || reward.coins < 0 || reward.coins > TASK_REWARD_MAX || !Number.isSafeInteger(reward.awardedAt) || reward.awardedAt < 0) throw new ConvexError("Legacy task reward data needs review before import.");
      if (reward.coins > 0) await recordTransaction(ctx, { userId, amount: reward.coins, type: LEGACY_TRANSACTION_TYPES.task, description: `Legacy task · ${reward.title}`, referenceType: "task", referenceId: String(taskId), idempotencyKey: `legacy:${args.snapshotHash}:task:${reward.taskId}`, createdAt: reward.awardedAt });
    }
    for (const session of args.sessions) {
      const sessionId = sessionIds.get(session.id);
      if (sessionId && session.coins > 0) await recordTransaction(ctx, { userId, amount: session.coins, type: LEGACY_TRANSACTION_TYPES.focus, description: `Legacy focus · ${session.activity} · ${session.minutes} min`, referenceType: "focusSession", referenceId: String(sessionId), idempotencyKey: `legacy:${args.snapshotHash}:session:${session.id}`, createdAt: session.finishedAt });
    }
    const legacyPrices: Record<string, number> = { "quiet-morning": 24, "studio-sessions": 32, "deep-work": 20, "soft-focus": 28, "paper-garden": 16, "ocean-breath": 26 };
    for (const unlock of args.videoUnlocks) {
      if (legacyPrices[unlock.videoId] !== unlock.cost || !Number.isSafeInteger(unlock.unlockedAt) || unlock.unlockedAt < 0) throw new ConvexError("Legacy purchase data needs review before import.");
      await ctx.db.insert("libraryPurchases", { userId, rewardId: unlock.videoId, cost: unlock.cost, purchasedAt: unlock.unlockedAt, idempotencyKey: `legacy:${args.snapshotHash}:purchase:${unlock.videoId}` });
      if (unlock.cost > 0) await recordTransaction(ctx, { userId, amount: -unlock.cost, type: LEGACY_TRANSACTION_TYPES.purchase, description: `Legacy reward purchase · ${unlock.videoId}`, referenceType: "reward", referenceId: unlock.videoId, idempotencyKey: `legacy:${args.snapshotHash}:purchase:${unlock.videoId}`, createdAt: unlock.unlockedAt });
    }
    const eventNet = args.sessions.reduce((sum, item) => sum + item.coins, 0) + derivedTaskRewards.reduce((sum, item) => sum + item.coins, 0) - args.videoUnlocks.reduce((sum, item) => sum + item.cost, 0);
    const reconcileCoins = args.oldBalance - eventNet;
    if (!Number.isSafeInteger(eventNet) || !Number.isSafeInteger(reconcileCoins) || args.reconcileCoins !== reconcileCoins) throw new ConvexError("Legacy reconciliation changed. Review the migration preview again.");
    if (reconcileCoins < 0) throw new ConvexError("Legacy history exceeds the saved balance; manual review is required and no migration was committed.");
    if (reconcileCoins > 0) await recordTransaction(ctx, { userId, amount: reconcileCoins, type: "legacy_reconciliation", description: "Opening balance reconciliation from verified legacy wallet", referenceType: "migration", referenceId: args.snapshotHash, idempotencyKey: `legacy:${args.snapshotHash}:reconciliation` });
    const updatedAccount = await requireAccount(ctx, userId);
    await ctx.db.patch(updatedAccount._id, { coins: args.oldBalance, dailyCap: args.dailyCap, taskBonus: args.taskBonus, migrationCompletedAt: Date.now(), migrationReport: { importedTasks: args.tasks.length, importedSessions: args.sessions.length, importedPurchases: args.videoUnlocks.length, reconciledCoins: reconcileCoins, oldBalance: args.oldBalance, eventNet } });
    return { alreadyMigrated: false, importedTasks: args.tasks.length, importedSessions: args.sessions.length, importedPurchases: args.videoUnlocks.length, reconciledCoins: reconcileCoins, eventNet };
  },
});
