import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { Infer, v } from "convex/values";

// default user roles. can add / remove based on the project as needed
export const ROLES = {
  ADMIN: "admin",
  USER: "user",
  MEMBER: "member",
} as const;

export const roleValidator = v.union(
  v.literal(ROLES.ADMIN),
  v.literal(ROLES.USER),
  v.literal(ROLES.MEMBER),
);
export type Role = Infer<typeof roleValidator>;

const schema = defineSchema(
  {
    // default auth tables using convex auth.
    ...authTables, // do not remove or modify

    // the users table is the default users table that is brought in by the authTables
    users: defineTable({
      name: v.optional(v.string()), // auth-provided name; legacy field retained
      displayName: v.optional(v.string()), // onboarding name, independent from auth identity
      onboardingCompletedAt: v.optional(v.number()),
      deactivatedAt: v.optional(v.number()),
      deactivatedBy: v.optional(v.id("users")),
      youtubePricingRates: v.optional(v.object({
        standardCoinsPerMinute: v.number(),
        shortsCoinsPerMinute: v.number(),
        flexibleCoinsPerMinute: v.number(),
      })),
      image: v.optional(v.string()), // image of the user. do not remove
      email: v.optional(v.string()), // email of the user. do not remove
      emailVerificationTime: v.optional(v.number()), // email verification time. do not remove
      isAnonymous: v.optional(v.boolean()), // is the user anonymous. do not remove

      role: v.optional(roleValidator), // role of the user. do not remove
    }).index("email", ["email"]), // index for the email. do not remove or modify

    accountData: defineTable({
      userId: v.id("users"),
      coins: v.number(),
      dailyCap: v.number(),
      taskBonus: v.number(),
      migrationCompletedAt: v.optional(v.number()),
      migrationReport: v.optional(v.object({
        importedTasks: v.number(),
        importedSessions: v.number(),
        importedPurchases: v.number(),
        reconciledCoins: v.number(),
        oldBalance: v.number(),
        eventNet: v.number(),
      })),
    }).index("by_user", ["userId"]),

    tasks: defineTable({
      userId: v.id("users"),
      legacyId: v.optional(v.string()),
      title: v.string(),
      completed: v.boolean(),
      completedAt: v.union(v.number(), v.null()),
      rewardCoins: v.number(),
      rewardAwarded: v.optional(v.boolean()),
    }).index("by_user", ["userId"]).index("by_user_legacy", ["userId", "legacyId"]),

    focusSessions: defineTable({
      userId: v.id("users"),
      legacyId: v.optional(v.string()),
      activity: v.string(),
      durationMinutes: v.number(),
      elapsedMs: v.number(),
      startedAt: v.union(v.number(), v.null()),
      status: v.union(v.literal("active"), v.literal("complete"), v.literal("cancelled")),
      minutes: v.optional(v.number()),
      coins: v.optional(v.number()),
      finishedAt: v.optional(v.number()),
    }).index("by_user", ["userId"]).index("by_user_legacy", ["userId", "legacyId"]),

    walletTransactions: defineTable({
      userId: v.id("users"),
      amount: v.number(),
      type: v.union(
        v.literal("focus_reward"), v.literal("task_reward"), v.literal("library_purchase"),
        v.literal("legacy_focus_reward"), v.literal("legacy_task_reward"),
        v.literal("legacy_library_purchase"), v.literal("legacy_reconciliation"), v.literal("youtube_purchase"),
        v.literal("youtube_flexible_reservation"), v.literal("youtube_flexible_refund"),
      ),
      description: v.string(),
      referenceType: v.optional(v.string()),
      referenceId: v.optional(v.string()),
      idempotencyKey: v.string(),
      createdAt: v.number(),
    }).index("by_user_time", ["userId", "createdAt"]).index("by_user_idempotency", ["userId", "idempotencyKey"]),

    libraryPurchases: defineTable({
      userId: v.id("users"),
      rewardId: v.string(),
      cost: v.number(),
      purchasedAt: v.number(),
      idempotencyKey: v.string(),
      contentType: v.optional(v.union(v.literal("youtube_video"), v.literal("youtube_short"))),
      contentId: v.optional(v.string()),
      videoTitle: v.optional(v.string()),
      durationSeconds: v.optional(v.number()),
      entitlementDays: v.optional(v.number()),
      entitlementHours: v.optional(v.number()),
      youtubeRateCoinsPerMinute: v.optional(v.number()),
      transactionId: v.optional(v.id("walletTransactions")),
      expiresAt: v.optional(v.number()),
      revokedAt: v.optional(v.number()),
    }).index("by_user", ["userId"]).index("by_user_reward", ["userId", "rewardId"]).index("by_user_idempotency", ["userId", "idempotencyKey"]).index("by_user_content", ["userId", "contentType", "contentId"]),

    betaAccess: defineTable({
      // userId-backed records are the per-account source of truth. Email-only
      // records hold admin pre-approvals/revocations until an email account exists.
      userId: v.optional(v.id("users")),
      email: v.optional(v.string()),
      status: v.union(v.literal("pending"), v.literal("approved"), v.literal("revoked")),
      requestedAt: v.number(),
      updatedAt: v.number(),
      approvedAt: v.optional(v.number()),
      updatedBy: v.optional(v.id("users")),
      requesterName: v.optional(v.string()),
      invitationId: v.optional(v.id("betaInvitations")),
      invitationCodeLabel: v.optional(v.string()),
    }).index("by_user", ["userId"]).index("by_email", ["email"]).index("by_status", ["status"]),

    betaInvitations: defineTable({
      codeHash: v.string(),
      recipientEmail: v.optional(v.string()),
      createdBy: v.id("users"),
      createdAt: v.number(),
      expiresAt: v.number(),
      revokedAt: v.optional(v.number()),
      usedAt: v.optional(v.number()),
      claimedBy: v.optional(v.id("users")),
      codeLabel: v.optional(v.string()),
    }).index("by_hash", ["codeHash"]).index("by_creator_time", ["createdBy", "createdAt"]).index("by_expiry", ["expiresAt"]),

    extensionPairingCodes: defineTable({
      codeHash: v.string(),
      userId: v.id("users"),
      createdAt: v.number(),
      expiresAt: v.number(),
      usedAt: v.optional(v.number()),
      revokedAt: v.optional(v.number()),
    }).index("by_hash", ["codeHash"]).index("by_user", ["userId"]),

    extensionSessions: defineTable({
      tokenHash: v.string(),
      userId: v.id("users"),
      createdAt: v.number(),
      expiresAt: v.number(),
      revokedAt: v.optional(v.number()),
    }).index("by_hash", ["tokenHash"]).index("by_user", ["userId"]),

    shortsAccessSessions: defineTable({
      userId: v.id("users"),
      expiresAt: v.number(),
      updatedAt: v.number(),
    }).index("by_user", ["userId"]),

    shortsAccessGrants: defineTable({
      userId: v.id("users"),
      idempotencyKey: v.string(),
      minutes: v.number(),
      cost: v.number(),
      expiresAt: v.number(),
      createdAt: v.number(),
    }).index("by_user_idempotency", ["userId", "idempotencyKey"]),

    flexibleUsageSessions: defineTable({
      userId: v.id("users"),
      ownerTabId: v.number(),
      ownershipEpoch: v.number(),
      recoveryTokenHash: v.string(),
      status: v.union(v.literal("active"), v.literal("stopped"), v.literal("expired"), v.literal("insufficient")),
      startIdempotencyKey: v.string(),
      startOperationKey: v.string(),
      rateCoinsPerMinute: v.number(),
      startedAt: v.number(),
      maxExpiresAt: v.number(),
      updatedAt: v.number(),
      sequence: v.number(),
      leaseStartedAt: v.number(),
      leaseExpiresAt: v.number(),
      authorizedMs: v.number(),
      chargedCoins: v.number(),
      reservedCoins: v.number(),
      latestOperationKey: v.string(),
      stopOperationKey: v.optional(v.string()),
      stoppedAt: v.optional(v.number()),
      stopReason: v.optional(v.union(v.literal("user"), v.literal("expired"), v.literal("max-duration"), v.literal("insufficient"))),
    }).index("by_user", ["userId"]).index("by_user_status", ["userId", "status"])
      .index("by_user_start_key", ["userId", "startIdempotencyKey"]),

    flexibleUsageRecoveries: defineTable({
      userId: v.id("users"),
      sessionId: v.id("flexibleUsageSessions"),
      operationKey: v.string(),
      previousEpoch: v.number(),
      ownershipEpoch: v.number(),
      previousTabId: v.number(),
      ownerTabId: v.number(),
      outcome: v.union(v.literal("recovered"), v.literal("expired"), v.literal("insufficient")),
      settledAt: v.number(),
      authorizedMs: v.number(),
      chargedCoins: v.number(),
      refundedCoins: v.number(),
      createdAt: v.number(),
    }).index("by_session_operation", ["sessionId", "operationKey"])
      .index("by_user", ["userId"]),

    flexibleUsageIntervals: defineTable({
      userId: v.id("users"),
      sessionId: v.id("flexibleUsageSessions"),
      sequence: v.number(),
      operationKey: v.string(),
      startedAt: v.number(),
      expiresAt: v.number(),
      reservedCoins: v.number(),
      status: v.union(v.literal("authorized"), v.literal("settled"), v.literal("released")),
      consumedMs: v.optional(v.number()),
      chargedCoins: v.optional(v.number()),
      refundedCoins: v.optional(v.number()),
      completedAt: v.optional(v.number()),
      createdAt: v.number(),
    }).index("by_session_sequence", ["sessionId", "sequence"])
      .index("by_user_operation", ["userId", "operationKey"]),

    youtubePurchaseQuotes: defineTable({
      userId: v.id("users"),
      videoId: v.string(),
      contentType: v.union(v.literal("youtube_video"), v.literal("youtube_short")),
      durationSeconds: v.number(),
      videoTitle: v.optional(v.string()),
      rateCoinsPerMinute: v.number(),
      price: v.number(),
      createdAt: v.number(),
      expiresAt: v.number(),
      redeemedAt: v.optional(v.number()),
      idempotencyKey: v.optional(v.string()),
    }).index("by_user", ["userId"]).index("by_expiry", ["expiresAt"]),

  },
  {
    schemaValidation: false,
  },
);

export default schema;
