import { runAgent } from "../src/agent/runner";
import type { RunAgentParams, RunAgentResult } from "../src/agent/runner";
import { resolveAgentRuntimeProviderConfigFromSettings } from "../src/agent/runtime/provider";
import { AgentRunService } from "../src/agents/service";
/**
 * Two-pass durable-followups E2E on REAL data (Slack #core channel).
 *
 * Uses the persisted conversation_summary config (Slack channel source, route
 * `real-data-e2e`, createTasks, delivery off) already in the DB. Runs the
 * summariser TWICE to prove: run 1 creates durable tasks + evidence + flips the
 * route hybrid->durable; run 2 creates NO duplicates and NO new evidence. Then
 * runs the daily brief and reports untracked_followups.
 *
 * No Slack/WhatsApp delivery is wired (destination kind:off + no outputDelivery
 * dep). getSlack is stubbed so the channel source resolves without a live client.
 *
 * Usage (Node 24, bedrock creds):
 *   export NVM_DIR=~/.nvm; . ~/.nvm/nvm.sh; nvm use 24
 *   eval "$(aws configure export-credentials --profile canvas-ai --format env)"
 *   AWS_REGION=us-east-1 SQLITE_PATH=/abs/path/db.db \
 *     tsx packages/server/scripts/run-durable-followups-e2e.ts <userId> <channelId>
 */
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db";
import { createAgentOutputRepository } from "../src/db/repositories/agent-outputs";
import { createSettingsRepository } from "../src/db/repositories/settings";
import { createUserRepository } from "../src/db/repositories/users";
import { createLogger } from "../src/logger";

const SUMMARY_KEY = "conversation_summary";
const BRIEF_KEY = "daily_brief";
const ROUTE_ID = "real-data-e2e";
const LOOKBACK_HOURS = 168;

/**
 * The indexed #core messages span 2026-06-03..2026-07-03. The summariser window
 * is [now - 168h, now], so anchor "now" just after the last message to put the
 * final week of real activity in-window (matching the prior manual run). Manual
 * triggers floor the window back to the period, so run 2 re-sees the same
 * messages and exercises replay-dedup.
 */
const RealDate = Date;
const FROZEN_NOW = new RealDate("2026-07-03T18:00:00.000Z").getTime();
class FrozenDate extends RealDate {
  constructor(...args: ConstructorParameters<typeof Date>) {
    if (args.length === 0) super(FROZEN_NOW);
    else super(...(args as [number]));
  }
  static now(): number {
    return FROZEN_NOW;
  }
}
globalThis.Date = FrozenDate as DateConstructor;

function requireAbs(p: string | undefined, what: string): string {
  if (!p || !p.startsWith("/")) throw new Error(`Pass an ABSOLUTE ${what}.`);
  return p;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const userId = process.argv[2];
  const channelId = process.argv[3];
  if (!userId || !channelId) throw new Error("Usage: run-durable-followups-e2e.ts <userId> <channelId>");
  process.env.SQLITE_PATH = requireAbs(process.env.SQLITE_PATH, "SQLITE_PATH");
  process.env.DB_TYPE = "sqlite";

  const config = loadConfig();
  const logger = createLogger(config);
  const db = await createDatabase(config);
  const users = createUserRepository(db);
  const settingsRepo = createSettingsRepository(db, config.ENCRYPTION_KEY);
  const outputRepo = createAgentOutputRepository(db);

  const wrappedRunAgent = async (params: RunAgentParams): Promise<RunAgentResult> =>
    runAgent({
      ...params,
      loadAgentRuntimeProviderConfig: async () =>
        resolveAgentRuntimeProviderConfigFromSettings(await settingsRepo.get()),
    });

  const slackStub = {
    listChannels: async () => [{ id: channelId, name: "core", isMember: true }],
    isUserInChannel: async () => true,
  };

  const service = new AgentRunService({
    db,
    config,
    logger,
    users,
    settings: settingsRepo,
    runAgent: wrappedRunAgent,
    getSlack: (() => slackStub) as never,
    getWhatsApp: (() => ({ getGroupMetadata: async () => null })) as never,
  });

  const summaryPrefs = {
    sources: [{ platform: "slack", targetType: "channel", targetId: channelId, label: "core" }],
    createTasks: true,
    routes: [
      {
        id: ROUTE_ID,
        sources: [`slack:channel:${channelId}`],
        focus: null,
        sections: null,
        maxItemsPerSection: null,
        schedule: { frequency: "weekly", hour: 0, minute: 0, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] },
        destination: { kind: "off" },
        enabled: true,
      },
    ],
  };

  try {
    const now = new Date().toISOString();
    for (const [agentKey, prefs] of [
      [SUMMARY_KEY, JSON.stringify(summaryPrefs)],
      [BRIEF_KEY, JSON.stringify({ createTasks: true })],
    ] as const) {
      await db
        .insertInto("agent_user_configs")
        .values({
          agent_key: agentKey,
          user_id: userId,
          enabled: 1,
          schedule_hour: 8,
          schedule_minute: 0,
          prefs_json: prefs,
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) =>
          oc.columns(["agent_key", "user_id"]).doUpdateSet({ enabled: 1, prefs_json: prefs, updated_at: now }),
        )
        .execute();
    }
    console.log(`Configured ${SUMMARY_KEY} (slack:channel:${channelId}, route ${ROUTE_ID}) + ${BRIEF_KEY}`);

    await runSummariser(db, service, outputRepo, userId, 1);
    const snap1 = await snapshot(db, userId, channelId);
    console.log(`\n--- after run 1: ${describeSnap(snap1)}`);

    await runSummariser(db, service, outputRepo, userId, 2);
    const snap2 = await snapshot(db, userId, channelId);
    console.log(`\n--- after run 2: ${describeSnap(snap2)}`);

    console.log("\n================ ASSERTIONS ================");
    assert(snap1.tasks > 0, `run 1 created durable tasks (${snap1.tasks})`);
    assert(snap1.evidence > 0, `run 1 attached message evidence (${snap1.evidence})`);
    assert(snap1.routeMode.startsWith("durable"), `route flipped out of hybrid (got ${snap1.routeMode})`);
    assert(snap2.tasks === snap1.tasks, `run 2 created NO duplicate tasks (${snap1.tasks} -> ${snap2.tasks})`);
    assert(snap2.evidence === snap1.evidence, `run 2 added NO new evidence (${snap1.evidence} -> ${snap2.evidence})`);

    console.log("\n=== minted durable tasks (final) ===");
    for (const t of snap2.taskRows) {
      const who = t.assignee_name ?? t.proposed_assignee_name ?? "(unassigned)";
      console.log(`  [${t.status}] owner:${who.padEnd(18)} ev:${t.ev}  "${t.title}"`);
    }

    // ---- daily brief: untracked_followups should no longer list tracked items ----
    console.log(`\n=== Running ${BRIEF_KEY} live ===`);
    const briefRows = await service.requestGenerationForUser({
      agentKey: BRIEF_KEY,
      userId,
      triggerType: "manual",
      skipIfCompleted: false,
    });
    for (const row of briefRows) {
      await waitForOutput(db, BRIEF_KEY, row.id);
      const out = await outputRepo.getByIdForHumanUser(BRIEF_KEY, row.id);
      if (out?.output.status === "completed") {
        const bySection = new Map<string, number>();
        for (const it of out.items) bySection.set(it.section_key, (bySection.get(it.section_key) ?? 0) + 1);
        console.log(`  brief sections: ${[...bySection.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}`);
        console.log(`  untracked_followups = ${bySection.get("untracked_followups") ?? 0}`);
        for (const it of out.items.filter((i) => i.section_key === "untracked_followups"))
          console.log(`      untracked: ${it.title}`);
      } else {
        console.log(`  brief FAILED: ${out?.output.error_message ?? "unknown"}`);
      }
    }
    console.log("\n=== DONE ===\n");
  } finally {
    await db.destroy();
  }
}

async function runSummariser(
  db: Awaited<ReturnType<typeof createDatabase>>,
  service: AgentRunService,
  outputRepo: ReturnType<typeof createAgentOutputRepository>,
  userId: string,
  pass: number,
): Promise<void> {
  console.log(`\n=== Summariser run ${pass} ===`);
  const rows = await service.requestGenerationForUser({
    agentKey: SUMMARY_KEY,
    userId,
    triggerType: "manual",
    skipIfCompleted: false,
  });
  console.log(`  ${rows.length} scope(s) queued`);
  for (const row of rows) {
    await waitForOutput(db, SUMMARY_KEY, row.id);
    const out = await outputRepo.getByIdForHumanUser(SUMMARY_KEY, row.id);
    console.log(`  output ${row.id.slice(0, 8)} -> ${out?.output.status}`);
    if (out?.output.status !== "completed") console.log(`  FAILED: ${out?.output.error_message ?? "unknown"}`);
  }
}

type Snap = {
  tasks: number;
  evidence: number;
  routeMode: string;
  taskRows: Array<{
    title: string;
    status: string;
    assignee_name: string | null;
    proposed_assignee_name: string | null;
    ev: number;
  }>;
};

async function snapshot(
  db: Awaited<ReturnType<typeof createDatabase>>,
  userId: string,
  channelId: string,
): Promise<Snap> {
  void channelId;
  const taskRows = await db
    .selectFrom("tasks")
    .select(["id", "title", "status", "assignee_name", "proposed_assignee_name"])
    .where("provenance", "=", "summary")
    .where("source", "=", "summary")
    .where("valid_to", "is", null)
    .orderBy("created_at", "asc")
    .execute();
  const withEv = [];
  let evidence = 0;
  for (const t of taskRows) {
    const row = await db
      .selectFrom("task_message_evidence")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("task_id", "=", t.id)
      .executeTakeFirstOrThrow();
    evidence += Number(row.n);
    withEv.push({ ...t, ev: Number(row.n) });
  }
  const route = await db
    .selectFrom("task_durability_route_state")
    .select("mode")
    .where("user_id", "=", userId)
    .where("route_id", "=", ROUTE_ID)
    .executeTakeFirst();
  return { tasks: taskRows.length, evidence, routeMode: route?.mode ?? "(none)", taskRows: withEv };
}

function describeSnap(s: Snap): string {
  return `tasks=${s.tasks} evidence=${s.evidence} routeMode=${s.routeMode}`;
}

function assert(cond: boolean, label: string): void {
  console.log(`  ${cond ? "PASS" : "FAIL"} — ${label}`);
  if (!cond) process.exitCode = 1;
}

async function waitForOutput(
  db: Awaited<ReturnType<typeof createDatabase>>,
  agentKey: string,
  outputId: string,
  timeoutMs = 300_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await db
      .selectFrom("agent_outputs")
      .select("status")
      .where("id", "=", outputId)
      .where("agent_key", "=", agentKey)
      .executeTakeFirst();
    if (row && row.status !== "running") {
      await sleep(8000);
      return row.status;
    }
    await sleep(2000);
  }
  return "timeout";
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
