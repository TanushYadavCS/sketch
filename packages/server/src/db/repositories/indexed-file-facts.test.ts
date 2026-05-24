import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { createIndexedFileFactRepository } from "./indexed-file-facts";

describe("createIndexedFileFactRepository", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("rejects malformed raw payloads at write time", async () => {
    const repo = createIndexedFileFactRepository(db);

    await expect(
      repo.upsertFact({
        source: "fireflies",
        factType: "attendee",
        relation: "attended",
        subjectName: "Saurabh",
        raw: { providerFileId: "meeting-1" } as never,
      }),
    ).rejects.toThrow("attendee facts require raw.providerFileId and raw.attendee");
  });

  it("stores valid raw payloads", async () => {
    const repo = createIndexedFileFactRepository(db);

    await repo.upsertFact({
      source: "fireflies",
      factType: "attendee",
      relation: "attended",
      subjectName: "Saurabh",
      raw: { providerFileId: "meeting-1", attendee: { name: "Saurabh" } },
    });

    const row = await db.selectFrom("indexed_file_facts").select("raw").executeTakeFirstOrThrow();
    expect(JSON.parse(row.raw ?? "{}")).toEqual({ providerFileId: "meeting-1", attendee: { name: "Saurabh" } });
  });

  it("deduplicates facts when subject email only differs by whitespace", async () => {
    const repo = createIndexedFileFactRepository(db);

    await repo.upsertFact({
      source: "fireflies",
      factType: "attendee",
      relation: "attended",
      subjectName: "Saurabh",
      subjectEmail: " Saurabh@CanvasX.ai ",
      raw: { providerFileId: "meeting-1", attendee: { name: "Saurabh" } },
    });
    await repo.upsertFact({
      source: "fireflies",
      factType: "attendee",
      relation: "attended",
      subjectName: "Saurabh",
      subjectEmail: "saurabh@canvasx.ai",
      raw: { providerFileId: "meeting-1", attendee: { name: "Saurabh" } },
    });

    const rows = await db.selectFrom("indexed_file_facts").select(["subject_email"]).execute();
    expect(rows).toEqual([{ subject_email: "saurabh@canvasx.ai" }]);
  });
});
