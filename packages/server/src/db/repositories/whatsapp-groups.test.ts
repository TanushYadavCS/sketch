import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { createWhatsAppGroupRepository } from "./whatsapp-groups";

let db: Kysely<DB>;
let repo: ReturnType<typeof createWhatsAppGroupRepository>;

beforeEach(async () => {
  db = await createTestDb();
  repo = createWhatsAppGroupRepository(db);
});

afterEach(async () => {
  await db.destroy();
});

describe("createWhatsAppGroupRepository", () => {
  it("returns undefined for unknown groups", async () => {
    await expect(repo.getByJid("missing@g.us")).resolves.toBeUndefined();
  });

  it("inserts a new group on first upsert", async () => {
    const row = await repo.upsert({
      jid: "123@g.us",
      name: "Founders",
      description: "Core team",
      tool_progress: null,
      reasoning_text: null,
      updated_at: "2026-03-13T10:00:00.000Z",
    });

    expect(row.jid).toBe("123@g.us");
    expect(row.name).toBe("Founders");
    expect(row.description).toBe("Core team");
    expect(row.updated_at).toBe("2026-03-13T10:00:00.000Z");
  });

  it("updates an existing group row when the same jid is upserted again", async () => {
    await repo.upsert({
      jid: "123@g.us",
      name: "Founders",
      description: "Core team",
      tool_progress: null,
      reasoning_text: null,
      updated_at: "2026-03-13T10:00:00.000Z",
    });

    const updated = await repo.upsert({
      jid: "123@g.us",
      name: "Founders Plus",
      description: null,
      tool_progress: "friendly",
      reasoning_text: 1,
      updated_at: "2026-03-14T10:00:00.000Z",
    });

    expect(updated.name).toBe("Founders Plus");
    expect(updated.description).toBeNull();
    expect(updated.tool_progress).toBe("friendly");
    expect(updated.reasoning_text).toBe(1);
    expect(updated.updated_at).toBe("2026-03-14T10:00:00.000Z");
  });

  it("updates only progress settings for an existing group", async () => {
    await repo.upsert({
      jid: "123@g.us",
      name: "Founders",
      description: "Core team",
      tool_progress: null,
      reasoning_text: null,
      updated_at: "2026-03-13T10:00:00.000Z",
    });

    const updated = await repo.updateProgressSettings("123@g.us", { toolProgress: "technical", reasoningText: true });

    expect(updated?.tool_progress).toBe("technical");
    expect(updated?.reasoning_text).toBe(1);
    expect(updated?.name).toBe("Founders");
  });

  it("converts index_enabled to boolean and stores per-group slice overrides", async () => {
    await repo.upsert({
      jid: "123@g.us",
      name: "Founders",
      description: "Core team",
      tool_progress: null,
      reasoning_text: null,
      updated_at: "2026-03-13T10:00:00.000Z",
    });

    await expect(repo.listIndexEnabled()).resolves.toEqual([]);

    const enabled = await repo.setIndexEnabled("123@g.us", true, {
      sliceGapMinutes: 20,
      sliceMaxAgeMinutes: 90,
      sliceMaxMessages: 40,
    });

    expect(enabled).toEqual({
      jid: "123@g.us",
      name: "Founders",
      description: "Core team",
      indexEnabled: true,
      sliceGapMinutes: 20,
      sliceMaxAgeMinutes: 90,
      sliceMaxMessages: 40,
    });
    await expect(repo.listIndexEnabled()).resolves.toEqual([enabled]);

    const disabled = await repo.setIndexEnabled("123@g.us", false);
    expect(disabled?.indexEnabled).toBe(false);
    expect(disabled?.sliceGapMinutes).toBe(20);
    await expect(repo.listIndexEnabled()).resolves.toEqual([]);
  });

  it("creates, updates, lists, and deletes manual member labels", async () => {
    await db.insertInto("users").values({ id: "labeler", name: "Labeler", email: "labeler@example.com" }).execute();

    const created = await repo.upsertMemberLabel({
      groupJid: "123@g.us",
      phoneE164: "+15551234567",
      displayName: "Asha Mehta",
      companyName: null,
      createdBy: "labeler",
    });
    expect(created).toMatchObject({
      group_jid: "123@g.us",
      phone_e164: "+15551234567",
      display_name: "Asha Mehta",
      company_name: null,
      created_by: "labeler",
    });

    await repo.upsertMemberLabel({
      groupJid: "123@g.us",
      phoneE164: "+15551234567",
      displayName: "Asha M.",
      companyName: "Acme",
      createdBy: "labeler",
    });

    await expect(repo.getMemberLabel("123@g.us", "+15551234567")).resolves.toMatchObject({
      display_name: "Asha M.",
      company_name: "Acme",
    });
    await expect(repo.listMemberLabels("123@g.us")).resolves.toHaveLength(1);
    await expect(repo.deleteMemberLabel("123@g.us", "+15551234567")).resolves.toBe(true);
    await expect(repo.getMemberLabel("123@g.us", "+15551234567")).resolves.toBeUndefined();
  });
});
