import { runAgent } from "../src/agent/runner";
import type { RunAgentParams, RunAgentResult } from "../src/agent/runner";
import { resolveAgentRuntimeProviderConfigFromSettings } from "../src/agent/runtime/provider";
/**
 * Daily-brief E2E on REAL data. Seeds durable follow-up state with one live
 * summariser run over the indexed #core channel, then runs the daily brief live
 * and inspects every section — with emphasis on the durable follow-up wiring:
 *   - tracked durable tasks  -> todos (pending)
 *   - completion suggestions -> looks_resolved
 *   - not-yet-tracked items  -> untracked_followups
 *
 * Waits for each output to reach a TERMINAL status (completed/failed) before
 * reading, so the brief's async persistence never races db.destroy().
 * Delivery is never wired (destination off + no outputDelivery dep).
 *
 * Usage (Node 24, bedrock creds):
 *   SQLITE_PATH=/abs/path/db.db pnpm --filter @sketch/server exec \
 *     tsx scripts/run-daily-brief-e2e.ts <userId> <channelId>
 */
import { AgentRunService } from "../src/agents/service";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db";
import { createAgentOutputRepository } from "../src/db/repositories/agent-outputs";
import { createSettingsRepository } from "../src/db/repositories/settings";
import { createUserRepository } from "../src/db/repositories/users";
import { createLogger } from "../src/logger";

const SUMMARY_KEY = "conversation_summary";
const BRIEF_KEY = "daily_brief";
const ROUTE_ID = "real-data-e2e";

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function requireAbs(p: string | undefined, what: string): string {
  if (!p || !p.startsWith("/")) throw new Error(`Pass an ABSOLUTE ${what}.`);
  return p;
}

async function main() {
  const userId = process.argv[2];
  const channelId = process.argv[3];
  if (!userId || !channelId) throw new Error("Usage: run-daily-brief-e2e.ts <userId> <channelId>");
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

  const service = new AgentRunService({
    db,
    config,
    logger,
    users,
    settings: settingsRepo,
    runAgent: wrappedRunAgent,
    getSlack: (() => ({
      listChannels: async () => [{ id: channelId, name: "core", isMember: true }],
      isUserInChannel: async () => true,
    })) as never,
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

    console.log("=== Seeding durable state: one summariser run ===");
    await runToTerminal(db, service, SUMMARY_KEY, userId);
    const tasks = await db
      .selectFrom("tasks")
      .select(["title", "assignee_name", "proposed_assignee_name"])
      .where("provenance", "=", "summary")
      .where("source", "=", "summary")
      .where("valid_to", "is", null)
      .execute();
    console.log(`  durable tasks now: ${tasks.length}`);
    for (const t of tasks) console.log(`    - ${t.assignee_name ?? t.proposed_assignee_name ?? "-"}: ${t.title}`);
    const routeMode = await db.selectFrom("task_durability_route_state").select("mode").executeTakeFirst();
    console.log(`  route mode: ${routeMode?.mode ?? "(none)"}`);

    console.log("\n=== Running daily brief live ===");
    const briefIds = await runToTerminal(db, service, BRIEF_KEY, userId);

    for (const id of briefIds) {
      const out = await outputRepo.getByIdForHumanUser(BRIEF_KEY, id);
      if (!out || out.output.status !== "completed") {
        console.log(`  brief ${id.slice(0, 8)} -> ${out?.output.status} (${out?.output.error_message ?? ""})`);
        process.exitCode = 1;
        continue;
      }
      console.log(`\n  brief ${id.slice(0, 8)} -> completed`);
      console.log(`  masthead: ${out.masthead?.title ?? "(none)"}`);
      const bySection = new Map<string, typeof out.items>();
      for (const it of out.items) bySection.set(it.section_key, [...(bySection.get(it.section_key) ?? []), it]);
      console.log(`  sections: ${[...bySection.entries()].map(([k, v]) => `${k}=${v.length}`).join(", ")}`);

      for (const section of ["todos", "untracked_followups", "looks_resolved"] as const) {
        const items = bySection.get(section) ?? [];
        console.log(`\n  [${section}] ${items.length}`);
        for (const it of items) {
          const payload = (it.structured_payload_json ? JSON.parse(it.structured_payload_json) : {}) as Record<
            string,
            unknown
          >;
          const tracking = payload.trackingState ? ` trackingState=${payload.trackingState}` : "";
          const taskId = payload.taskId ? ` taskId=${String(payload.taskId).slice(0, 8)}` : "";
          console.log(`      - "${it.title}"${tracking}${taskId}`);
        }
      }

      console.log("\n  ===== ASSERTIONS =====");
      const todos = bySection.get("todos") ?? [];
      const untracked = bySection.get("untracked_followups") ?? [];
      const trackedTodos = todos.filter((it) => {
        const p = it.structured_payload_json ? JSON.parse(it.structured_payload_json) : {};
        return p.trackingState === "tracked" || Boolean(p.taskId);
      });
      assert(out.output.status === "completed", "brief generated successfully");
      assert(
        tasks.length === 0 || trackedTodos.length > 0,
        `durable tasks surface as tracked todos (${trackedTodos.length})`,
      );
      assert(
        untracked.length <= tasks.length,
        `untracked_followups (${untracked.length}) not more than tracked tasks (${tasks.length})`,
      );
    }
    console.log("\n=== DONE ===\n");
  } finally {
    await sleep(1500);
    await db.destroy();
  }
}

async function runToTerminal(
  db: Awaited<ReturnType<typeof createDatabase>>,
  service: AgentRunService,
  agentKey: string,
  userId: string,
): Promise<string[]> {
  const rows = await service.requestGenerationForUser({
    agentKey,
    userId,
    triggerType: "manual",
    skipIfCompleted: false,
  });
  const ids: string[] = [];
  for (const row of rows) {
    const status = await waitForTerminal(db, agentKey, row.id);
    console.log(`  ${agentKey} ${row.id.slice(0, 8)} -> ${status}`);
    ids.push(row.id);
  }
  return ids;
}

async function waitForTerminal(
  db: Awaited<ReturnType<typeof createDatabase>>,
  agentKey: string,
  outputId: string,
  timeoutMs = 420_000,
): Promise<string> {
  const deadline = RealDate.now() + timeoutMs;
  while (RealDate.now() < deadline) {
    const row = await db
      .selectFrom("agent_outputs")
      .select("status")
      .where("id", "=", outputId)
      .where("agent_key", "=", agentKey)
      .executeTakeFirst();
    if (row && (row.status === "completed" || row.status === "failed")) {
      await sleep(6000);
      return row.status;
    }
    await sleep(2000);
  }
  return "timeout";
}

function assert(cond: boolean, label: string): void {
  console.log(`    ${cond ? "PASS" : "FAIL"} — ${label}`);
  if (!cond) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
