import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

    await expect(connector.validateCredentials({ type: "system" })).resolves.toBeUndefined();
    await expect(connector.validateCredentials({ type: "api_key", api_key: "secret" })).rejects.toThrow(
      "WhatsApp connector requires system credentials",
    );
  });

  it("loads only index-enabled groups and yields no items before chunking exists", async () => {
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

    const debug = vi.fn();
    const logger = { debug } as unknown as Logger;
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
    const logger = { debug } as unknown as Logger;
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
});
