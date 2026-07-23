import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("requeues kept linked slices when a group flips from disabled to enabled", async () => {
    const seedGroupWithLinkedSlice = async (jid: string, suffix: string) => {
      await repo.upsert({
        jid,
        name: `Group ${suffix}`,
        description: null,
        tool_progress: null,
        reasoning_text: null,
        updated_at: "2026-03-13T10:00:00.000Z",
      });
      const conversation = await db
        .insertInto("conversations")
        .values({
          platform: "whatsapp",
          kind: "group",
          provider_conversation_id: jid,
          display_name: `Group ${suffix}`,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await db
        .insertInto("connector_configs")
        .values({
          id: "conn-wa",
          connector_type: "whatsapp",
          auth_type: "system",
          credentials: "{}",
          created_by: "admin",
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
      await db
        .insertInto("indexed_files")
        .values({
          id: `file-${suffix}`,
          connector_config_id: "conn-wa",
          provider_file_id: `slice-${suffix}`,
          file_name: `WhatsApp: Group ${suffix}`,
          file_type: "whatsapp_conversation_slice",
          content_category: "document",
          source: "whatsapp",
          synced_at: "2026-03-13T10:00:00.000Z",
        })
        .execute();
      await db
        .insertInto("conversation_slices")
        .values({
          id: `slice-${suffix}`,
          conversation_id: conversation.id,
          first_message_id: 1,
          last_message_id: 1,
          started_at: "2026-03-13T09:00:00.000Z",
          ended_at: "2026-03-13T09:05:00.000Z",
          message_count: 1,
          flush_reason: "gap",
          roster_snapshot: "[]",
          salience_verdict: "kept",
          indexed_file_id: `file-${suffix}`,
        })
        .execute();
      return `slice-${suffix}`;
    };

    const enabledSlice = await seedGroupWithLinkedSlice("on@g.us", "on");
    const untouchedSlice = await seedGroupWithLinkedSlice("off@g.us", "off");

    await repo.setIndexEnabled("on@g.us", true);
    const afterEnable = await db.selectFrom("conversation_slices").select(["id", "indexed_file_id"]).execute();
    const linkById = new Map(afterEnable.map((row) => [row.id, row.indexed_file_id]));
    expect(linkById.get(enabledSlice)).toBeNull();
    expect(linkById.get(untouchedSlice)).toBe("file-off");

    await db
      .updateTable("conversation_slices")
      .set({ indexed_file_id: "file-on" })
      .where("id", "=", enabledSlice)
      .execute();
    await repo.setIndexEnabled("on@g.us", true);
    const afterRepeat = await db
      .selectFrom("conversation_slices")
      .select("indexed_file_id")
      .where("id", "=", enabledSlice)
      .executeTakeFirstOrThrow();
    expect(afterRepeat.indexed_file_id).toBe("file-on");

    await repo.replaceIndexEnabledJids(["on@g.us", "off@g.us"]);
    const afterReplace = await db.selectFrom("conversation_slices").select(["id", "indexed_file_id"]).execute();
    const replaceById = new Map(afterReplace.map((row) => [row.id, row.indexed_file_id]));
    expect(replaceById.get(untouchedSlice)).toBeNull();
    expect(replaceById.get(enabledSlice)).toBe("file-on");
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

  it("keeps an existing participant roster when an empty refresh arrives", async () => {
    const groupJid = "123@g.us";
    const logger = { warn: vi.fn() };
    await repo.upsert({
      jid: groupJid,
      name: "Founders",
      description: null,
      updated_at: "2026-03-13T10:00:00.000Z",
    });
    await repo.refreshParticipants(
      groupJid,
      [
        { participantJid: "15551234567@s.whatsapp.net", phoneE164: "+15551234567", adminRole: "admin" },
        { participantJid: "15557654321@s.whatsapp.net", phoneE164: "+15557654321", adminRole: null },
      ],
      "2026-03-13T10:00:00.000Z",
    );

    const refreshed = await repo.refreshParticipants(groupJid, [], "2026-03-13T11:00:00.000Z", logger);

    expect(refreshed).toEqual([
      expect.objectContaining({
        participant_jid: "15551234567@s.whatsapp.net",
        phone_e164: "+15551234567",
        admin_role: "admin",
        last_seen_at: "2026-03-13T10:00:00.000Z",
      }),
      expect.objectContaining({
        participant_jid: "15557654321@s.whatsapp.net",
        phone_e164: "+15557654321",
        admin_role: null,
        last_seen_at: "2026-03-13T10:00:00.000Z",
      }),
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      { groupJid, storedCount: 2, incomingCount: 0 },
      "Skipped empty WhatsApp group participant refresh",
    );
  });

  it("prunes participants missing from a non-empty refresh", async () => {
    const groupJid = "123@g.us";
    await repo.upsert({
      jid: groupJid,
      name: "Founders",
      description: null,
      updated_at: "2026-03-13T10:00:00.000Z",
    });
    await repo.refreshParticipants(
      groupJid,
      [
        { participantJid: "15551234567@s.whatsapp.net", phoneE164: "+15551234567", adminRole: "admin" },
        { participantJid: "15557654321@s.whatsapp.net", phoneE164: "+15557654321", adminRole: null },
      ],
      "2026-03-13T10:00:00.000Z",
    );

    const refreshed = await repo.refreshParticipants(
      groupJid,
      [{ participantJid: "15557654321@s.whatsapp.net", phoneE164: "+15557654321", adminRole: "superadmin" }],
      "2026-03-13T11:00:00.000Z",
    );

    expect(refreshed).toEqual([
      expect.objectContaining({
        participant_jid: "15557654321@s.whatsapp.net",
        phone_e164: "+15557654321",
        admin_role: "superadmin",
        last_seen_at: "2026-03-13T11:00:00.000Z",
      }),
    ]);
  });
});
