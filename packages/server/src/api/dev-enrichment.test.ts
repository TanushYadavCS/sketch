import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../auth/password";
import type { GeminiGenerator, GenerateOptions } from "../connectors/gemini-generate";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { clearTraceRuns } from "../dev/enrichment-trace";
import { createApp } from "../http";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";

const logger = createTestLogger();
const ADMIN_ID = "admin-user";
const MEMBER_ID = "member-user";
const ADMIN_EMAIL = "admin@test.com";
const MEMBER_EMAIL = "member@test.com";
const PASSWORD = "testpassword123";

async function seedUsers(db: Kysely<DB>) {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  const hash = await hashPassword(PASSWORD);
  await settings.create();
  await users.create({
    id: ADMIN_ID,
    name: "admin",
    email: ADMIN_EMAIL,
    emailVerified: true,
    passwordHash: hash,
    authRole: "admin",
  });
  await users.create({
    id: MEMBER_ID,
    name: "member",
    email: MEMBER_EMAIL,
    emailVerified: true,
    passwordHash: hash,
    authRole: "member",
  });
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });
}

async function login(app: ReturnType<typeof createApp>, email: string): Promise<string> {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return res.headers.get("set-cookie") ?? "";
}

async function seedTraceFile(db: Kysely<DB>, fileId = `file-${randomUUID()}`): Promise<string> {
  const productNames = Array.from({ length: 25 }, (_, index) => `Trace Product ${String(index).padStart(2, "0")}`);
  await db
    .insertInto("connector_configs")
    .values({
      id: "trace-connector",
      connector_type: "google_drive",
      auth_type: "oauth",
      credentials: "{}",
      created_by: ADMIN_ID,
    })
    .onConflict((oc) => oc.doNothing())
    .execute();
  await db
    .insertInto("entities")
    .values(
      productNames.map((name, index) => ({
        id: `product-${index}`,
        name,
        source_type: "product",
        subtype: null,
        aliases: null,
        metadata: null,
        source_ref_id: `product-${index}`,
        status: "confirmed",
        provenance_tier: "declared",
        hotness: 100 - index,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })),
    )
    .execute();
  const content = `${productNames.join(" ")} ${Array.from({ length: 130 }, (_, index) => `context${index}`).join(" ")}`;
  await db
    .insertInto("indexed_files")
    .values({
      id: fileId,
      connector_config_id: "trace-connector",
      provider_file_id: fileId,
      provider_url: null,
      file_name: "Trace Product Notes",
      file_type: "text",
      content_category: "document",
      source: "google_drive",
      source_path: "My Drive/Trace Product Notes",
      content,
      summary: null,
      context_note: null,
      content_hash: `hash-${fileId}`,
      source_created_at: new Date().toISOString(),
      source_updated_at: new Date().toISOString(),
      synced_at: new Date().toISOString(),
      access_scope_id: null,
    })
    .execute();
  return fileId;
}

function dumpWritingGenerator(opts: { throwOnEntityFacts?: boolean } = {}): GeminiGenerator {
  async function writeDump(prompt: string, options: GenerateOptions | undefined, text: string) {
    if (!options?.dumpDir) return;
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const safeLabel = (options.label ?? "unlabeled").replace(/[^a-zA-Z0-9_-]/g, "_");
    await mkdir(options.dumpDir, { recursive: true });
    await writeFile(
      join(options.dumpDir, `${ts}__${safeLabel}.json`),
      JSON.stringify(
        {
          label: options.label ?? "unlabeled",
          prompt,
          systemPrompt: options.systemPrompt,
          maxTokens: options.maxTokens ?? 8192,
          text,
          finishReason: "STOP",
          promptTokens: 11,
          candidatesTokens: 7,
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  return {
    async generate(prompt, options) {
      const text = "Trace Product Notes discusses Trace Product 00.";
      await writeDump(prompt, options, text);
      return text;
    },
    async generateJSON<T>(prompt: string, options?: Omit<GenerateOptions, "responseMimeType">) {
      if (options?.label?.startsWith("extractEntityFacts") && opts.throwOnEntityFacts) {
        throw new Error("entity facts exploded");
      }
      const value = options?.label?.startsWith("extractEntities")
        ? {
            mentions: [{ mention: "Trace Product 00", type: "product", variations: [], confidence: 0.97 }],
            relations: [],
          }
        : options?.label?.startsWith("dedupAdjudicate")
          ? [{ mention: "M1", matchesKnown: "K1" }]
          : {};
      await writeDump(prompt, options, JSON.stringify(value));
      return value as T;
    },
  };
}

/**
 * Records the label of every model call, which is how a test tells "extraction
 * ran" from "the endpoint returned success and skipped it".
 */
function labelRecordingGenerator(labels: string[]): GeminiGenerator {
  return {
    async generate(_prompt, options) {
      labels.push(options?.label ?? "unlabeled");
      return "Trace Product Notes discusses Trace Product 00.";
    },
    async generateJSON<T>(_prompt: string, options?: Omit<GenerateOptions, "responseMimeType">) {
      labels.push(options?.label ?? "unlabeled");
      const value = options?.label?.startsWith("extractEntities")
        ? {
            mentions: [{ mention: "Trace Product 00", type: "product", variations: [], confidence: 0.97 }],
            relations: [],
          }
        : {};
      return value as T;
    },
  };
}

/** Returns one task the fact pipeline can act on, and one it must refuse. */
function mintGenerator(): GeminiGenerator {
  return {
    async generate() {
      return "";
    },
    async generateJSON<T>(_prompt: string, options?: Omit<GenerateOptions, "responseMimeType">) {
      if (!options?.label?.startsWith("extractLlmTask")) return {} as T;
      return {
        tasks: [
          {
            title: "Send the trace product brief",
            hasOwnerVerbObject: true,
            owner: { name: "Ada Trace", email: "ada@trace.test" },
            sourceExcerpt: "Ada will send the brief.",
          },
          { title: "Unowned follow-up", hasOwnerVerbObject: false },
        ],
      } as T;
    },
  };
}

async function startRun(app: ReturnType<typeof createApp>, cookie: string, fileId: string): Promise<string> {
  const start = await app.request("/api/dev/runs", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ fileId }),
  });
  expect(start.status).toBe(201);
  return ((await start.json()) as { runId: string }).runId;
}

async function waitForRun(app: ReturnType<typeof createApp>, cookie: string, runId: string) {
  await vi.waitFor(
    async () => {
      const res = await app.request(`/api/dev/runs/${runId}`, { headers: { Cookie: cookie } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        run: { status: string };
        stageReports: Array<{
          stage: string;
          status: string;
          error?: string;
          materializeSummary?: { eligibleFacts: number; indexBuilds: number; scopeKeyReads: number };
        }>;
      };
      expect(body.run.status).not.toBe("running");
    },
    { timeout: 10_000, interval: 25 },
  );
  const res = await app.request(`/api/dev/runs/${runId}`, { headers: { Cookie: cookie } });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    run: { status: string; kind: string };
    stageReports: Array<{
      stage: string;
      status: string;
      error?: string;
      materializeSummary?: { eligibleFacts: number; indexBuilds: number; scopeKeyReads: number };
      context?: Array<{ key: string }>;
      outcomes?: Array<{ result: string; reason?: string }>;
    }>;
  };
}

describe("Dev enrichment trace routes", () => {
  let db: Kysely<DB>;
  let dataDir: string;

  beforeEach(async () => {
    db = await createTestDb();
    dataDir = join(tmpdir(), `sketch-dev-enrichment-${randomUUID()}`);
    clearTraceRuns();
    await seedUsers(db);
  });

  afterEach(async () => {
    clearTraceRuns();
    try {
      await db.destroy();
    } catch {}
  });

  it("serves a model stage with its prompt, output, parsed JSON, and capped context report", async () => {
    const fileId = await seedTraceFile(db);
    const app = createApp(db, createTestConfig({ DEV_TOOLS_ENABLED: true, DATA_DIR: dataDir }), {
      logger,
      enrichmentGenerator: dumpWritingGenerator(),
    });
    const cookie = await login(app, ADMIN_EMAIL);

    const runId = await startRun(app, cookie, fileId);
    const runBody = await waitForRun(app, cookie, runId);

    const callsRes = await app.request(`/api/dev/runs/${runId}/calls`, { headers: { Cookie: cookie } });
    expect(callsRes.status).toBe(200);
    const callsBody = (await callsRes.json()) as { calls: Array<{ seq: number; stage: string; promptChars: number }> };
    const extractCall = callsBody.calls.find((call) => call.stage === "extractEntities");
    expect(extractCall).toBeTruthy();
    for (const call of callsBody.calls) {
      expect(Object.keys(call)).not.toContain("prompt");
      expect(Object.keys(call)).not.toContain("text");
      expect(Object.keys(call)).not.toContain("systemPrompt");
    }

    const callRes = await app.request(`/api/dev/runs/${runId}/calls/${extractCall?.seq}`, {
      headers: { Cookie: cookie },
    });
    expect(callRes.status).toBe(200);
    const callBody = (await callRes.json()) as {
      call: { prompt: string; text: string; parsed: { mentions: unknown[] }; promptChars: number };
    };
    const runHeader = await app.request(`/api/dev/runs/${runId}`, { headers: { Cookie: cookie } });
    const { run } = (await runHeader.json()) as { run: { dumpDir: string } };
    const dumpFiles = (await readdir(run.dumpDir)).filter((name) => name.includes("extractEntities")).sort();
    const onDisk = JSON.parse(await readFile(join(run.dumpDir, dumpFiles[0]), "utf8")) as { prompt: string };
    expect(callBody.call.prompt).toBe(onDisk.prompt);
    expect(callBody.call.promptChars).toBe(Buffer.byteLength(onDisk.prompt, "utf8"));
    expect(callBody.call.text).toContain("Trace Product 00");

    const facts = await db
      .selectFrom("indexed_file_facts")
      .select("id")
      .where("indexed_file_id", "=", fileId)
      .where("fact_type", "=", "llm_extracted")
      .where("deleted_at", "is", null)
      .execute();
    expect(callBody.call.parsed.mentions).toHaveLength(facts.length);

    const extractReport = runBody.stageReports.find((report) => report.stage === "extractEntities") as
      | { context?: Array<{ key: string; total: number; items: string[]; truncated?: boolean }> }
      | undefined;
    const knownBlock = extractReport?.context?.find((block) => block.key === "knownEntities");
    expect(knownBlock?.total).toBeGreaterThan(knownBlock?.items.length ?? 0);
    expect(knownBlock?.truncated).toBe(true);
    expect(runBody.stageReports.find((report) => report.stage === "materialize")?.materializeSummary).toMatchObject({
      eligibleFacts: expect.any(Number),
      indexBuilds: expect.any(Number),
      scopeKeyReads: expect.any(Number),
    });
  });

  it("does not expose call payloads through either dev-tools gate", async () => {
    const hiddenApp = createApp(db, createTestConfig({ DEV_TOOLS_ENABLED: false }), { logger });
    const adminCookie = await login(hiddenApp, ADMIN_EMAIL);
    const hiddenList = await hiddenApp.request("/api/dev/runs/run/calls", {
      headers: { Cookie: adminCookie },
    });
    const hiddenBody = await hiddenApp.request("/api/dev/runs/run/calls/1", {
      headers: { Cookie: adminCookie },
    });
    expect(hiddenList.status).toBe(404);
    expect(hiddenBody.status).toBe(404);

    const flaggedApp = createApp(db, createTestConfig({ DEV_TOOLS_ENABLED: true }), { logger });
    const memberCookie = await login(flaggedApp, MEMBER_EMAIL);
    const forbiddenList = await flaggedApp.request("/api/dev/runs/run/calls", {
      headers: { Cookie: memberCookie },
    });
    const forbiddenBody = await flaggedApp.request("/api/dev/runs/run/calls/1", {
      headers: { Cookie: memberCookie },
    });
    expect(forbiddenList.status).toBe(403);
    expect(forbiddenBody.status).toBe(403);
  });

  it("keeps a run readable when a later model stage throws without writing a dump", async () => {
    const fileId = await seedTraceFile(db);
    const app = createApp(db, createTestConfig({ DEV_TOOLS_ENABLED: true, DATA_DIR: dataDir }), {
      logger,
      enrichmentGenerator: dumpWritingGenerator({ throwOnEntityFacts: true }),
    });
    const cookie = await login(app, ADMIN_EMAIL);

    const runId = await startRun(app, cookie, fileId);
    const runBody = await waitForRun(app, cookie, runId);
    expect(runBody.run.status).toBe("failed");
    expect(runBody.stageReports.find((report) => report.stage === "extractEntityFacts")).toMatchObject({
      status: "failed",
      error: "entity facts exploded",
    });
    expect(runBody.stageReports.find((report) => report.stage === "engagementFloor")).toMatchObject({
      status: "skipped",
    });
    expect(runBody.stageReports.find((report) => report.stage === "materialize")).toMatchObject({ status: "skipped" });

    const callsRes = await app.request(`/api/dev/runs/${runId}/calls`, { headers: { Cookie: cookie } });
    const callsBody = (await callsRes.json()) as { calls: Array<{ seq: number; stage: string }> };
    expect(callsBody.calls.some((call) => call.stage === "extractEntityFacts")).toBe(false);
    const extractCall = callsBody.calls.find((call) => call.stage === "extractEntities");
    expect(extractCall).toBeTruthy();

    const callRes = await app.request(`/api/dev/runs/${runId}/calls/${extractCall?.seq}`, {
      headers: { Cookie: cookie },
    });
    expect(callRes.status).toBe(200);
    expect(((await callRes.json()) as { call: { prompt: string } }).call.prompt).toContain("Trace Product Notes");
  });
  it("re-extracts through the per-file enrich endpoint when the summary is already resolved", async () => {
    const fileId = await seedTraceFile(db);
    const labels: string[] = [];
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger,
      enrichmentGenerator: labelRecordingGenerator(labels),
    });
    const cookie = await login(app, ADMIN_EMAIL);

    for (const status of ["done", "skipped"] as const) {
      labels.length = 0;
      await db.updateTable("indexed_files").set({ summary_status: status }).where("id", "=", fileId).execute();

      const res = await app.request(`/api/connectors/files/${fileId}/enrichments`, {
        method: "POST",
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);

      await vi.waitFor(() => expect(labels.some((label) => label.startsWith("extractEntities"))).toBe(true), {
        timeout: 10_000,
        interval: 25,
      });

      /**
       * The endpoint answers before enrichment finishes. Wait for the run to
       * settle rather than tearing the database down underneath it — these
       * tests share a worker, so work that outlives its test fails another one.
       */
      await vi.waitFor(
        async () => {
          const row = await db
            .selectFrom("indexed_files")
            .select("summary_status")
            .where("id", "=", fileId)
            .executeTakeFirst();
          expect(row?.summary_status).not.toBe("pending");
        },
        { timeout: 10_000, interval: 25 },
      );
    }
  });

  it("reports minting as four stages, including the candidates the write stage refused", async () => {
    const fileId = await seedTraceFile(db);
    const app = createApp(db, createTestConfig({ DEV_TOOLS_ENABLED: true, DATA_DIR: dataDir }), {
      logger,
      enrichmentGenerator: mintGenerator(),
    });
    const cookie = await login(app, ADMIN_EMAIL);

    const start = await app.request("/api/dev/runs", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ fileId, kind: "mint" }),
    });
    expect(start.status).toBe(201);
    const runId = ((await start.json()) as { runId: string }).runId;

    const body = await waitForRun(app, cookie, runId);
    expect(body.run.status).toBe("done");
    expect(body.run.kind).toBe("mint");
    expect(body.stageReports.map((report) => report.stage)).toEqual([
      "neighbourhood",
      "gatherContext",
      "extractCandidates",
      "writeCandidates",
    ]);

    const gather = body.stageReports.find((report) => report.stage === "gatherContext");
    expect(gather?.context?.map((block) => block.key)).toContain("existing_tasks");

    const write = body.stageReports.find((report) => report.stage === "writeCandidates");
    expect(write?.outcomes?.length).toBe(2);
    for (const outcome of write?.outcomes ?? []) {
      expect(outcome.result).toBeTruthy();
    }

    const listRes = await app.request("/api/dev/runs", { headers: { Cookie: cookie } });
    const list = (await listRes.json()) as { runs: Array<{ id: string; kind: string }> };
    expect(list.runs.find((run) => run.id === runId)?.kind).toBe("mint");
  });
});

describe("POST /api/dev/search-runs", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUsers(db);
  });

  afterEach(async () => {
    try {
      await db.destroy();
    } catch {
      // already destroyed
    }
  });

  async function seedSearchable(id: string, source = "notion", category = "document") {
    await db
      .insertInto("connector_configs")
      .values({ id: "sc-1", connector_type: source, auth_type: "oauth", credentials: "{}", created_by: ADMIN_ID })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
    await db
      .insertInto("indexed_files")
      .values({
        id,
        connector_config_id: "sc-1",
        provider_file_id: id,
        file_name: `auth migration ${id}.txt`,
        file_type: "text",
        content_category: category,
        source,
        source_path: `/${id}`,
        provider_url: null,
        content: "notes about the auth migration",
        summary: null,
        context_note: null,
        access_scope_id: null,
        source_updated_at: new Date().toISOString(),
        synced_at: new Date().toISOString(),
      })
      .execute();
  }

  it("runs a real search and returns its finished trace", async () => {
    const app = createApp(db, createTestConfig({ DEV_TOOLS_ENABLED: true }), { logger });
    const cookie = await login(app, ADMIN_EMAIL);
    await seedSearchable("sf-1");

    const res = await app.request("/api/dev/search-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ query: "auth" }),
    });
    expect(res.status).toBe(201);

    const body = (await res.json()) as { trace: { id: string; origin: string; query: string; stages: unknown[] } };
    expect(body.trace.origin).toBe("dev_tools");
    expect(body.trace.query).toBe("auth");
    expect(body.trace.stages.length).toBeGreaterThan(0);

    const listed = await app.request("/api/dev/search-traces", { headers: { Cookie: cookie } });
    const listBody = (await listed.json()) as { traces: Array<{ id: string }> };
    expect(listBody.traces.map((trace) => trace.id)).toContain(body.trace.id);
  });

  it("records a trace even when the search returns nothing", async () => {
    const app = createApp(db, createTestConfig({ DEV_TOOLS_ENABLED: true }), { logger });
    const cookie = await login(app, ADMIN_EMAIL);

    const res = await app.request("/api/dev/search-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ query: "nothing will match this" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { trace: { status: string } };
    expect(["done", "empty"]).toContain(body.trace.status);
  });

  it("is 404 without the flag and 403 for a member", async () => {
    const hidden = createApp(db, createTestConfig({ DEV_TOOLS_ENABLED: false }), { logger });
    const adminCookie = await login(hidden, ADMIN_EMAIL);
    const off = await hidden.request("/api/dev/search-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ query: "auth" }),
    });
    expect(off.status).toBe(404);

    const app = createApp(db, createTestConfig({ DEV_TOOLS_ENABLED: true }), { logger });
    const memberCookie = await login(app, MEMBER_EMAIL);
    const denied = await app.request("/api/dev/search-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: memberCookie },
      body: JSON.stringify({ query: "auth" }),
    });
    expect(denied.status).toBe(403);
  });
});
