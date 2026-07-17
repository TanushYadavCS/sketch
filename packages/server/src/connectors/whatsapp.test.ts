import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConversationRepository } from "../db/repositories/conversations";
import { createWhatsAppGroupRepository } from "../db/repositories/whatsapp-groups";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { createWhatsAppConnector } from "./whatsapp";

describe("createWhatsAppConnector", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("accepts only system credentials", async () => {
    const connector = createWhatsAppConnector();

    expect(connector.syncIsCompleteSnapshot).toBe(false);
    await expect(connector.validateCredentials({ type: "system" })).resolves.toBeUndefined();
    await expect(connector.validateCredentials({ type: "api_key", api_key: "secret" })).rejects.toThrow(
      "WhatsApp connector requires system credentials",
    );
  });

  it("browses locally captured WhatsApp groups as flat scope items", async () => {
    const groups = createWhatsAppGroupRepository(db);
    await groups.upsert({
      jid: "zeta@g.us",
      name: "Zeta Group",
      description: null,
      tool_progress: null,
      reasoning_text: null,
      updated_at: "2026-07-07T09:00:00.000Z",
    });
    await groups.upsert({
      jid: "alpha@g.us",
      name: "Alpha Group",
      description: null,
      tool_progress: null,
      reasoning_text: null,
      updated_at: "2026-07-07T09:01:00.000Z",
    });

    await expect(
      createWhatsAppConnector().browse?.({
        db,
        credentials: { type: "system" },
        logger: { debug: vi.fn(), info: vi.fn() } as unknown as Logger,
      }),
    ).resolves.toEqual({
      type: "flat",
      items: [
        { id: "alpha@g.us", name: "Alpha Group" },
        { id: "zeta@g.us", name: "Zeta Group" },
      ],
    });
  });

  it("loads only index-enabled groups, chunks them, and yields no items without a salience generator", async () => {
    const groups = createWhatsAppGroupRepository(db);
    await groups.upsert({
      jid: "disabled@g.us",
      name: "Disabled",
      description: null,
      tool_progress: null,
      reasoning_text: null,
      updated_at: "2026-07-07T09:00:00.000Z",
    });
    await groups.upsert({
      jid: "enabled@g.us",
      name: "Enabled",
      description: null,
      tool_progress: null,
      reasoning_text: null,
      updated_at: "2026-07-07T09:01:00.000Z",
    });
    await groups.setIndexEnabled("enabled@g.us", true);
    const conversation = await createConversationRepository(db).getOrCreate({
      platform: "whatsapp",
      kind: "group",
      providerConversationId: "enabled@g.us",
    });
    await createConversationRepository(db).insertMessage({
      conversationId: conversation.id,
      providerMessageId: "enabled-1",
      senderName: "Sender",
      text: "first",
      providerTimestamp: "2025-01-01T09:00:00.000Z",
      receivedAt: "2025-01-01T09:00:00.000Z",
    });

    const debug = vi.fn();
    const info = vi.fn();
    const logger = { debug, info, warn: vi.fn(), error: vi.fn() } as unknown as Logger;
    const seen: unknown[] = [];

    for await (const item of createWhatsAppConnector().sync({
      db,
      credentials: { type: "system" },
      scopeConfig: {},
      cursor: null,
      logger,
    })) {
      seen.push(item);
    }

    expect(seen).toEqual([]);
    expect(debug).toHaveBeenCalledWith({ groupCount: 1 }, "Loaded opted-in WhatsApp groups for indexing");
    await expect(db.selectFrom("conversation_slices").selectAll().execute()).resolves.toHaveLength(1);
  });

  it("disabled groups yield nothing by construction", async () => {
    await createWhatsAppGroupRepository(db).upsert({
      jid: "disabled@g.us",
      name: "Disabled",
      description: null,
      tool_progress: null,
      reasoning_text: null,
      updated_at: "2026-07-07T09:00:00.000Z",
    });

    const debug = vi.fn();
    const logger = { debug, info: vi.fn() } as unknown as Logger;
    const seen: unknown[] = [];

    for await (const item of createWhatsAppConnector().sync({
      db,
      credentials: { type: "system" },
      scopeConfig: {},
      cursor: null,
      logger,
    })) {
      seen.push(item);
    }

    expect(seen).toEqual([]);
    expect(debug).toHaveBeenCalledWith({ groupCount: 0 }, "Loaded opted-in WhatsApp groups for indexing");
  });

  it("admits terminal backfill history inside the scheduled connector sync sequence", async () => {
    const groups = createWhatsAppGroupRepository(db);
    await groups.upsert({
      jid: "backfill-sync@g.us",
      name: "Backfill Sync",
      description: null,
      tool_progress: null,
      reasoning_text: null,
      updated_at: "2026-07-17T09:00:00.000Z",
    });
    const group = await groups.setIndexEnabled("backfill-sync@g.us", true);
    if (!group) throw new Error("failed to enable group");
    const conversation = await createConversationRepository(db).getOrCreate({
      platform: "whatsapp",
      kind: "group",
      providerConversationId: group.jid,
    });
    await db
      .insertInto("whatsapp_backfill_checkpoints")
      .values({ group_jid: group.jid, last_fetched_key: null, status: "complete" })
      .execute();
    await db
      .insertInto("whatsapp_backfill_ranges")
      .values({
        id: "connector-sync-range",
        group_jid: group.jid,
        range_key: "initial",
        kind: "initial",
        connection_key: "000000000001:000000000001",
        status: "complete",
        terminal_status: "complete",
        lower_bound_at: "2026-06-17T00:00:00.000Z",
        upper_bound_at: "2026-07-17T00:00:00.000Z",
      })
      .execute();
    const history = await createConversationRepository(db).insertMessage({
      conversationId: conversation.id,
      providerMessageId: "connector-sync-history",
      senderName: "History Sender",
      text: "history",
      providerTimestamp: "2026-07-01T09:00:00.000Z",
      receivedAt: "2026-07-01T09:00:00.000Z",
      source: "history",
      backfillRangeId: "connector-sync-range",
    });
    const syncLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

    for await (const _item of createWhatsAppConnector().sync({
      db,
      credentials: { type: "system" },
      scopeConfig: {},
      cursor: null,
      logger: syncLogger,
    })) {
    }

    await expect(
      db
        .selectFrom("conversation_slices")
        .select(["denoised_message_ids", "salience_verdict"])
        .where("conversation_id", "=", conversation.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      denoised_message_ids: JSON.stringify([history.row.id]),
      salience_verdict: null,
    });
    expect(syncLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ chatsServed: 1, messagesRead: 1, rangesCompleted: 1 }),
      "Completed WhatsApp backfill graph admission run",
    );
  });
});
