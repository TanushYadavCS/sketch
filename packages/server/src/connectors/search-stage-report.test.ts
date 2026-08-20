/**
 * The stage reports search emits for the dev-tools trace.
 *
 * The load-bearing assertions here are the negative ones: that the reporting path costs
 * nothing when no reporter is attached, and that a candidate the metadata SQL silently
 * dropped still comes back with a name and a reason.
 */
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import type { StageReport } from "./enrichment-stage-report";
import { search } from "./search";

let db: Kysely<DB>;

async function insertFile(
  id: string,
  overrides: { source?: string; fileType?: string; category?: string; name?: string } = {},
) {
  await db
    .insertInto("indexed_files")
    .values({
      id,
      connector_config_id: "connector-1",
      provider_file_id: id,
      file_name: overrides.name ?? `auth migration ${id}.txt`,
      file_type: overrides.fileType ?? "text",
      content_category: overrides.category ?? "document",
      source: overrides.source ?? "notion",
      source_path: `/${id}`,
      provider_url: null,
      content: "quarterly planning notes about the auth migration",
      summary: null,
      context_note: null,
      access_scope_id: null,
      source_updated_at: new Date().toISOString(),
      synced_at: new Date().toISOString(),
    })
    .execute();
}

beforeEach(async () => {
  db = await createTestDb();
  await db
    .insertInto("connector_configs")
    .values({
      id: "connector-1",
      connector_type: "notion",
      auth_type: "oauth",
      credentials: "{}",
      created_by: "admin",
    })
    .execute();
});

afterEach(async () => {
  try {
    await db.destroy();
  } catch {
    // already destroyed
  }
});

describe("search stage reporting", () => {
  it("costs no extra query, and emits nothing, when no reporter is attached", async () => {
    await insertFile("file-a");
    let queries = 0;
    const counting = db.withPlugin({
      transformQuery: (queryArgs) => queryArgs.node,
      transformResult: async (queryResult) => {
        queries += 1;
        return queryResult.result;
      },
    });

    /** Warm-up: the settings read is cached after the first call, which would otherwise
     * mask the one query the attribution path adds. */
    await search(counting, "auth", { limit: 5 });

    queries = 0;
    const plainResults = await search(counting, "auth", { limit: 5 });
    const withoutReporter = queries;

    queries = 0;
    const reports: StageReport[] = [];
    const tracedResults = await search(counting, "auth", {
      limit: 5,
      stageReport: (report) => reports.push(report),
    });
    const withReporter = queries;

    expect(reports.length).toBeGreaterThan(0);
    expect(withReporter).toBe(withoutReporter + 1);
    expect(tracedResults.map((result) => result.id)).toEqual(plainResults.map((result) => result.id));
  });

  it("reports each stage once, in pipeline order", async () => {
    await insertFile("file-a");
    const reports: StageReport[] = [];
    await search(db, "auth", { limit: 5, stageReport: (report) => reports.push(report) });

    const stages = reports.map((report) => report.stage);
    expect(new Set(stages).size).toBe(stages.length);
    expect(stages).toContain("ftsCandidates");
    expect(stages).toContain("fuse");
    expect(stages).toContain("filter");
    expect(stages).toContain("finalize");
    expect(stages.indexOf("ftsCandidates")).toBeLessThan(stages.indexOf("fuse"));
    expect(stages.indexOf("fuse")).toBeLessThan(stages.indexOf("filter"));
    expect(stages.indexOf("filter")).toBeLessThan(stages.indexOf("finalize"));
  });

  it("skips embedQuery with a reason when no embedding provider is configured", async () => {
    await insertFile("file-a");
    const reports: StageReport[] = [];
    await search(db, "auth", { limit: 5, stageReport: (report) => reports.push(report) });

    const embed = reports.find((report) => report.stage === "embedQuery");
    expect(embed?.status).toBe("skipped");
    expect(embed?.error).toBeTruthy();
  });

  it("names a candidate the metadata filter dropped, and says why", async () => {
    /**
     * `category` is deliberately the filter under test. `kind` and `source` are pushed
     * down into the FTS query, so a mismatch never becomes a candidate in the first place;
     * `category` is applied only in the metadata SQL, which is exactly the path where a
     * scored candidate vanishes without leaving its name behind.
     */
    await insertFile("doc-file", { category: "document", name: "auth design doc.txt" });
    await insertFile("image-file", { category: "image", name: "auth whiteboard.txt" });

    const reports: StageReport[] = [];
    await search(db, "auth", {
      limit: 5,
      category: "document",
      stageReport: (report) => reports.push(report),
    });

    const candidates = reports.find((report) => report.stage === "finalize")?.candidates ?? [];
    const dropped = candidates.find((candidate) => candidate.fileId === "image-file");
    expect(dropped).toBeDefined();
    expect(dropped?.droppedAt).toBe("filter");
    expect(dropped?.dropReason).toBe("category is image, not document");
    expect(dropped?.fileName).toBe("auth whiteboard.txt");

    const kept = candidates.find((candidate) => candidate.fileId === "doc-file");
    expect(kept?.droppedAt).toBeNull();
  });

  it("marks a file the access filter denied", async () => {
    await insertFile("file-a");
    const reports: StageReport[] = [];
    await search(db, "auth", {
      limit: 5,
      userPrincipals: [{ type: "email", value: "nobody@example.com" }],
      stageReport: (report) => reports.push(report),
    });

    const rbac = reports.find((report) => report.stage === "rbac");
    expect(rbac?.status).toBe("done");
    const candidates = reports.find((report) => report.stage === "finalize")?.candidates ?? [];
    for (const candidate of candidates) {
      if (candidate.droppedAt === "rbac") expect(candidate.dropReason).toBe("no matching access principal");
    }
  });

  it("reports resolveEntities as skipped when the search was not entity-scoped", async () => {
    await insertFile("file-a");
    const reports: StageReport[] = [];
    await search(db, "auth", { limit: 5, stageReport: (report) => reports.push(report) });

    const resolve = reports.find((report) => report.stage === "resolveEntities");
    expect(resolve?.status).toBe("skipped");
  });
});
