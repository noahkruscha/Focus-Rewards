import { motion } from "framer-motion";
import {
  ArrowLeft,
  ArrowUpRight,
  ArrowRight,
  BarChart3,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  Clock3,
  Coins,
  Film,
  LayoutDashboard,
  LockKeyhole,
  Pause,
  Play,
  Plus,
  Search,
  Sparkles,
  Square,
  Target,
  Timer,
  Trash2,
  WalletCards,
  LogOut,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useAuth } from "@/hooks/use-auth";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useNavigate } from "react-router";
import { LEGACY_DATA_KEY, preserveLegacyBackup, previewLegacyMigration, type MigrationPreview } from "@/lib/legacyMigration";

type Activity = "Studying" | "Reading" | "Coding";
type Session = {
  id: string;
  activity: Activity;
  minutes: number;
  coins: number;
  finishedAt: number;
};
type ActiveSession = { _id: Id<"focusSessions">; activity: Activity; durationMinutes: number; elapsedMs: number; startedAt: number | null };
type Task = {
  id: Id<"tasks">;
  title: string;
  completed: boolean;
  completedAt: number | null;
  bonusAwarded: boolean;
  rewardCoins: number;
};
type TaskReward = { taskId: string; title: string; coins: number; awardedAt: number };
type VideoUnlock = { videoId: string; unlockedAt: number; cost: number };
type MomentumData = {
  coins: number;
  dailyCap: number;
  taskBonus: number;
  sessions: Session[];
  active: ActiveSession | null;
  tasks: Task[];
  taskRewards: TaskReward[];
  videoUnlocks: VideoUnlock[];
};
type View = "today" | "focus" | "tasks" | "entertainment" | "statistics" | "wallet" | "video";
type SampleVideo = { id: string; title: string; duration: string; category: string; price: number; description: string; colors: [string, string]; artwork: string };

const STORAGE_KEY = LEGACY_DATA_KEY;
const DAILY_GOAL_MINUTES = 120;
const ACTIVITIES: Activity[] = ["Studying", "Reading", "Coding"];
const DURATIONS = [25, 45, 60];
const DEFAULT_YOUTUBE_RATES = { standardCoinsPerMinute: 1.2, shortsCoinsPerMinute: 1.4, flexibleCoinsPerMinute: 1.6 };

function validRateInput(input: string) {
  if (!/^(?:\d+)(?:\.\d{1,2})?$/.test(input)) return false;
  const rate = Number(input);
  return Number.isFinite(rate) && rate > 0 && rate <= 100;
}
const SAMPLE_VIDEOS: SampleVideo[] = [
  { id: "quiet-morning", title: "A Quiet Morning in the Mountains", duration: "18 min", category: "Nature", price: 24, description: "Take a slow breath and wander through a peaceful mountain morning, from the first light to a quiet woodland trail.", colors: ["#36534c", "#a4bda0"], artwork: "☼" },
  { id: "studio-sessions", title: "Studio Sessions: Making Things by Hand", duration: "26 min", category: "Creative", price: 32, description: "A gentle look into the small decisions, sketches, and happy accidents that shape a thoughtful creative practice.", colors: ["#664d3c", "#d3a976"], artwork: "✳" },
  { id: "deep-work", title: "The Art of Doing One Thing Well", duration: "14 min", category: "Learning", price: 20, description: "A short, original reflection on attention, deliberate work, and creating room for the task in front of you.", colors: ["#334c5b", "#8eb9c1"], artwork: "◌" },
  { id: "soft-focus", title: "Soft Focus: An Ambient Listening Break", duration: "22 min", category: "Sound", price: 28, description: "A sample listening interlude with warm textures and an unhurried pace. Settle in, or simply let the room be quiet.", colors: ["#564c66", "#ae9cc6"], artwork: "〰" },
  { id: "paper-garden", title: "A Little Paper Garden", duration: "11 min", category: "Creative", price: 16, description: "Follow a small paper craft from the first folded edge to a miniature garden made from color and patience.", colors: ["#594d46", "#d79a91"], artwork: "❋" },
  { id: "ocean-breath", title: "Ocean Air: A Rest Between Things", duration: "20 min", category: "Nature", price: 26, description: "A restorative visual pause by the water, made for the space between one focused stretch and the next.", colors: ["#345561", "#8cc3bf"], artwork: "≈" },
];
const emptyData: MomentumData = {
  coins: 0, dailyCap: 120, taskBonus: 5, sessions: [], active: null,
  tasks: [
    { id: "sample-plan-day" as Id<"tasks">, title: "Plan one thing to focus on", completed: false, completedAt: null, bonusAwarded: false, rewardCoins: 5 },
    { id: "sample-read" as Id<"tasks">, title: "Read for 20 minutes", completed: false, completedAt: null, bonusAwarded: false, rewardCoins: 5 },
    { id: "sample-reset" as Id<"tasks">, title: "Take a proper screen break", completed: false, completedAt: null, bonusAwarded: false, rewardCoins: 5 },
  ], taskRewards: [], videoUnlocks: [],
};

function readData(): MomentumData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyData;
    const value = JSON.parse(raw) as Partial<MomentumData>;
    return {
      coins: Number.isFinite(value.coins) ? Math.max(0, Number(value.coins)) : 0,
      dailyCap: Number.isFinite(value.dailyCap) ? Math.max(1, Math.min(500, Number(value.dailyCap))) : 120,
      taskBonus: Number.isFinite(value.taskBonus) ? Math.max(0, Math.min(100, Number(value.taskBonus))) : 5,
      sessions: Array.isArray(value.sessions) ? value.sessions.filter((s): s is Session =>
        !!s && typeof s.id === "string" && ACTIVITIES.includes(s.activity) &&
        Number.isFinite(s.minutes) && Number.isFinite(s.coins) && Number.isFinite(s.finishedAt),
      ) : [],
      active: value.active && ACTIVITIES.includes(value.active.activity) &&
        Number.isFinite(value.active.durationMinutes) && Number.isFinite(value.active.elapsedMs)
        ? value.active : null,
      tasks: Array.isArray(value.tasks) ? value.tasks.filter((task) =>
        !!task && typeof task.id === "string" && typeof task.title === "string" &&
        typeof task.completed === "boolean" && typeof task.bonusAwarded === "boolean",
      ).map((task) => ({
        ...task,
        rewardCoins: Number.isInteger(task.rewardCoins) && Number(task.rewardCoins) >= 0
          ? Number(task.rewardCoins)
          : Number.isFinite(value.taskBonus) ? Math.max(0, Number(value.taskBonus)) : 5,
      })) : emptyData.tasks,
      taskRewards: Array.isArray(value.taskRewards) ? value.taskRewards.filter((reward): reward is TaskReward =>
        !!reward && typeof reward.taskId === "string" && typeof reward.title === "string" && Number.isFinite(reward.coins) && Number.isFinite(reward.awardedAt),
      ) : Array.isArray(value.tasks) ? value.tasks.filter((task) => !!task && task.completed && task.bonusAwarded && typeof task.id === "string" && typeof task.title === "string").map((task) => ({ taskId: task.id, title: task.title, coins: Number.isInteger(task.rewardCoins) ? Number(task.rewardCoins) : Number.isFinite(value.taskBonus) ? Number(value.taskBonus) : 5, awardedAt: Number.isFinite(task.completedAt) ? Number(task.completedAt) : 0 })) : [],
      videoUnlocks: Array.isArray(value.videoUnlocks) ? value.videoUnlocks.filter((unlock): unlock is VideoUnlock =>
        !!unlock && typeof unlock.videoId === "string" && Number.isFinite(unlock.unlockedAt) && Number.isFinite(unlock.cost),
      ) : [],
    };
  } catch {
    return emptyData;
  }
}

function dayKey(timestamp: number) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

// A concave cumulative curve makes the marginal value of each focused minute diminish.
function cumulativeReward(minutes: number) {
  return Math.floor(12 * Math.log1p(Math.max(0, minutes) / 10));
}

function formatTime(totalSeconds: number) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  return `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function shortDate(timestamp: number) {
  return new Date(timestamp).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function currentTimestamp() {
  return Date.now();
}

export default function Dashboard() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const createExtensionPairingCode = useAction(api.access.createExtensionPairingCode);
  const saveYouTubePricingRates = useMutation(api.rewards.setYouTubePricingRates);
  const youtubePricingRates = useQuery(api.rewards.youtubePricingRates, user ? {} : "skip");
  const revokeExtensionSession = useMutation(api.access.revokeExtensionSession);
  const extensionSessions = useQuery(api.access.extensionSessions, user ? {} : "skip");
  const [pairingCode, setPairingCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingSetupOpen, setPairingSetupOpen] = useState(false);
  const [standardRateInput, setStandardRateInput] = useState(String(DEFAULT_YOUTUBE_RATES.standardCoinsPerMinute));
  const [shortsRateInput, setShortsRateInput] = useState(String(DEFAULT_YOUTUBE_RATES.shortsCoinsPerMinute));
  const [flexibleRateInput, setFlexibleRateInput] = useState(String(DEFAULT_YOUTUBE_RATES.flexibleCoinsPerMinute));
  const [pairingCodeCopied, setPairingCodeCopied] = useState(false);
  const snapshot = useQuery(api.rewards.snapshot, user ? {} : "skip");
  const initializeAccount = useMutation(api.rewards.initialize);
  const setRemoteSettings = useMutation(api.rewards.setSettings);
  const createRemoteTask = useMutation(api.rewards.createTask);
  const editRemoteTask = useMutation(api.rewards.editTask);
  const deleteRemoteTask = useMutation(api.rewards.deleteTask);
  const completeRemoteTask = useMutation(api.rewards.completeTask);
  const startRemoteSession = useMutation(api.rewards.startSession);
  const updateRemoteSession = useMutation(api.rewards.updateActiveSession);
  const finishRemoteSession = useMutation(api.rewards.finishSession);
  const purchaseRemoteReward = useMutation(api.rewards.purchaseReward);
  const importRemoteData = useAction(api.rewards.importLegacyData);
  const [data, setData] = useState<MomentumData>(readData);
  const [migrationPreview, setMigrationPreview] = useState<MigrationPreview | null>(null);
  const [migrationError, setMigrationError] = useState<string | null>(null);
  const [migrationBusy, setMigrationBusy] = useState(false);
  const [migrationNotice, setMigrationNotice] = useState<string | null>(null);
  const [walletTransactions, setWalletTransactions] = useState<Array<{ id: string; amount: number; type: string; description: string; createdAt: number }>>([]);
  const [view, setView] = useState<View>("today");
  const [now, setNow] = useState(0);
  const [dailyCapInput, setDailyCapInput] = useState(String(data.dailyCap));
  const [taskBonusInput, setTaskBonusInput] = useState(String(data.taskBonus));
  const [taskDraft, setTaskDraft] = useState("");
  const [newTaskReward, setNewTaskReward] = useState(String(data.taskBonus));
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editingTaskTitle, setEditingTaskTitle] = useState("");
  const [editingTaskReward, setEditingTaskReward] = useState("");
  const completingTaskIds = useRef(new Set<string>());
  const [pendingTaskAction, setPendingTaskAction] = useState<
    | { kind: "create"; title: string; rewardCoins: number; createdAt: number }
    | { kind: "edit"; taskId: Id<"tasks">; title: string; rewardCoins: number }
    | { kind: "complete"; taskId: Id<"tasks">; title: string; rewardCoins: number; completedAt: number }
    | { kind: "default"; rewardCoins: number }
    | null
  >(null);
  const [videoQuery, setVideoQuery] = useState("");
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
  const [catalogFilter, setCatalogFilter] = useState("All");

  useEffect(() => { if (user && snapshot && !snapshot.initialized) void initializeAccount({}); }, [user, snapshot, initializeAccount]);
  useEffect(() => {
    if (!snapshot?.initialized) return;
    setData({
      coins: snapshot.coins, dailyCap: snapshot.dailyCap, taskBonus: snapshot.taskBonus,
      sessions: snapshot.sessions.map((session) => ({ ...session, id: session.id, activity: session.activity as Activity })),
      active: snapshot.active ? { _id: snapshot.active._id, activity: snapshot.active.activity as Activity, durationMinutes: snapshot.active.durationMinutes, elapsedMs: snapshot.active.elapsedMs, startedAt: snapshot.active.startedAt } : null,
      tasks: snapshot.tasks.map((task) => ({ ...task, id: task.id as Id<"tasks">, bonusAwarded: task.rewardAwarded })),
      taskRewards: snapshot.transactions.filter((transaction) => transaction.type === "task_reward" || transaction.type === "legacy_task_reward").map((transaction) => ({ taskId: transaction.referenceId ?? transaction.id, title: transaction.description, coins: transaction.amount, awardedAt: transaction.createdAt })),
      videoUnlocks: snapshot.videoUnlocks,
    });
    setWalletTransactions(snapshot.transactions);
  }, [snapshot]);
  useEffect(() => {
    if (user?.role !== "admin" || !snapshot?.initialized || snapshot.migrationCompletedAt) return;
    void previewLegacyMigration(localStorage).then(setMigrationPreview).catch((error: unknown) => setMigrationError(error instanceof Error ? error.message : "Could not inspect saved local data."));
  }, [user?.role, snapshot?.initialized, snapshot?.migrationCompletedAt]);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  const todaySessions = useMemo(() => data.sessions.filter((session) => dayKey(session.finishedAt) === dayKey(now)), [data.sessions, now]);
  const todayMinutes = todaySessions.reduce((sum, session) => sum + session.minutes, 0);
  const todayCoins = todaySessions.reduce((sum, session) => sum + session.coins, 0);
  const activeElapsedMs = data.active
    ? data.active.elapsedMs + (data.active.startedAt ? Math.max(0, now - data.active.startedAt) : 0)
    : 0;
  const elapsedMinutes = Math.floor(activeElapsedMs / 60_000);
  const elapsedSeconds = activeElapsedMs / 1000;
  const visibleMinutes = todayMinutes + elapsedMinutes;
  const rewardPreview = data.active
    ? Math.max(0, Math.min(data.dailyCap - todayCoins, cumulativeReward(todayMinutes + elapsedMinutes) - cumulativeReward(todayMinutes)))
    : 0;
  const remainingSeconds = data.active ? Math.max(0, data.active.durationMinutes * 60 - elapsedSeconds) : 0;
  const progress = Math.min(100, (visibleMinutes / DAILY_GOAL_MINUTES) * 100);
  const recentSessions = [...data.sessions].sort((a, b) => b.finishedAt - a.finishedAt).slice(0, 6);
  const week = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(now);
    date.setDate(date.getDate() - (6 - index));
    const key = dayKey(date.getTime());
    const minutes = data.sessions.filter((session) => dayKey(session.finishedAt) === key).reduce((sum, session) => sum + session.minutes, 0);
    return { label: date.toLocaleDateString(undefined, { weekday: "short" }).slice(0, 2), minutes, today: index === 6 };
  });
  const bestDayMinutes = Math.max(1, ...week.map((day) => day.minutes));
  const pendingTasks = data.tasks.filter((task) => !task.completed);
  const completedTasks = data.tasks.filter((task) => task.completed);
  const selectedVideo = SAMPLE_VIDEOS.find((video) => video.id === selectedVideoId) ?? null;
  const videoCategories = ["All", ...new Set(SAMPLE_VIDEOS.map((video) => video.category))];
  const filteredVideos = SAMPLE_VIDEOS.filter((video) =>
    (catalogFilter === "All" || video.category === catalogFilter) &&
    `${video.title} ${video.category} ${video.description}`.toLowerCase().includes(videoQuery.trim().toLowerCase()),
  );

  async function confirmLegacyMigration() {
    if (!migrationPreview || migrationBusy || migrationPreview.reconcileCoins < 0) return;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) { setMigrationPreview(null); return; }
    setMigrationBusy(true); setMigrationError(null);
    try {
      preserveLegacyBackup(localStorage, raw, migrationPreview.snapshotHash);
      const taskRewards = migrationPreview.snapshot.taskRewards.length ? migrationPreview.snapshot.taskRewards : migrationPreview.snapshot.tasks.filter((task) => task.completed && task.bonusAwarded).map((task) => ({ taskId: task.id, title: task.title, coins: task.rewardCoins, awardedAt: task.completedAt ?? 0 }));
      const result = await importRemoteData({ migrationKey: "momentum-v1", confirmed: true, snapshotHash: migrationPreview.snapshotHash, oldBalance: migrationPreview.snapshot.coins, dailyCap: migrationPreview.snapshot.dailyCap, taskBonus: migrationPreview.snapshot.taskBonus, reconcileCoins: migrationPreview.reconcileCoins, tasks: migrationPreview.snapshot.tasks.map(({ id, title, completed, completedAt, rewardCoins, bonusAwarded }) => ({ id, title, completed, completedAt, rewardCoins, bonusAwarded: bonusAwarded ?? completed })), sessions: migrationPreview.snapshot.sessions, taskRewards, videoUnlocks: migrationPreview.snapshot.videoUnlocks });
      if (result.alreadyMigrated) setMigrationNotice("This account has already imported its legacy data.");
      else setMigrationNotice(`Imported ${result.importedTasks} tasks, ${result.importedSessions} sessions, and ${result.importedPurchases} purchases. ${result.reconciledCoins} coins reconciled. Original backup is preserved.`);
      setMigrationPreview(null);
    } catch (error) { setMigrationError(error instanceof Error ? error.message : "Migration failed. Your original data and backup are preserved."); }
    finally { setMigrationBusy(false); }
  }

  async function handleSignOut() {
    await signOut();
    navigate("/");
  }

  function startSession(activity: Activity, durationMinutes: number) {
    if (data.active) return;
    const startedAt = Date.now();
    void startRemoteSession({ activity, durationMinutes, startedAt, idempotencyKey: crypto.randomUUID() }).catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Couldn't start focus session."));
    setNow(startedAt);
  }

  function pauseSession() {
    if (!data.active || !data.active.startedAt) return;
    const elapsedMs = data.active.elapsedMs + Math.max(0, Date.now() - data.active.startedAt);
    void updateRemoteSession({ sessionId: data.active._id, elapsedMs, startedAt: null, status: "active" }).catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Couldn't pause session."));
  }

  function resumeSession() {
    if (data.active && !data.active.startedAt) void updateRemoteSession({ sessionId: data.active._id, elapsedMs: data.active.elapsedMs, startedAt: Date.now(), status: "active" }).catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Couldn't resume session."));
    setNow(Date.now());
  }

  const finishSession = useCallback(() => {
    const active = data.active;
    if (!active) return;
    const completedAt = Date.now();
    const totalMs = active.elapsedMs + (active.startedAt ? Math.max(0, completedAt - active.startedAt) : 0);
    const minutes = Math.floor(totalMs / 60_000);
    if (!minutes) {
      void updateRemoteSession({ sessionId: active._id, elapsedMs: totalMs, startedAt: null, status: "cancelled" }).catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Couldn't cancel session."));
      toast("Focus session ended before a full minute. No coins were earned.");
      return;
    }
    const completedToday = data.sessions.filter((session) => dayKey(session.finishedAt) === dayKey(completedAt));
    void finishRemoteSession({ sessionId: active._id, elapsedMs: totalMs, idempotencyKey: `finish:${active._id}` }).then((result) => toast.success(`Session complete · ${result.minutes} focused min`, { description: result.coins ? `You earned ${result.coins} ${result.coins === 1 ? "coin" : "coins"}. Nice work.` : "Your daily coin limit has been reached." })).catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Couldn't finish the focus session."));
    setNow(completedAt);
  }, [data]);

  useEffect(() => {
    if (!data.active?.startedAt) return;
    const timeout = window.setTimeout(finishSession, Math.max(0, remainingSeconds * 1000));
    return () => window.clearTimeout(timeout);
  }, [data.active, finishSession, remainingSeconds]);

  function saveCap() {
    const value = Number(dailyCapInput);
    if (!Number.isInteger(value) || value < 1 || value > 500) { toast.error("Set a daily cap between 1 and 500 coins."); setDailyCapInput(String(data.dailyCap)); return; }
    void setRemoteSettings({ dailyCap: value, taskBonus: data.taskBonus }).then(() => toast.success("Daily focus reward limit updated.")).catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Couldn't save settings."));
  }

  function saveTaskBonus() {
    const value = Number(taskBonusInput);
    if (!Number.isInteger(value) || value < 0 || value > 100) {
      toast.error("Set the task reward between 0 and 100 coins.");
      setTaskBonusInput(String(data.taskBonus));
      return;
    }
    if (value > 5) {
      setPendingTaskAction({ kind: "default", rewardCoins: value });
      return;
    }
    void setRemoteSettings({ dailyCap: data.dailyCap, taskBonus: value }).then(() => toast.success("Default reward for new tasks updated.")).catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Couldn't save settings."));
  }

  function parseTaskReward(input: string) {
    const value = Number(input);
    if (!Number.isInteger(value) || value < 0 || value > 1000) {
      toast.error("Set a task reward between 0 and 1,000 coins.");
      return null;
    }
    return value;
  }

  function saveNewTask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = taskDraft.trim();
    if (!title) {
      toast.error("Add a short description for your task.");
      return;
    }
    if (title.length > 100) {
      toast.error("Keep task names under 100 characters.");
      return;
    }
    const rewardCoins = parseTaskReward(newTaskReward);
    if (rewardCoins === null) return;
    const action = { kind: "create" as const, title, rewardCoins, createdAt: currentTimestamp() };
    if (rewardCoins > 5) {
      setPendingTaskAction(action);
      return;
    }
    applyTaskAction(action);
  }

  function requestTaskEdit(taskId: Id<"tasks">) {
    const title = editingTaskTitle.trim();
    if (!title || title.length > 100) {
      toast.error("Task names must be between 1 and 100 characters.");
      return;
    }
    const rewardCoins = parseTaskReward(editingTaskReward);
    if (rewardCoins === null) return;
    const action = { kind: "edit" as const, taskId, title, rewardCoins };
    if (rewardCoins > 5) {
      setPendingTaskAction(action);
      return;
    }
    applyTaskAction(action);
  }

  function requestTaskCompletion(taskId: Id<"tasks">) {
    const task = data.tasks.find((item) => item.id === taskId);
    if (!task || task.completed || task.bonusAwarded || completingTaskIds.current.has(taskId)) return;
    const action = { kind: "complete" as const, taskId, title: task.title, rewardCoins: task.rewardCoins, completedAt: currentTimestamp() };
    if (task.rewardCoins > 5) {
      setPendingTaskAction(action);
      return;
    }
    completingTaskIds.current.add(taskId);
    applyTaskAction(action);
  }

  function applyTaskAction(action: NonNullable<typeof pendingTaskAction>) {
    if (action.kind === "create") {
      const createdAt = action.createdAt;
      void createRemoteTask({ title: action.title, rewardCoins: action.rewardCoins, idempotencyKey: `task-${createdAt}-${crypto.randomUUID()}` }).then(() => toast.success("Task added to your list.")).catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Couldn't add task."));
      setTaskDraft("");
      setNewTaskReward(String(data.taskBonus));
      return;
    }
    if (action.kind === "edit") {
      const task = data.tasks.find((item) => item.id === action.taskId);
      if (!task || task.completed) return;
      void editRemoteTask({ taskId: action.taskId, title: action.title, rewardCoins: action.rewardCoins }).then(() => toast.success("Task updated.")).catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Couldn't update task."));
      setEditingTaskId(null);
      setEditingTaskTitle("");
      setEditingTaskReward("");
      return;
    }
    if (action.kind === "default") {
      void setRemoteSettings({ dailyCap: data.dailyCap, taskBonus: action.rewardCoins }).then(() => toast.success("Default reward for new tasks updated.")).catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Couldn't save settings."));
      return;
    }
    const task = data.tasks.find((item) => item.id === action.taskId);
    if (!task || task.completed || task.bonusAwarded) return;
    const rewardCoins = action.rewardCoins;
    void completeRemoteTask({ taskId: action.taskId, idempotencyKey: `complete:${action.taskId}` }).then((result) => toast.success(result.alreadyCompleted ? "Task was already completed." : "Task complete", { description: rewardCoins ? `You earned ${rewardCoins} ${rewardCoins === 1 ? "coin" : "coins"}.` : "Nicely done. This task has no coin reward." })).catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Couldn't complete task."));
  }

  function confirmTaskAction() {
    if (!pendingTaskAction) return;
    if (pendingTaskAction.kind === "complete") {
      if (completingTaskIds.current.has(pendingTaskAction.taskId)) return;
      completingTaskIds.current.add(pendingTaskAction.taskId);
    }
    applyTaskAction(pendingTaskAction);
    setPendingTaskAction(null);
  }

  function deleteTask(taskId: Id<"tasks">) {
    void deleteRemoteTask({ taskId }).then(() => toast("Task removed.")).catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Couldn't delete task."));
  }

  function openPairingSetup() {
    if (!youtubePricingRates) return;
    const rates = youtubePricingRates;
    setStandardRateInput(String(rates.standardCoinsPerMinute));
    setShortsRateInput(String(rates.shortsCoinsPerMinute));
    setFlexibleRateInput(String(rates.flexibleCoinsPerMinute));
    setPairingCode(null);
    setPairingCodeCopied(false);
    setPairingSetupOpen(true);
  }

  async function createPairingCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const rates = {
      standardCoinsPerMinute: Number(standardRateInput),
      shortsCoinsPerMinute: Number(shortsRateInput),
      flexibleCoinsPerMinute: Number(flexibleRateInput),
    };
    if (!validRateInput(standardRateInput) || !validRateInput(shortsRateInput) || !validRateInput(flexibleRateInput)) {
      toast.error("Rates must be between 0.01 and 100 Coins per minute, with up to two decimal places.");
      return;
    }
    setPairingBusy(true);
    try {
      await saveYouTubePricingRates(rates);
      setPairingCode(await createExtensionPairingCode({}));
      toast.success("Rates saved and pairing code created. The code expires in five minutes.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save rates or create a pairing code.");
    } finally {
      setPairingBusy(false);
    }
  }

  async function copyPairingCode() {
    if (!pairingCode) return;
    try {
      await navigator.clipboard.writeText(pairingCode.code);
      setPairingCodeCopied(true);
    } catch {
      setPairingCodeCopied(false);
      toast.error("Could not copy the code. Select and copy it manually.");
    }
  }

  function unlockVideo(video: SampleVideo) {
    if (data.videoUnlocks.some((unlock) => unlock.videoId === video.id)) {
      setSelectedVideoId(video.id);
      setView("video");
      return;
    }
    if (data.coins < video.price) {
      toast.error("Not quite enough coins yet.", { description: `You need ${video.price - data.coins} more coins to unlock this video.` });
      return;
    }
    void purchaseRemoteReward({ rewardId: video.id, cost: video.price, idempotencyKey: `purchase:${video.id}` }).then((result) => { if (!result.alreadyPurchased) toast.success("Added to your collection", { description: `${video.price} coins spent on “${video.title}”.` }); }).catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Couldn't purchase this reward."));
  }

  function openVideo(video: SampleVideo) {
    setSelectedVideoId(video.id);
    setView("video");
  }

  const nav = [
    { id: "today" as const, label: "Dashboard", icon: LayoutDashboard },
    { id: "focus" as const, label: "Focus", icon: Timer },
    { id: "tasks" as const, label: "Tasks", icon: CheckCircle2 },
    { id: "entertainment" as const, label: "Library", icon: Film },
    { id: "statistics" as const, label: "Statistics", icon: BarChart3 },
    { id: "wallet" as const, label: "Wallet", icon: WalletCards },
  ];

  return (
    <div className="momentum-shell min-h-screen text-white">
      <aside className="momentum-sidebar">
        <a className="brand-lockup" href="/" aria-label="Focus Rewards home">
          <span className="brand-mark"><Zap size={17} fill="currentColor" /></span>
          <span>Focus Rewards</span>
        </a>
        <div className="sidebar-label">YOUR SPACE</div>
        <nav className="sidebar-nav" aria-label="Main navigation">
          {nav.map(({ id, label, icon: Icon }) => (
            <button key={id} className={`nav-item ${view === id ? "is-active" : ""}`} onClick={() => setView(id)}>
              <Icon size={17} strokeWidth={1.8} /> <span>{label}</span>
              {view === id && <span className="nav-indicator" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-tip-icon"><Sparkles size={15} /></div>
          <p>Earn your next little reward.</p>
          <span>Focus first. Enjoy it after.</span>
          <div className="sidebar-version">PERSONAL EDITION <i /> LOCAL & PRIVATE</div>
        </div>
      </aside>

      <main className="momentum-main">
        <header className="topbar">
          <div className="mobile-brand"><span className="brand-mark"><Zap size={15} fill="currentColor" /></span> Focus Rewards</div>
          <div className="topbar-date">{new Date(now).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</div>
          <div className="topbar-actions"><button className="topbar-account" title={`${user?.email ?? "Your account"} · Sign out`} onClick={() => void handleSignOut()}><span className="account-avatar">{(user?.displayName ?? user?.name)?.slice(0, 1) ?? user?.email?.slice(0, 1) ?? "Y"}</span><span className="account-label">{user?.displayName ?? user?.name ?? user?.email ?? "My space"}</span><LogOut size={13} /></button><div className="balance-pill" aria-label={`${data.coins} coin balance`}><span className="coin-glyph"><Coins size={15} /></span><strong>{data.coins}</strong><span>coins</span></div></div>
        </header>

        <div className="main-inner">
          {view === "today" ? (
            <motion.section key="today" className="page-content" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
              <div className="page-heading"><div><span className="eyebrow">A FRESH START, EVERY DAY</span><h1>{new Date(now).getHours() < 12 ? "Good morning" : new Date(now).getHours() < 18 ? "Good afternoon" : "Good evening"}{(user?.displayName ?? user?.name) ? `, ${(user.displayName ?? user.name)!.split(" ")[0]}` : ""}.</h1><p>Make a little progress on what matters.</p></div><div className="heading-icon"><Sparkles size={19} /></div></div>
              <div className="overview-grid">
                <div className="glass-panel overview-card"><span className="overview-icon mint-icon"><Clock3 size={17} /></span><span className="tile-label">FOCUS TIME</span><strong>{visibleMinutes}<small> min</small></strong><span className="tile-foot">{todaySessions.length} completed {todaySessions.length === 1 ? "session" : "sessions"} today</span></div>
                <div className="glass-panel overview-card"><span className="overview-icon gold-icon"><Coins size={17} /></span><span className="tile-label">COIN BALANCE</span><strong>{data.coins}</strong><span className="tile-foot">{todayCoins} focus coins earned today</span></div>
                <div className="glass-panel overview-card progress-card"><div className="progress-card-head"><span className="overview-icon blue-icon"><Target size={17} /></span><span className="tile-label">DAILY PROGRESS</span><strong>{Math.round(progress)}<small>%</small></strong></div><div className="progress-track"><motion.div className="progress-fill" animate={{ width: `${progress}%` }} transition={{ duration: .6 }} /></div><span className="tile-foot">{visibleMinutes} of {DAILY_GOAL_MINUTES} focused minutes</span></div>
              </div>
              <div className="focus-dashboard-grid">
                <div className="glass-panel timer-panel" id="focus-timer"><div className="section-heading timer-heading"><div><span className="eyebrow">YOUR FOCUS SESSION</span><h2>{data.active ? "Stay in the flow" : "Ready when you are"}</h2></div><span className={`soft-badge ${data.active?.startedAt ? "is-live" : ""}`}><span className="live-dot" /> {data.active ? data.active.startedAt ? "IN FOCUS" : "PAUSED" : "YOUR TIME"}</span></div><FocusTimer compact active={data.active} remainingSeconds={remainingSeconds} rewardPreview={rewardPreview} onStart={startSession} onPause={pauseSession} onResume={resumeSession} onFinish={finishSession} /></div>
                <div className="right-rail">
                  <button className="glass-panel dashboard-task-shortcut" onClick={() => setView("tasks")}><span className="shortcut-icon"><CheckCircle2 size={16} /></span><span><strong>Your tasks</strong><small>{pendingTasks.length ? `${pendingTasks.length} waiting · rewards set individually` : "Make a list for your next win"}</small></span><ChevronRight size={16} /></button>
                  <button className="glass-panel dashboard-library-shortcut" onClick={() => setView("entertainment")}><span className="shortcut-icon library-shortcut-icon"><Film size={16} /></span><span><strong>Reward library</strong><small>{data.videoUnlocks.length ? `${data.videoUnlocks.length} reward${data.videoUnlocks.length === 1 ? "" : "s"} unlocked` : "A little break, earned by you"}</small></span><ChevronRight size={16} /></button>
                  <div className="glass-panel reward-panel"><div className="reward-sparkle"><Sparkles size={16} /></div><span className="tile-label">TODAY'S FOCUS REWARDS</span><strong>{todayCoins + rewardPreview}<small> / {data.dailyCap}</small></strong><div className="reward-track"><div style={{ width: `${Math.min(100, ((todayCoins + rewardPreview) / data.dailyCap) * 100)}%` }} /></div><span className="tile-foot">{data.active ? `+${rewardPreview} in this session` : `${Math.max(0, data.dailyCap - todayCoins)} focus coins remain`}</span></div>
                  <div className="glass-panel recent-panel"><div className="section-heading"><div><h2>Recent focus</h2><p>A record of your effort.</p></div><button className="text-action" onClick={() => setView("statistics")}>All <ChevronRight size={14} /></button></div>{recentSessions.length ? <div className="mini-session-list">{recentSessions.slice(0, 3).map((session) => <div className="mini-session" key={session.id}><span className="mini-session-dot" /><div><strong>{session.activity}</strong><span>{shortDate(session.finishedAt)}</span></div><span>{session.minutes}m</span></div>)}</div> : <div className="compact-empty">Your first session is waiting.</div>}</div>
                </div>
              </div>
            </motion.section>
          ) : view === "tasks" ? (
            <motion.section key="tasks" className="page-content" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
              <div className="page-heading"><div><span className="eyebrow">SMALL WINS ADD UP</span><h1>Your tasks</h1><p>Set a reward for each task and earn it once when you complete the task.</p></div><div className="heading-icon"><CheckCircle2 size={19} /></div></div>
              <form className="glass-panel task-create" onSubmit={saveNewTask}><Plus size={17} /><input value={taskDraft} onChange={(event) => setTaskDraft(event.target.value)} maxLength={100} placeholder="What would you like to get done?" aria-label="New task" /><label className="task-reward-input"><Coins size={13} /><input type="number" min="0" max="1000" step="1" value={newTaskReward} onChange={(event) => setNewTaskReward(event.target.value)} aria-label="Coin reward for new task" /><span>coins</span></label><button type="submit" aria-label="Add task"><Plus size={17} /> Add task</button></form>
              <section className="glass-panel task-panel"><div className="section-heading"><div><h2>Up next</h2><p>{pendingTasks.length} {pendingTasks.length === 1 ? "task" : "tasks"} on your list</p></div><span className="task-count">{pendingTasks.length}</span></div>{pendingTasks.length ? <div className="task-list">{pendingTasks.map((task) => <div className="task-row" key={task.id}><button className="task-check" aria-label={`Complete ${task.title}`} onClick={() => requestTaskCompletion(task.id)}><Check size={14} /></button>{editingTaskId === task.id ? <form className="task-edit-form" onSubmit={(event) => { event.preventDefault(); requestTaskEdit(task.id); }}><input autoFocus aria-label="Edit task name" maxLength={100} value={editingTaskTitle} onChange={(event) => setEditingTaskTitle(event.target.value)} /><label className="task-reward-input edit-reward-input"><Coins size={13} /><input aria-label="Edit task coin reward" type="number" min="0" max="1000" step="1" value={editingTaskReward} onChange={(event) => setEditingTaskReward(event.target.value)} /><span>coins</span></label><button type="submit" aria-label="Save task"><Check size={15} /></button><button type="button" aria-label="Cancel edit" onClick={() => setEditingTaskId(null)}><X size={15} /></button></form> : <><span className="task-title">{task.title}</span><span className="task-reward"><Coins size={13} /> +{task.rewardCoins}</span><button className="task-icon-button" aria-label={`Edit ${task.title}`} onClick={() => { setEditingTaskId(task.id); setEditingTaskTitle(task.title); setEditingTaskReward(String(task.rewardCoins)); }}><span>Edit</span></button><button className="task-icon-button delete-task" aria-label={`Delete ${task.title}`} onClick={() => deleteTask(task.id)}><Trash2 size={14} /></button></>}</div>)}</div> : <div className="empty-state"><span className="empty-icon"><CheckCircle2 size={19} /></span><strong>Nothing on your list</strong><span>Add a task when something comes to mind.</span></div>}</section>
              <section className="glass-panel task-panel"><div className="section-heading"><div><h2>Completed</h2><p>Your wins stay recorded here.</p></div><span className="task-count complete-count">{completedTasks.length}</span></div>{completedTasks.length ? <div className="task-list completed-task-list">{completedTasks.map((task) => <div className="task-row task-completed" key={task.id}><span className="task-check done-check"><Check size={14} /></span><span className="task-title">{task.title}</span><span className="task-earned"><Coins size={13} /> Earned {data.taskRewards.find((reward) => reward.taskId === task.id)?.coins ?? (task.bonusAwarded ? task.rewardCoins : 0)}</span><button className="task-icon-button delete-task" aria-label={`Delete ${task.title}`} onClick={() => deleteTask(task.id)}><Trash2 size={14} /></button></div>)}</div> : <div className="empty-state small-empty"><strong>Your finished tasks will live here.</strong></div>}</section>
              <section className="glass-panel settings-panel"><div><span className="settings-icon"><Coins size={16} /></span><div><strong>Default reward for new tasks</strong><p>Used for new tasks; each task can have its own reward.</p></div></div><div className="cap-control"><input aria-label="Default coin reward for new tasks" type="number" min="0" max="100" value={taskBonusInput} onChange={(event) => setTaskBonusInput(event.target.value)} onKeyDown={(event) => event.key === "Enter" && saveTaskBonus()} /><span>coins / new task</span><button type="button" onClick={saveTaskBonus}>Save</button></div></section>
            </motion.section>
          ) : view === "entertainment" ? (
            <motion.section key="entertainment" className="page-content" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
              <div className="page-heading"><div><span className="eyebrow">A LITTLE SOMETHING TO LOOK FORWARD TO</span><h1>The reward library</h1><p>Spend the coins you earn on a mindful break.</p></div><div className="heading-icon"><Film size={19} /></div></div>
              <section className="glass-panel extension-promo" aria-labelledby="extension-promo-title">
                <div className="extension-promo-mark"><Zap size={18} fill="currentColor" /></div>
                <div className="extension-promo-copy"><span className="eyebrow">A MORE SEAMLESS WAY TO FOCUS</span><h2 id="extension-promo-title">Take Momentum Further</h2><p>Make earning and spending coins more convenient while you browse. The browser extension is on its way.</p></div>
                <div className="extension-promo-action"><span className="extension-coming-soon">Coming Soon</span><button type="button" disabled aria-disabled="true" title="The Momentum browser extension is coming soon">Get the Browser Extension <ArrowUpRight size={14} /></button></div>
              </section>
              <div className="library-tools"><label className="library-search"><Search size={16} /><input aria-label="Search videos" placeholder="Search the library" value={videoQuery} onChange={(event) => setVideoQuery(event.target.value)} /><span>⌘ K</span></label><div className="library-balance"><Coins size={15} /> <strong>{data.coins}</strong> available</div></div>
              <div className="category-filters" aria-label="Filter videos by category">{videoCategories.map((category) => <button key={category} className={catalogFilter === category ? "filter-active" : ""} onClick={() => setCatalogFilter(category)}>{category}</button>)}</div>
              <div className="video-grid">{filteredVideos.map((video, index) => { const unlocked = data.videoUnlocks.some((unlock) => unlock.videoId === video.id); return <motion.article className="video-card" key={video.id} initial={{ opacity: 0, y: 7 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * .04 }}><button className="video-artwork" style={{ background: `linear-gradient(145deg, ${video.colors[0]}, ${video.colors[1]})` }} onClick={() => openVideo(video)} aria-label={`Open ${video.title}`}><span className="artwork-symbol">{video.artwork}</span><span className="artwork-duration">{video.duration}</span>{unlocked && <span className="artwork-unlocked"><Check size={12} /> In your collection</span>}</button><div className="video-info"><div><span className="video-category">{video.category}</span><h2>{video.title}</h2></div><button className="video-open" aria-label={`View details for ${video.title}`} onClick={() => openVideo(video)}><ChevronRight size={17} /></button></div><div className="video-card-bottom"><span><Coins size={14} /> {unlocked ? "Unlocked" : `${video.price} coins`}</span><button className={unlocked ? "video-detail-button" : "video-unlock-button"} onClick={() => unlocked ? openVideo(video) : unlockVideo(video)}>{unlocked ? "Watch" : "Unlock"}</button></div></motion.article>; })}</div>
              {!filteredVideos.length && <div className="glass-panel empty-state library-empty"><span className="empty-icon"><Search size={19} /></span><strong>No matches found</strong><span>Try a different title or category.</span></div>}
              <p className="library-disclaimer">Original sample concepts and placeholder artwork. No third-party video content is included.</p>
            </motion.section>
          ) : view === "video" ? (
            <motion.section key={`video-${selectedVideo?.id ?? "empty"}`} className="page-content video-detail-page" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
              <button className="back-link" onClick={() => setView("entertainment")}><ArrowLeft size={15} /> Back to library</button>
              {selectedVideo ? <><div className="video-detail-art" style={{ background: `linear-gradient(145deg, ${selectedVideo.colors[0]}, ${selectedVideo.colors[1]})` }}><span>{selectedVideo.artwork}</span><i>{selectedVideo.duration}</i></div><div className="video-detail-title"><div><span className="video-category">{selectedVideo.category} · {selectedVideo.duration}</span><h1>{selectedVideo.title}</h1></div>{data.videoUnlocks.some((unlock) => unlock.videoId === selectedVideo.id) ? <span className="unlocked-status"><Check size={14} /> In your collection</span> : <span className="detail-price"><Coins size={15} /> {selectedVideo.price} coins</span>}</div><p className="video-description">{selectedVideo.description}</p><section className="glass-panel video-detail-note"><Sparkles size={17} /><div><strong>A small reward, earned by you.</strong><p>These are original sample experiences with placeholder artwork. The video player is intentionally not connected to external or copyrighted content.</p></div></section>{data.videoUnlocks.some((unlock) => unlock.videoId === selectedVideo.id) ? <div className="sample-player"><span><Play size={19} fill="currentColor" /></span><strong>Your sample reward is unlocked</strong><p>Video playback is not part of this prototype.</p></div> : <button className="detail-unlock-button" disabled={data.coins < selectedVideo.price} onClick={() => unlockVideo(selectedVideo)}><LockKeyhole size={15} /> {data.coins < selectedVideo.price ? `Earn ${selectedVideo.price - data.coins} more coins to unlock` : `Unlock for ${selectedVideo.price} coins`}</button>}</> : <div className="glass-panel empty-state"><strong>Video not found</strong><button className="text-action" onClick={() => setView("entertainment")}>Browse the library <ChevronRight size={14} /></button></div>}
            </motion.section>
          ) : view === "wallet" ? (
            <motion.section key="wallet" className="page-content" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
              <div className="page-heading"><div><span className="eyebrow">EARNED ONE MOMENT AT A TIME</span><h1>Your wallet</h1><p>Every coin started with a little effort.</p></div><div className="heading-icon gold-icon"><WalletCards size={19} /></div></div>
              <section className="glass-panel wallet-hero"><div className="wallet-coin-icon"><Coins size={23} /></div><span className="tile-label">AVAILABLE COINS</span><strong>{data.coins}</strong><p>Earn coins by focusing or finishing a task, then use them to unlock a mindful break.</p><button onClick={() => setView("entertainment")}>Browse rewards <ArrowRight size={14} /></button></section>
              <section className="glass-panel history-panel"><div className="section-heading"><div><h2>Extension account linking</h2><p>Generate a single-use pairing code for your signed-in account.</p></div></div><div className="extension-pairing-actions"><button type="button" disabled={pairingBusy || youtubePricingRates === undefined} onClick={openPairingSetup}>{youtubePricingRates === undefined ? "Loading rates…" : "Create pairing code"}</button>{pairingCode && <div className="extension-pairing-code"><code>{pairingCode.code}</code><button type="button" onClick={() => void copyPairingCode()}>{pairingCodeCopied ? "Copied" : "Copy code"}</button><span>Expires {new Date(pairingCode.expiresAt).toLocaleTimeString()}. Use it only in the extension options page.</span></div>}</div>{extensionSessions?.length ? <div className="session-list">{extensionSessions.map((session) => <div className="session-row" key={session.id}><div className="session-copy"><strong>Browser extension · {session.userId === user?._id ? "Your account" : "Beta account"}</strong><span>Expires {new Date(session.expiresAt).toLocaleString()}{session.revoked ? " · Revoked" : ""}</span></div>{!session.revoked && <button type="button" onClick={() => void revokeExtensionSession({ sessionId: session.id }).then(() => toast.success("Extension session revoked.")).catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Could not revoke extension session."))}>Revoke</button>}</div>)}</div> : <p className="text-muted-foreground">No extension sessions are linked.</p>}</section>
              <section className="glass-panel history-panel"><div className="section-heading"><div><h2>Coin activity</h2><p>Your recent earning and spending.</p></div></div>{walletTransactions.length ? <div className="session-list">{walletTransactions.map((transaction) => <div className="session-row wallet-entry" key={transaction.id}><span className={`wallet-activity-icon ${transaction.amount < 0 ? "spent" : "earned"}`}><Coins size={14} /></span><div className="session-copy"><strong>{transaction.description}</strong><span>{shortDate(transaction.createdAt)}</span></div><span className={`wallet-amount ${transaction.amount < 0 ? "spent" : "earned"}`}>{transaction.amount > 0 ? "+" : "−"}{Math.abs(transaction.amount)}</span></div>)}</div> : <div className="empty-state"><span className="empty-icon"><WalletCards size={19} /></span><strong>Your wallet is ready</strong><span>Complete a focus session or task to earn your first coins.</span></div>}</section>
            </motion.section>
          ) : view === "statistics" ? (
            <motion.section key="statistics" className="page-content" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
              <div className="page-heading"><div><span className="eyebrow">YOUR RHYTHM</span><h1>Statistics</h1><p>A little consistency goes a long way.</p></div><div className="heading-icon"><BarChart3 size={19} /></div></div>
              <div className="stat-grid">
                <div className="glass-panel stat-tile"><span className="tile-label">TODAY'S FOCUS</span><strong>{visibleMinutes}<small> min</small></strong><span className="tile-foot"><Clock3 size={13} /> {todaySessions.length} completed {todaySessions.length === 1 ? "session" : "sessions"}</span></div>
                <div className="glass-panel stat-tile"><span className="tile-label">COINS EARNED TODAY</span><strong>{todayCoins + rewardPreview}</strong><span className="tile-foot"><Coins size={13} /> focus coins, of {data.dailyCap} daily</span></div>
                <div className="glass-panel stat-tile"><span className="tile-label">DAILY GOAL</span><strong>{Math.round(progress)}<small>%</small></strong><span className="tile-foot"><Target size={13} /> {DAILY_GOAL_MINUTES} min target</span></div>
              </div>
              <section className="glass-panel chart-panel">
                <div className="section-heading"><div><h2>Focus this week</h2><p>Minutes spent showing up.</p></div><span className="soft-badge"><span className="live-dot" /> LAST 7 DAYS</span></div>
                <div className="week-chart" role="img" aria-label="Focus minutes during the last seven days">
                  {week.map((day, index) => <div className="chart-column" key={`${day.label}-${index}`}><span className="chart-value">{day.minutes ? `${day.minutes}m` : ""}</span><div className="chart-track"><motion.div className={`chart-bar ${day.today ? "today-bar" : ""}`} initial={{ height: 0 }} animate={{ height: `${Math.max(day.minutes ? 9 : 3, (day.minutes / bestDayMinutes) * 100)}%` }} transition={{ duration: .55, delay: index * .05 }} /></div><span className={`chart-label ${day.today ? "today-label" : ""}`}>{day.label}</span></div>)}
                </div>
              </section>
              <section className="glass-panel history-panel">
                <div className="section-heading"><div><h2>Recent sessions</h2><p>Your finished focus blocks.</p></div></div>
                {recentSessions.length ? <div className="session-list">{recentSessions.map((session) => <div className="session-row" key={session.id}><span className="session-check"><Check size={14} /></span><div className="session-copy"><strong>{session.activity}</strong><span>{shortDate(session.finishedAt)}</span></div><span className="session-duration">{session.minutes} min</span><span className="session-coins"><Coins size={13} /> +{session.coins}</span></div>)}</div> : <div className="empty-state"><span className="empty-icon"><Clock3 size={19} /></span><strong>No sessions yet</strong><span>Your focus history will appear here.</span></div>}
              </section>
              <section className="glass-panel settings-panel">
                <div><span className="settings-icon"><Target size={16} /></span><div><strong>Daily focus reward limit</strong><p>Keep focus coin rewards balanced.</p></div></div>
                <div className="cap-control"><input aria-label="Daily coin reward cap" type="number" min="1" max="500" value={dailyCapInput} onChange={(event) => setDailyCapInput(event.target.value)} onKeyDown={(event) => event.key === "Enter" && saveCap()} /><span>coins / day</span><button type="button" onClick={saveCap}>Save</button></div>
              </section>
            </motion.section>
          ) : view === "focus" ? (
            <motion.section key="focus" className="focus-page" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
              <div className="focus-page-top"><span className="eyebrow">MAKE THIS MOMENT COUNT</span><div className="focus-mini-balance"><Coins size={14} /> {data.coins} coins</div></div>
              <FocusTimer active={data.active} remainingSeconds={remainingSeconds} rewardPreview={rewardPreview} onStart={startSession} onPause={pauseSession} onResume={resumeSession} onFinish={finishSession}  />
              <div className="focus-note"><CircleHelp size={14} /><span>Coins grow more slowly as you focus longer. Paused time never counts.</span></div>
            </motion.section>
          ) : (
            <div className="page-content"><p>Choose a section to continue.</p></div>
          )}
        </div>
        <footer className="main-footer"><span>Focus Rewards <span className="brand-period">·</span> focus first, enjoy it after</span><span>{snapshot?.initialized ? "Synced securely to your account" : "Connecting to your account…"}</span></footer>
        {user?.role === "admin" && migrationError && !migrationPreview && <div className="glass-panel migration-notice" role="alert"><strong>Saved data needs review</strong><p>{migrationError}</p></div>}
        {user?.role === "admin" && migrationNotice && <div className="glass-panel migration-notice" role="status"><strong>Migration complete</strong><p>{migrationNotice}</p><button type="button" onClick={() => setMigrationNotice(null)}>Dismiss</button></div>}
        {user?.role === "admin" && migrationPreview && !snapshot?.migrationCompletedAt && <div className="migration-backdrop"><section className="glass-panel migration-dialog" role="dialog" aria-modal="true" aria-labelledby="migration-title"><span className="eyebrow">ONE-TIME ACCOUNT IMPORT</span><h2 id="migration-title">Review your saved rewards</h2><p>We found Focus Rewards data stored on this browser. It will only be imported into the signed-in account shown in the header.</p><dl><div><dt>Current saved balance</dt><dd>{migrationPreview.snapshot.coins} coins</dd></div><div><dt>Wallet event total</dt><dd>{migrationPreview.eventNet} coins</dd></div><div><dt>Balance reconciliation</dt><dd>{migrationPreview.reconcileCoins > 0 ? "+" : ""}{migrationPreview.reconcileCoins} coins</dd></div><div><dt>Tasks / sessions / purchases</dt><dd>{migrationPreview.snapshot.tasks.length} / {migrationPreview.snapshot.sessions.length} / {migrationPreview.snapshot.videoUnlocks.length}</dd></div></dl>{migrationPreview.warnings.map((warning) => <p className="migration-warning" key={warning}>{warning}</p>)}<p className="migration-footnote">Your exact original data will be backed up before import. The backup and localStorage entry are never deleted automatically.</p><div className="migration-actions"><button type="button" className="migration-secondary" onClick={() => setMigrationPreview(null)}>Not now</button><button type="button" disabled={migrationBusy || migrationPreview.reconcileCoins < 0} onClick={() => void confirmLegacyMigration()}>{migrationBusy ? "Importing…" : "Import and reconcile"}</button></div>{migrationError && <p className="migration-warning" role="alert">{migrationError}</p>}</section></div>}
      </main>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        {nav.map(({ id, label, icon: Icon }) => <button key={id} className={view === id ? "mobile-active" : ""} onClick={() => setView(id)}><Icon size={18} strokeWidth={1.8} /><span>{label}</span></button>)}
      </nav>
      <Dialog open={pairingSetupOpen} onOpenChange={(open) => { if (!pairingBusy) setPairingSetupOpen(open); }}>
        <DialogContent className="reward-confirm-dialog">
          <DialogHeader>
            <DialogTitle>Set your YouTube rates</DialogTitle>
            <DialogDescription>These rates are saved to your Focus Rewards account and determine server-calculated charges for new purchases. Prices are rounded up to the next whole Coin.</DialogDescription>
          </DialogHeader>
          {pairingCode ? (
            <div className="extension-pairing-code pairing-code-dialog-result">
              <code aria-label="Single-use extension pairing code">{pairingCode.code}</code>
              <span>Single use · expires {new Date(pairingCode.expiresAt).toLocaleTimeString("de-DE")}</span>
              <button type="button" onClick={() => void copyPairingCode()}>{pairingCodeCopied ? "Copied" : "Copy code"}</button>
            </div>
          ) : (
            <form className="youtube-rate-form" onSubmit={(event) => void createPairingCode(event)}>
              <div className="youtube-rate-field"><Label htmlFor="standard-youtube-rate">Standard videos</Label><div><Input id="standard-youtube-rate" type="number" min="0.01" max="100" step="0.01" required value={standardRateInput} onChange={(event) => setStandardRateInput(event.target.value)} /><span>Coins / min</span></div></div>
              <div className="youtube-rate-field"><Label htmlFor="shorts-youtube-rate">YouTube Shorts</Label><div><Input id="shorts-youtube-rate" type="number" min="0.01" max="100" step="0.01" required value={shortsRateInput} onChange={(event) => setShortsRateInput(event.target.value)} /><span>Coins / min</span></div></div>
              <div className="youtube-rate-field youtube-rate-disabled"><Label htmlFor="flexible-youtube-rate">Flexible usage</Label><div><Input id="flexible-youtube-rate" type="number" min="0.01" max="100" step="0.01" required value={flexibleRateInput} onChange={(event) => setFlexibleRateInput(event.target.value)} /><span>Coins / min</span></div><small>Rate saved for later. Flexible billing stays disabled until progressive settlement, session recovery, and insufficient-balance safeguards are implemented and tested.</small></div>
              <DialogFooter>
                <button type="button" className="migration-secondary" disabled={pairingBusy} onClick={() => setPairingSetupOpen(false)}>Cancel</button>
                <button type="submit" disabled={pairingBusy}>{pairingBusy ? "Saving rates…" : "Save rates and create code"}</button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
      <AlertDialog open={pendingTaskAction !== null} onOpenChange={(open) => { if (!open) setPendingTaskAction(null); }}>
        <AlertDialogContent className="reward-confirm-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{pendingTaskAction?.kind === "complete" ? "Confirm task completion" : "Confirm task reward"}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingTaskAction?.kind === "complete"
                ? `Completing “${pendingTaskAction.title}” will award ${pendingTaskAction.rewardCoins} coins to your wallet. Do you want to proceed?`
                : pendingTaskAction?.kind === "edit"
                  ? `Saving this task will set its reward to ${pendingTaskAction.rewardCoins} coins. Do you want to proceed?`
                  : pendingTaskAction?.kind === "default"
                    ? `New tasks will start with a reward of ${pendingTaskAction.rewardCoins} coins. Do you want to save this reward?`
                    : `This new task will be worth ${pendingTaskAction?.rewardCoins ?? 0} coins. Do you want to save this reward?`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingTaskAction(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmTaskAction}>Confirm</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function FocusTimer({
  active,
  remainingSeconds,
  rewardPreview,
  onStart,
  onPause,
  onResume,
  onFinish,
  compact = false,
}: {
  active: ActiveSession | null;
  remainingSeconds: number;
  rewardPreview: number;
  onStart: (activity: Activity, durationMinutes: number) => void;
  onPause: () => void;
  onResume: () => void;
  onFinish: () => void;
  compact?: boolean;
}) {
  const [selectedActivity, setSelectedActivity] = useState<Activity>("Studying");
  const [selectedDuration, setSelectedDuration] = useState(25);

  function begin() {
    onStart(selectedActivity, selectedDuration);
  }

  const displaySeconds = active ? remainingSeconds : selectedDuration * 60;

  return (
    <div className={`focus-timer-content ${compact ? "compact-timer" : "full-timer"}`}>
      <div className="timer-options">
        <div className="option-group"><span className="option-label">ACTIVITY</span><div className="choice-row">{ACTIVITIES.map((activity) => <button key={activity} disabled={!!active} className={`choice-chip ${((active?.activity ?? selectedActivity) === activity) ? "selected" : ""}`} onClick={() => setSelectedActivity(activity)}>{activity}</button>)}</div></div>
        <div className="option-group duration-options"><span className="option-label">DURATION</span><div className="choice-row">{DURATIONS.map((duration) => <button key={duration} disabled={!!active} className={`choice-chip duration-chip ${((active?.durationMinutes ?? selectedDuration) === duration) ? "selected" : ""}`} onClick={() => setSelectedDuration(duration)}>{duration}<span>m</span></button>)}</div></div>
      </div>
      <div className="timer-face-wrap"><div className={`timer-orbit ${active?.startedAt ? "timer-running" : ""}`}><div className="timer-face"><span className="timer-status">{active ? active.startedAt ? "FOCUSING ON" : "PAUSED AT" : "YOUR NEXT SESSION"}</span><div className="timer-digits">{formatTime(displaySeconds)}</div><span className="timer-activity">{active?.activity ?? selectedActivity} <span>·</span> {active?.durationMinutes ?? selectedDuration} min</span></div></div></div>
      <div className="timer-reward"><span><Coins size={16} /> {active ? "SESSION COIN PREVIEW" : "COIN REWARD PREVIEW"}</span><strong><span>+</span>{rewardPreview} <small>{rewardPreview === 1 ? "coin" : "coins"}</small></strong></div>
      <div className="timer-controls">{!active ? <button className="start-button" onClick={begin}><Play size={16} fill="currentColor" /> Start focus</button> : active.startedAt ? <button className="start-button" onClick={onPause}><Pause size={16} fill="currentColor" /> Pause</button> : <button className="start-button" onClick={onResume}><Play size={16} fill="currentColor" /> Resume</button>}{active && <button className="finish-button" onClick={onFinish}><Square size={13} fill="currentColor" /> Finish session</button>}</div>
      {!compact && <div className="timer-reassurance"><span><Check size={13} /> Active session saves automatically</span><span><Zap size={13} /> Paused minutes never count</span></div>}
    </div>
  );
}
