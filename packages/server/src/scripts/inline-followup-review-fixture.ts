import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { CONVERSATION_SUMMARY_AGENT_KEY } from "../agents/definitions/conversation-summary";
import { DAILY_BRIEF_AGENT_KEY, DAILY_BRIEF_AGENT_VERSION } from "../agents/definitions/daily-brief";
import { localDateInTimezone } from "../agents/run/output-utils";
import { createTaskDurabilityTransitionRepository } from "../db/repositories/task-durability-transition";
import { createTaskRepository } from "../db/repositories/tasks";
import type { DB } from "../db/schema";
import { assertFollowupReviewQaDatabasePath } from "./followup-review-qa-config";

const FIXTURE_LABEL = "Inline follow-up review QA fixture";
const COMPLETION_TITLES = {
  confirmDone: "QA: Confirm completed launch checklist",
  keepOpen: "QA: Keep customer handoff open",
  expired: "QA: Review an expired completion suggestion",
} as const;
const SEED_TITLES = {
  track: "QA: Send launch recap to the customer",
  dismiss: "QA: Remove duplicate launch reminder",
} as const;

export interface InlineFollowupReviewFixtureOptions {
  userId: string;
  now?: Date | string;
  isolateRuntime?: boolean;
}

export interface FollowupReviewQaIsolationResult {
  settingsDisconnected: number;
  usersDisconnected: number;
  connectorsDisabled: number;
  scheduledTasksPaused: number;
  agentConfigsDisabled: number;
  dailyBriefConfigsDisabled: number;
  agentEnvironmentVariablesRemoved: number;
  agentEnvironmentVariableSharesRemoved: number;
  mcpServersRemoved: number;
  whatsappCredentialsRemoved: number;
  whatsappKeysRemoved: number;
}

export interface InlineFollowupReviewFixtureResult {
  userId: string;
  outputDate: string;
  briefOutputId: string;
  sourceOutputId: string;
  reviewCodes: {
    confirmDone: string;
    keepOpen: string;
    expired: string;
    track: string;
    dismiss: string;
    missing: string;
  };
  commands: {
    confirmDone: string;
    keepOpen: string;
    expired: string;
    track: string;
    dismiss: string;
    missing: string;
  };
  runtimeIsolation?: FollowupReviewQaIsolationResult;
  completionRecommendationIds: {
    confirmDone: string;
    keepOpen: string;
    expired: string;
  };
  seedCandidateIds: {
    track: string;
    dismiss: string;
  };
}

function fixtureScope(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 12);
}

function fixtureIds(userId: string) {
  const prefix = `qa-inline-followup-${fixtureScope(userId)}`;
  return {
    prefix,
    briefOutputId: `${prefix}-brief`,
    sourceOutputId: `${prefix}-source`,
    routeId: `${prefix}-route`,
    conversationProviderId: `QA_INLINE_FOLLOWUP_${fixtureScope(userId).toUpperCase()}`,
    completionTaskSourceIds: {
      confirmDone: `${prefix}-task-confirm-done`,
      keepOpen: `${prefix}-task-keep-open`,
      expired: `${prefix}-task-expired`,
    },
    completionRecommendationIds: {
      confirmDone: `${prefix}-recommendation-confirm-done`,
      keepOpen: `${prefix}-recommendation-keep-open`,
      expired: `${prefix}-recommendation-expired`,
    },
  };
}

function reviewCode(seed: string): string {
  return `QA${createHash("sha256").update(seed).digest("hex").slice(0, 6)}`.toUpperCase();
}

function toDate(value: Date | string | undefined): Date {
  const date = value instanceof Date ? new Date(value) : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) throw new Error("Fixture timestamp is invalid.");
  return date;
}

function shiftDays(value: Date, days: number): string {
  return new Date(value.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function fixtureItem(input: {
  id: string;
  outputId: string;
  sectionKey: string;
  title: string;
  summary: string;
  label: string;
  actionLabel: string;
  actionPrompt: string;
  structuredPayload: Record<string, unknown>;
  sortOrder: number;
  taskId?: string | null;
  now: string;
}) {
  return {
    id: input.id,
    agent_output_id: input.outputId,
    task_id: input.taskId ?? null,
    section_key: input.sectionKey,
    title: input.title,
    summary: input.summary,
    priority: "medium",
    label: input.label,
    display_ref: "Manual QA",
    action_type: "chat",
    action_label: input.actionLabel,
    action_prompt: input.actionPrompt,
    knowledge_refs_json: JSON.stringify({ entityIds: [], fileIds: [] }),
    source_url: null,
    structured_payload_json: JSON.stringify(input.structuredPayload),
    sort_order: input.sortOrder,
    created_at: input.now,
  };
}

/** Disables copied background work and live channel/tool credentials in a QA-only database. */
export async function isolateFollowupReviewQaDatabase(
  db: Kysely<DB>,
  now = new Date().toISOString(),
): Promise<FollowupReviewQaIsolationResult> {
  return db.transaction().execute(async (trx) => {
    const settings = await trx
      .updateTable("settings")
      .set({
        slack_bot_token: null,
        slack_app_token: null,
        smtp_host: null,
        smtp_port: null,
        smtp_user: null,
        smtp_password: null,
        smtp_from: null,
        google_oauth_client_id: null,
        google_oauth_client_secret: null,
        microsoft_oauth_client_id: null,
        microsoft_oauth_client_secret: null,
        microsoft_oauth_tenant: null,
        llm_provider: null,
        anthropic_api_key: null,
        aws_access_key_id: null,
        aws_secret_access_key: null,
        aws_region: null,
        model_id: null,
        gemini_api_key: null,
        embedding_provider: null,
        sketch_api_key: null,
        whatsapp_fallback_agent_id: null,
        updated_at: now,
      })
      .executeTakeFirst();
    const disconnectedUsers = await trx
      .updateTable("users")
      .set({ slack_user_id: null, whatsapp_number: null })
      .executeTakeFirst();
    const connectors = await trx
      .updateTable("connector_configs")
      .set({ sync_status: "disabled", updated_at: now })
      .executeTakeFirst();
    const scheduledTasks = await trx
      .updateTable("scheduled_tasks")
      .set({ status: "paused", next_run_at: null, updated_at: now })
      .executeTakeFirst();
    const agentConfigs = await trx
      .updateTable("agent_user_configs")
      .set({ enabled: 0, updated_at: now })
      .executeTakeFirst();
    const users = await trx.selectFrom("users").select("id").execute();
    for (const user of users) {
      await trx
        .insertInto("agent_user_configs")
        .values({
          agent_key: DAILY_BRIEF_AGENT_KEY,
          user_id: user.id,
          enabled: 0,
          updated_at: now,
        })
        .onConflict((oc) =>
          oc.columns(["agent_key", "user_id"]).doUpdateSet({
            enabled: 0,
            updated_at: now,
          }),
        )
        .execute();
    }
    const agentEnvironmentVariableShares = await trx.deleteFrom("agent_environment_variable_shares").executeTakeFirst();
    const agentEnvironmentVariables = await trx.deleteFrom("agent_environment_variables").executeTakeFirst();
    const mcpServers = await trx.deleteFrom("mcp_servers").executeTakeFirst();
    const whatsappCredentials = await trx.deleteFrom("whatsapp_creds").executeTakeFirst();
    const whatsappKeys = await trx.deleteFrom("whatsapp_keys").executeTakeFirst();

    return {
      settingsDisconnected: Number(settings.numUpdatedRows ?? 0),
      usersDisconnected: Number(disconnectedUsers.numUpdatedRows ?? 0),
      connectorsDisabled: Number(connectors.numUpdatedRows ?? 0),
      scheduledTasksPaused: Number(scheduledTasks.numUpdatedRows ?? 0),
      agentConfigsDisabled: Number(agentConfigs.numUpdatedRows ?? 0),
      dailyBriefConfigsDisabled: users.length,
      agentEnvironmentVariablesRemoved: Number(agentEnvironmentVariables.numDeletedRows ?? 0),
      agentEnvironmentVariableSharesRemoved: Number(agentEnvironmentVariableShares.numDeletedRows ?? 0),
      mcpServersRemoved: Number(mcpServers.numDeletedRows ?? 0),
      whatsappCredentialsRemoved: Number(whatsappCredentials.numDeletedRows ?? 0),
      whatsappKeysRemoved: Number(whatsappKeys.numDeletedRows ?? 0),
    };
  });
}

/** Removes only records created by the inline follow-up review QA fixture for one user. */
export async function clearInlineFollowupReviewFixture(db: Kysely<DB>, userId: string): Promise<void> {
  const ids = fixtureIds(userId);
  const taskRows = await db
    .selectFrom("tasks")
    .select("id")
    .where("created_by_user_id", "=", userId)
    .where((eb) =>
      eb.or([
        eb("source_task_id", "in", Object.values(ids.completionTaskSourceIds)),
        eb("origin_agent_output_id", "=", ids.sourceOutputId),
      ]),
    )
    .execute();
  const taskIds = taskRows.map((row) => row.id);

  await db.transaction().execute(async (trx) => {
    await trx
      .deleteFrom("task_seed_candidates")
      .where("agent_key", "=", CONVERSATION_SUMMARY_AGENT_KEY)
      .where("user_id", "=", userId)
      .where("route_id", "=", ids.routeId)
      .execute();
    await trx
      .deleteFrom("task_durability_route_state")
      .where("agent_key", "=", CONVERSATION_SUMMARY_AGENT_KEY)
      .where("user_id", "=", userId)
      .where("route_id", "=", ids.routeId)
      .execute();
    await trx
      .deleteFrom("task_completion_recommendations")
      .where("id", "in", Object.values(ids.completionRecommendationIds))
      .execute();
    if (taskIds.length > 0) await trx.deleteFrom("tasks").where("id", "in", taskIds).execute();
    await trx
      .deleteFrom("agent_outputs")
      .where("id", "in", [ids.briefOutputId, ids.sourceOutputId])
      .where("user_id", "=", userId)
      .execute();
    const conversation = await trx
      .selectFrom("conversations")
      .select("id")
      .where("platform", "=", "slack")
      .where("kind", "=", "channel")
      .where("provider_conversation_id", "=", ids.conversationProviderId)
      .where("display_name", "=", FIXTURE_LABEL)
      .executeTakeFirst();
    if (conversation) {
      await trx.deleteFrom("conversation_messages").where("conversation_id", "=", conversation.id).execute();
      await trx.deleteFrom("conversations").where("id", "=", conversation.id).execute();
    }
  });
}

/** Seeds a repeatable Daily Brief fixture that is immediately actionable through the web review routes. */
export async function seedInlineFollowupReviewFixture(
  db: Kysely<DB>,
  options: InlineFollowupReviewFixtureOptions,
): Promise<InlineFollowupReviewFixtureResult> {
  const nowDate = toDate(options.now);
  const now = nowDate.toISOString();
  const ids = fixtureIds(options.userId);
  const user = await db
    .selectFrom("users")
    .select(["id", "name", "timezone"])
    .where("id", "=", options.userId)
    .executeTakeFirst();
  if (!user) throw new Error(`User ${options.userId} does not exist.`);

  const runtimeIsolation = options.isolateRuntime ? await isolateFollowupReviewQaDatabase(db, now) : undefined;
  await clearInlineFollowupReviewFixture(db, options.userId);

  const timezone = user.timezone ?? "UTC";
  const outputDate = localDateInTimezone(nowDate, timezone);
  const conversation = await db
    .insertInto("conversations")
    .values({
      platform: "slack",
      kind: "channel",
      provider_conversation_id: ids.conversationProviderId,
      display_name: FIXTURE_LABEL,
      last_seen_message_id: null,
      created_at: now,
      updated_at: now,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const sourceKey = `slack:channel:${ids.conversationProviderId}`;
  const messageRows = await db
    .insertInto("conversation_messages")
    .values(
      Object.entries(SEED_TITLES).map(([key, title], index) => ({
        conversation_id: conversation.id,
        provider_message_id: `${ids.prefix}-message-${key}`,
        event_key: null,
        sender_jid: "fixture-sender",
        sender_name: "Fixture Sender",
        sender_user_id: null,
        is_bot: 0,
        addressed_to_sketch: 0,
        text: title,
        attachments: null,
        provider_thread_id: null,
        provider_parent_message_id: null,
        is_thread_reply: 0,
        provider_timestamp: new Date(nowDate.getTime() + index * 1000).toISOString(),
        provider_from_me: 0,
        received_at: new Date(nowDate.getTime() + index * 1000).toISOString(),
        source: "live",
        effective_at: new Date(nowDate.getTime() + index * 1000).toISOString(),
        connection_key: null,
        backfill_range_id: null,
        created_at: now,
      })),
    )
    .returning(["id", "provider_message_id"])
    .execute();
  const messageIdByKey = new Map(
    messageRows.map((row) => [row.provider_message_id.endsWith("-track") ? "track" : "dismiss", row.id]),
  );

  await db
    .insertInto("agent_outputs")
    .values({
      id: ids.sourceOutputId,
      agent_key: CONVERSATION_SUMMARY_AGENT_KEY,
      user_id: options.userId,
      output_date: outputDate,
      period_key: outputDate,
      source_key: sourceKey,
      source_label: "#inline-followup-qa",
      timezone,
      status: "completed",
      trigger_type: "manual",
      agent_version: "inline-followup-review-fixture-v1",
      agent_run_id: null,
      masthead_json: JSON.stringify({ title: "Fixture conversation summary", summary: FIXTURE_LABEL }),
      raw_payload_json: JSON.stringify({ fixture: true }),
      error_message: null,
      generated_at: now,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto("agent_output_items")
    .values(
      Object.entries(SEED_TITLES).map(([key, title], index) => ({
        id: `${ids.prefix}-source-item-${key}`,
        agent_output_id: ids.sourceOutputId,
        task_id: null,
        section_key: "action_items",
        title,
        summary:
          key === "track"
            ? "A valid reconstructed follow-up that should become a durable task."
            : "A duplicate reconstructed follow-up that should be dismissed.",
        priority: "medium",
        label: "action_item",
        display_ref: "#inline-followup-qa",
        action_type: null,
        action_label: null,
        action_prompt: null,
        knowledge_refs_json: JSON.stringify({ entityIds: [], fileIds: [] }),
        source_url: null,
        structured_payload_json: JSON.stringify({
          messageIds: [messageIdByKey.get(key)],
          sourceLabels: ["#inline-followup-qa"],
        }),
        sort_order: index,
        created_at: now,
      })),
    )
    .execute();

  const transition = await createTaskDurabilityTransitionRepository(db).ensureRouteTransition({
    agentKey: CONVERSATION_SUMMARY_AGENT_KEY,
    userId: options.userId,
    routeId: ids.routeId,
    sourceKey,
    sourceKeys: [sourceKey],
    allowedConversationIds: [conversation.id],
    now,
  });
  if (transition.createdCount !== 2) {
    throw new Error(`Expected two seed candidates, created ${transition.createdCount}.`);
  }
  const seedRows = await db
    .selectFrom("task_seed_candidates")
    .select(["id", "title", "review_code"])
    .where("agent_key", "=", CONVERSATION_SUMMARY_AGENT_KEY)
    .where("user_id", "=", options.userId)
    .where("route_id", "=", ids.routeId)
    .execute();
  const seedByTitle = new Map(seedRows.map((row) => [row.title, row]));
  const trackSeed = seedByTitle.get(SEED_TITLES.track);
  const dismissSeed = seedByTitle.get(SEED_TITLES.dismiss);
  if (!trackSeed || !dismissSeed) throw new Error("Fixture seed candidates were not created.");
  const reviewCodes = {
    confirmDone: reviewCode(`${ids.prefix}-confirmDone`),
    keepOpen: reviewCode(`${ids.prefix}-keepOpen`),
    expired: reviewCode(`${ids.prefix}-expired`),
    track: trackSeed.review_code,
    dismiss: dismissSeed.review_code,
    missing: "QANOTFOUND",
  };
  const commands = {
    confirmDone: `Confirm done ${reviewCodes.confirmDone}`,
    keepOpen: `Keep open ${reviewCodes.keepOpen}`,
    expired: `Confirm done ${reviewCodes.expired}`,
    track: `Track ${reviewCodes.track}`,
    dismiss: `Dismiss ${reviewCodes.dismiss}`,
    missing: `Dismiss ${reviewCodes.missing}`,
  };

  const tasks = createTaskRepository(db);
  const completionTaskEntries = await Promise.all(
    (Object.keys(COMPLETION_TITLES) as Array<keyof typeof COMPLETION_TITLES>).map(async (key) => {
      const result = await tasks.upsertTask({
        parentEntityId: null,
        parentSourceRef: null,
        parentName: null,
        source: "summary",
        externalRef: null,
        title: COMPLETION_TITLES[key],
        status: "open",
        statusRaw: "open",
        statusAuthority: "local",
        assigneeEntityId: null,
        assigneeName: null,
        priority: "medium",
        dueAt: null,
        provenance: "summary",
        sourceTaskId: ids.completionTaskSourceIds[key],
        createdByUserId: options.userId,
      });
      return [key, result.taskId] as const;
    }),
  );
  const completionTaskIds = Object.fromEntries(completionTaskEntries) as Record<keyof typeof COMPLETION_TITLES, string>;
  await db
    .insertInto("task_completion_recommendations")
    .values(
      (Object.keys(COMPLETION_TITLES) as Array<keyof typeof COMPLETION_TITLES>).map((key) => ({
        id: ids.completionRecommendationIds[key],
        task_id: completionTaskIds[key],
        proposed_status: "done",
        review_state: "pending",
        review_code: reviewCodes[key],
        evidence_fingerprint: `${ids.prefix}-evidence-${key}`,
        origin_agent_output_id: ids.sourceOutputId,
        rationale:
          key === "expired"
            ? "This recommendation intentionally expired before the manual QA session."
            : "Fixture evidence suggests this follow-up may be complete.",
        delivery_count: 0,
        expires_at: key === "expired" ? shiftDays(nowDate, -1) : shiftDays(nowDate, 7),
        reviewed_at: null,
        reviewed_by_user_id: null,
        review_surface: null,
        created_at: now,
        updated_at: now,
      })),
    )
    .execute();

  await db
    .insertInto("agent_outputs")
    .values({
      id: ids.briefOutputId,
      agent_key: DAILY_BRIEF_AGENT_KEY,
      user_id: options.userId,
      output_date: outputDate,
      period_key: outputDate,
      source_key: "",
      source_label: null,
      timezone,
      status: "completed",
      trigger_type: "manual",
      agent_version: DAILY_BRIEF_AGENT_VERSION,
      agent_run_id: null,
      masthead_json: JSON.stringify({
        title: "Inline follow-up review QA",
        summary: "Deterministic manual-test data for completion recommendations and seed candidates.",
        generatedFor: user.name,
      }),
      raw_payload_json: JSON.stringify({ fixture: true }),
      error_message: null,
      generated_at: now,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto("agent_output_items")
    .values([
      fixtureItem({
        id: `${ids.prefix}-brief-confirm-done`,
        outputId: ids.briefOutputId,
        sectionKey: "looks_resolved",
        title: COMPLETION_TITLES.confirmDone,
        summary: "Use Mark as done to verify the task becomes done and the terminal label persists.",
        label: "looks_resolved",
        actionLabel: "Review with Sketch",
        actionPrompt: commands.confirmDone,
        structuredPayload: {
          serverOwnedFollowup: true,
          trackingState: "looks_resolved",
          recommendationId: ids.completionRecommendationIds.confirmDone,
          reviewCode: reviewCodes.confirmDone,
          taskId: completionTaskIds.confirmDone,
        },
        sortOrder: 0,
        taskId: completionTaskIds.confirmDone,
        now,
      }),
      fixtureItem({
        id: `${ids.prefix}-brief-keep-open`,
        outputId: ids.briefOutputId,
        sectionKey: "looks_resolved",
        title: COMPLETION_TITLES.keepOpen,
        summary: "Use Keep open to verify rejection leaves the durable task actionable.",
        label: "looks_resolved",
        actionLabel: "Review with Sketch",
        actionPrompt: commands.keepOpen,
        structuredPayload: {
          serverOwnedFollowup: true,
          trackingState: "looks_resolved",
          recommendationId: ids.completionRecommendationIds.keepOpen,
          reviewCode: reviewCodes.keepOpen,
          taskId: completionTaskIds.keepOpen,
        },
        sortOrder: 1,
        taskId: completionTaskIds.keepOpen,
        now,
      }),
      fixtureItem({
        id: `${ids.prefix}-brief-expired`,
        outputId: ids.briefOutputId,
        sectionKey: "looks_resolved",
        title: COMPLETION_TITLES.expired,
        summary: "This item should render Review expired without mutation controls.",
        label: "looks_resolved",
        actionLabel: "Review with Sketch",
        actionPrompt: commands.expired,
        structuredPayload: {
          serverOwnedFollowup: true,
          trackingState: "looks_resolved",
          recommendationId: ids.completionRecommendationIds.expired,
          reviewCode: reviewCodes.expired,
          taskId: completionTaskIds.expired,
        },
        sortOrder: 2,
        taskId: completionTaskIds.expired,
        now,
      }),
      fixtureItem({
        id: `${ids.prefix}-brief-track`,
        outputId: ids.briefOutputId,
        sectionKey: "untracked_followups",
        title: SEED_TITLES.track,
        summary: "Use Track to create and hydrate the canonical durable task.",
        label: "untracked",
        actionLabel: "Discuss with Sketch",
        actionPrompt: commands.track,
        structuredPayload: {
          serverOwnedFollowup: true,
          trackingState: "untracked",
          candidateId: trackSeed.id,
          reviewCode: trackSeed.review_code,
        },
        sortOrder: 0,
        now,
      }),
      fixtureItem({
        id: `${ids.prefix}-brief-dismiss`,
        outputId: ids.briefOutputId,
        sectionKey: "untracked_followups",
        title: SEED_TITLES.dismiss,
        summary: "Use Dismiss to verify the terminal outcome replaces mutation controls.",
        label: "untracked",
        actionLabel: "Discuss with Sketch",
        actionPrompt: commands.dismiss,
        structuredPayload: {
          serverOwnedFollowup: true,
          trackingState: "untracked",
          candidateId: dismissSeed.id,
          reviewCode: dismissSeed.review_code,
        },
        sortOrder: 1,
        now,
      }),
      fixtureItem({
        id: `${ids.prefix}-brief-legacy`,
        outputId: ids.briefOutputId,
        sectionKey: "untracked_followups",
        title: "QA: Legacy chat-only follow-up",
        summary: "This item intentionally has no durable review record and should remain chat-only.",
        label: "untracked",
        actionLabel: "Discuss with Sketch",
        actionPrompt: "Discuss the legacy follow-up",
        structuredPayload: { trackingState: "untracked" },
        sortOrder: 2,
        now,
      }),
    ])
    .execute();

  return {
    userId: options.userId,
    outputDate,
    briefOutputId: ids.briefOutputId,
    sourceOutputId: ids.sourceOutputId,
    reviewCodes,
    commands,
    ...(runtimeIsolation ? { runtimeIsolation } : {}),
    completionRecommendationIds: ids.completionRecommendationIds,
    seedCandidateIds: {
      track: trackSeed.id,
      dismiss: dismissSeed.id,
    },
  };
}

async function backupDatabase(dbPath: string): Promise<string> {
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const backupPath = join(dirname(dbPath), `${basename(dbPath)}.inline-followup-review-${stamp}.bak`);
  const source = new Database(dbPath, { readonly: true });
  try {
    await source.backup(backupPath);
  } finally {
    source.close();
  }
  return backupPath;
}

async function assertFixtureSchema(db: Kysely<DB>): Promise<void> {
  const migrations = await sql<{ name: string }>`
    SELECT name
    FROM kysely_migration
    WHERE name IN ('150-task-durability-steel-thread', '151-agent-output-item-task-links')
  `.execute(db);
  if (migrations.rows.length !== 2) {
    throw new Error("Database is missing migrations 150 and 151 required by this fixture.");
  }
}

async function findUserId(db: Kysely<DB>, userId?: string, userEmail?: string): Promise<string> {
  if (!userId && !userEmail) throw new Error("Pass --user-id or --user-email.");
  let query = db.selectFrom("users").select(["id", "email"]);
  if (userId) query = query.where("id", "=", userId);
  else query = query.where("email", "=", userEmail as string);
  const user = await query.executeTakeFirst();
  if (!user) throw new Error("Target user was not found.");
  return user.id;
}

async function runCli(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      db: { type: "string" },
      "user-id": { type: "string" },
      "user-email": { type: "string" },
      "isolate-runtime": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (parsed.values.help) {
    console.log(
      "Usage: pnpm fixture:followup-review -- <seed|clear> --db /absolute/path/sketch.db " +
        "(--user-id ID | --user-email EMAIL) [--isolate-runtime]",
    );
    return;
  }
  const command = parsed.positionals[0] ?? "seed";
  if (command !== "seed" && command !== "clear") throw new Error("Command must be seed or clear.");
  const dbPath = parsed.values.db;
  if (!dbPath || !isAbsolute(dbPath)) throw new Error("Pass an absolute SQLite path with --db.");
  assertFollowupReviewQaDatabasePath(dbPath);
  await access(dbPath);
  const backupPath = await backupDatabase(dbPath);
  const sqlite = new Database(dbPath);
  sqlite.pragma("foreign_keys = ON");
  const db = new Kysely<DB>({ dialect: new SqliteDialect({ database: sqlite }) });
  try {
    await assertFixtureSchema(db);
    const userId = await findUserId(db, parsed.values["user-id"], parsed.values["user-email"]);
    if (command === "clear") {
      await clearInlineFollowupReviewFixture(db, userId);
      console.log(JSON.stringify({ command, userId, backupPath }, null, 2));
      return;
    }
    const result = await seedInlineFollowupReviewFixture(db, {
      userId,
      isolateRuntime: parsed.values["isolate-runtime"],
    });
    console.log(JSON.stringify({ command, backupPath, ...result }, null, 2));
  } finally {
    await db.destroy();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
