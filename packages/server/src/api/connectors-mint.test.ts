/**
 * The product mint route.
 *
 * Two things matter here and nothing else does: the request comes back before
 * minting finishes, and the response carries no pipeline detail. The audit
 * story moved to /dev-tools, and this is the surface a tenant can reach.
 */
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../auth/password";
import type { GeminiGenerator, GenerateOptions } from "../connectors/gemini-generate";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";

const logger = createTestLogger();
const ADMIN_ID = "admin-user";
const ADMIN_EMAIL = "admin@test.com";
const PASSWORD = "testpassword123";

async function seedAdmin(db: Kysely<DB>) {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  await settings.create();
  await users.create({
    id: ADMIN_ID,
    name: "admin",
    email: ADMIN_EMAIL,
    emailVerified: true,
    passwordHash: await hashPassword(PASSWORD),
    authRole: "admin",
  });
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });
}

async function seedFile(db: Kysely<DB>): Promise<string> {
  const fileId = `file-${randomUUID()}`;
  await db
    .insertInto("connector_configs")
    .values({
      id: "mint-connector",
      connector_type: "google_drive",
      auth_type: "oauth",
      credentials: "{}",
      created_by: ADMIN_ID,
    })
    .onConflict((oc) => oc.doNothing())
    .execute();
  await db
    .insertInto("indexed_files")
    .values({
      id: fileId,
      connector_config_id: "mint-connector",
      provider_file_id: fileId,
      provider_url: null,
      file_name: "Mint Notes",
      file_type: "text",
      content_category: "document",
      source: "google_drive",
      source_path: "My Drive/Mint Notes",
      content: "Ada will send the trace product brief before Friday.",
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

async function login(app: ReturnType<typeof createApp>): Promise<string> {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: PASSWORD }),
  });
  return res.headers.get("set-cookie") ?? "";
}

/** Holds the model call open so the test can prove the response did not wait for it. */
function gatedGenerator(gate: Promise<void>, calls: string[]): GeminiGenerator {
  return {
    async generate() {
      return "";
    },
    async generateJSON<T>(_prompt: string, options?: Omit<GenerateOptions, "responseMimeType">) {
      calls.push(options?.label ?? "unlabeled");
      await gate;
      return { tasks: [{ title: "Send the trace product brief", hasOwnerVerbObject: true }] } as T;
    },
  };
}

describe("POST /api/connectors/files/:fileId/tasks", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedAdmin(db);
  });

  afterEach(async () => {
    try {
      await db.destroy();
    } catch {}
  });

  it("answers before minting finishes", async () => {
    const fileId = await seedFile(db);
    const calls: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = createApp(db, createTestConfig(), { logger, taskMintingGenerator: gatedGenerator(gate, calls) });
    const cookie = await login(app);

    const res = await app.request(`/api/connectors/files/${fileId}/tasks`, {
      method: "POST",
      headers: { Cookie: cookie },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, fileId, fileName: "Mint Notes" });

    await vi.waitFor(() => expect(calls.some((label) => label.startsWith("extractLlmTask"))).toBe(true), {
      timeout: 10_000,
      interval: 25,
    });

    release();
    await vi.waitFor(
      async () => {
        const fact = await db
          .selectFrom("indexed_file_facts")
          .select("id")
          .where("indexed_file_id", "=", fileId)
          .where("fact_type", "=", "llm_task")
          .executeTakeFirst();
        expect(fact).toBeTruthy();
      },
      { timeout: 10_000, interval: 25 },
    );
  });

  it("returns no pipeline detail to the caller", async () => {
    const fileId = await seedFile(db);
    const calls: string[] = [];
    const app = createApp(db, createTestConfig(), {
      logger,
      taskMintingGenerator: gatedGenerator(Promise.resolve(), calls),
    });
    const cookie = await login(app);

    const res = await app.request(`/api/connectors/files/${fileId}/tasks`, {
      method: "POST",
      headers: { Cookie: cookie },
    });

    const body = (await res.json()) as Record<string, unknown>;
    for (const key of ["context", "candidates", "similarFiles", "dumpDir", "model", "written"]) {
      expect(Object.keys(body)).not.toContain(key);
    }

    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0), { timeout: 10_000, interval: 25 });
  });
});
