import { Kysely, PostgresDialect } from "kysely";
import type { KyselyPlugin, PluginTransformQueryArgs, PluginTransformResultArgs } from "kysely";
import type { QueryResult, RootOperationNode, UnknownRow } from "kysely";
import { hashPassword } from "../auth/password";
import { runMigrations } from "../db/migrate";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestLogger } from "../test-utils";

const DB_NAME = process.env.MEASURE_DB ?? "sketch_queue_reconcile";
const EMAIL = "queue-measure@local.test";
const PASSWORD = "queue-measure-pass-123";

class CountingPlugin implements KyselyPlugin {
  count = 0;
  armed = false;
  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    if (this.armed) this.count += 1;
    return args.node;
  }
  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return args.result;
  }
}

async function main(): Promise<void> {
  const { Pool } = await import("pg");
  const counter = new CountingPlugin();
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString: `postgres://localhost:5432/${DB_NAME}` }) }),
    plugins: [counter],
  });

  await runMigrations(db, { quiet: true });

  const before = await snapshot(db);
  console.log("BEFORE", JSON.stringify(before, null, 2));

  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  const existing = await users.findByEmail(EMAIL);
  if (!existing) {
    await users.create({
      name: "queue measure",
      email: EMAIL,
      emailVerified: true,
      passwordHash: await hashPassword(PASSWORD),
      authRole: "admin",
      skipEntityLinking: true,
    });
  }
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });

  const app = createApp(db, createTestConfig({ DB_TYPE: "postgres" }), { logger: createTestLogger() });
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (login.status !== 200) throw new Error(`login failed: ${login.status} ${await login.text()}`);
  const cookie = login.headers.get("set-cookie") ?? "";

  counter.armed = true;
  const startedAt = Date.now();
  const res = await app.request("/api/graph-passes/queue-runs", { method: "POST", headers: { Cookie: cookie } });
  const elapsedMs = Date.now() - startedAt;
  counter.armed = false;
  const body = await res.text();
  console.log("RUN", res.status, body);
  console.log("STATEMENTS", counter.count, "ELAPSED_MS", elapsedMs);

  const after = await snapshot(db);
  console.log("AFTER", JSON.stringify(after, null, 2));

  for (const n of [2, 3]) {
    const again = await app.request("/api/graph-passes/queue-runs", { method: "POST", headers: { Cookie: cookie } });
    console.log(`RUN${n}`, again.status, await again.text());
    console.log(`AFTER${n}`, JSON.stringify(await snapshot(db), null, 2));
  }

  await db.destroy();
}

async function snapshot(db: Kysely<DB>) {
  const byStatus = await db
    .selectFrom("entity_review_queue")
    .select(["status", (eb) => eb.fn.countAll<number>().as("n")])
    .groupBy("status")
    .orderBy("status")
    .execute();
  const byReason = await db
    .selectFrom("entity_review_queue")
    .select(["pass_reason", (eb) => eb.fn.countAll<number>().as("n")])
    .where("pass_reason", "is not", null)
    .groupBy("pass_reason")
    .orderBy("pass_reason")
    .execute();
  const graph = {
    entities: await count(db, "entities"),
    entity_mentions: await count(db, "entity_mentions"),
    entity_relationships: await count(db, "entity_relationships"),
  };
  return { byStatus, byReason, graph };
}

async function count(db: Kysely<DB>, table: "entities" | "entity_mentions" | "entity_relationships"): Promise<number> {
  const row = await db
    .selectFrom(table)
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
