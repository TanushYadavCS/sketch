import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { createConversationSlicesRepository } from "./conversation-slices";
import { createConversationRepository } from "./conversations";
import { createWhatsAppGroupRepository } from "./whatsapp-groups";
import { createWhatsAppIdentityCandidateRepository } from "./whatsapp-identity-candidates";

describe("createWhatsAppIdentityCandidateRepository", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("keeps first and last seen timestamps monotonic when slices are judged out of order", async () => {
    const groupJid = "candidate-order@g.us";
    await createWhatsAppGroupRepository(db).upsert({
      jid: groupJid,
      name: "Candidate Order",
      description: null,
      updated_at: "2026-07-11T00:00:00.000Z",
    });
    const conversation = await createConversationRepository(db).getOrCreate({
      platform: "whatsapp",
      kind: "group",
      providerConversationId: groupJid,
    });
    const slices = createConversationSlicesRepository(db);
    const newer = await slices.insertIfAbsent({
      conversationId: conversation.id,
      firstMessageId: 2,
      lastMessageId: 2,
      startedAt: "2026-07-11T10:00:00.000Z",
      endedAt: "2026-07-11T10:00:00.000Z",
      messageCount: 1,
      flushReason: "gap",
      rosterSnapshot: "[]",
    });
    const older = await slices.insertIfAbsent({
      conversationId: conversation.id,
      firstMessageId: 1,
      lastMessageId: 1,
      startedAt: "2026-07-11T09:00:00.000Z",
      endedAt: "2026-07-11T09:00:00.000Z",
      messageCount: 1,
      flushReason: "gap",
      rosterSnapshot: "[]",
    });
    const repo = createWhatsAppIdentityCandidateRepository(db);

    await repo.recordObservation({
      groupJid,
      candidateRef: "candidate-ref",
      participantJidRef: "participant-ref",
      displayName: "Newer Name",
      sliceId: newer.row.id,
      seenAt: "2026-07-11T10:00:00.000Z",
    });
    const row = await repo.recordObservation({
      groupJid,
      candidateRef: "candidate-ref",
      participantJidRef: "participant-ref",
      displayName: null,
      sliceId: older.row.id,
      seenAt: "2026-07-11T09:00:00.000Z",
    });

    expect(row).toMatchObject({
      display_name: "Newer Name",
      kept_slice_count: 2,
      first_seen_at: "2026-07-11T09:00:00.000Z",
      last_seen_at: "2026-07-11T10:00:00.000Z",
      last_slice_id: newer.row.id,
    });
  });
});
