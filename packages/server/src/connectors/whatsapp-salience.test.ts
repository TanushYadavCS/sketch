import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConversationSlicesRepository } from "../db/repositories/conversation-slices";
import { createConversationRepository } from "../db/repositories/conversations";
import { createUserRepository } from "../db/repositories/users";
import { createWhatsAppGroupRepository } from "../db/repositories/whatsapp-groups";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { type WhatsAppRosterSnapshot, stableWhatsAppParticipantJidRef } from "../whatsapp/identity-resolution";
import type { GeminiGenerator } from "./gemini-generate";
import {
  assertNoRawWhatsAppIdentifiers,
  parseWhatsAppSalienceResponse,
  processWhatsAppSalience,
  renderWhatsAppTranscript,
} from "./whatsapp-salience";

function fakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as Logger;
}

function fakeGenerator(response: unknown): GeminiGenerator & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async generate() {
      return "";
    },
    async generateJSON<T>(prompt: string) {
      calls.push(prompt);
      return response as T;
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function gatedGenerator(
  response: unknown,
): GeminiGenerator & { calls: string[]; entered: Promise<void>; release: () => void } {
  const calls: string[] = [];
  const entered = deferred();
  const gate = deferred();
  return {
    calls,
    entered: entered.promise,
    release: gate.resolve,
    async generate() {
      return "";
    },
    async generateJSON<T>(prompt: string) {
      calls.push(prompt);
      entered.resolve();
      await gate.promise;
      return response as T;
    },
  };
}

function rosterSnapshot(): WhatsAppRosterSnapshot {
  const teammateJid = "15550000001@s.whatsapp.net";
  const externalJid = "15550000002@s.whatsapp.net";
  return {
    participants: [
      {
        participantJidRef: stableWhatsAppParticipantJidRef(teammateJid),
        senderJidRefs: [stableWhatsAppParticipantJidRef(teammateJid)],
        displayName: "Tara Teammate",
        resolutionKind: "teammate",
        adminRole: null,
        userId: "user-tara",
      },
      {
        participantJidRef: stableWhatsAppParticipantJidRef(externalJid),
        senderJidRefs: [stableWhatsAppParticipantJidRef(externalJid)],
        displayName: "External (**02)",
        resolutionKind: "unresolved",
        adminRole: null,
      },
    ],
    resolutionCounts: { totalParticipants: 2, teammate: 1, entity: 0, labeled: 0, unresolved: 1 },
  };
}

async function seedPendingSlice(db: Kysely<DB>) {
  const suffix = randomUUID();
  const groupJid = `${suffix}@g.us`;
  const groups = createWhatsAppGroupRepository(db);
  await groups.upsert({
    jid: groupJid,
    name: "Salience Group",
    description: null,
    updated_at: "2026-07-07T09:00:00.000Z",
  });
  const group = await groups.setIndexEnabled(groupJid, true);
  if (!group) throw new Error("missing group");
  await createUserRepository(db).create({
    id: `user-${suffix}`,
    name: "Salience User",
    email: `salience-${suffix}@example.com`,
    whatsappNumber: "+15550001000",
  });
  await groups.refreshParticipants(groupJid, [
    { participantJid: "15550001000@s.whatsapp.net", phoneE164: "+15550001000", adminRole: null },
  ]);
  const conversation = await createConversationRepository(db).getOrCreate({
    platform: "whatsapp",
    kind: "group",
    providerConversationId: groupJid,
  });
  const messages = createConversationRepository(db);
  const first = await messages.insertMessage({
    conversationId: conversation.id,
    providerMessageId: `${suffix}:1`,
    senderJid: "15550001000@s.whatsapp.net",
    senderName: "Salience User",
    text: "We decided Project Atlas starts Monday.",
    receivedAt: "2026-07-07T09:00:00.000Z",
  });
  const inserted = await createConversationSlicesRepository(db).insertIfAbsent({
    conversationId: conversation.id,
    firstMessageId: first.row.id,
    lastMessageId: first.row.id,
    startedAt: first.row.receivedAt,
    endedAt: first.row.receivedAt,
    messageCount: 1,
    denoisedMessageIds: [first.row.id],
    flushReason: "gap",
    rosterSnapshot: "[]",
  });
  return { group, sliceId: inserted.row.id };
}

describe("WhatsApp salience rendering", () => {
  it("attributes transcript lines through roster refs and strips raw identifiers", () => {
    const transcript = renderWhatsAppTranscript(rosterSnapshot(), [
      {
        id: 1,
        senderJid: "15550000001@s.whatsapp.net",
        senderName: "raw teammate",
        text: "We decided Project Atlas starts Monday.",
      },
      {
        id: 2,
        senderJid: "15550000002@s.whatsapp.net",
        senderName: "External +15550000002",
        text: "Please do not use 15550000002@s.whatsapp.net in the deck.",
      },
    ]);

    expect(transcript).toContain("Tara Teammate: We decided Project Atlas starts Monday.");
    expect(transcript).toContain("External (**02): Please do not use [whatsapp-id] in the deck.");
    expect(transcript).not.toMatch(/\+?1555000000[12]/u);
    expect(transcript).not.toMatch(/@s\.whatsapp\.net|@lid/u);
    assertNoRawWhatsAppIdentifiers(transcript);
  });
});

describe("parseWhatsAppSalienceResponse", () => {
  it("returns structured verdicts for valid JSON", () => {
    expect(
      parseWhatsAppSalienceResponse({
        salient: true,
        signals: ["decision", "named_entity", "decision"],
        entities: [
          { name: "Project Atlas", type: "project" },
          { name: "Asha", type: "person" },
        ],
      }),
    ).toEqual({
      salient: true,
      signals: ["decision", "named_entity"],
      entities: [
        { name: "Project Atlas", type: "project" },
        { name: "Asha", type: "person" },
      ],
    });
  });

  it("treats malformed JSON shapes as failures instead of drops", () => {
    expect(() => parseWhatsAppSalienceResponse({ salient: false, signals: ["banter"], entities: [] })).toThrow(
      "invalid signal",
    );
    expect(() =>
      parseWhatsAppSalienceResponse({ salient: false, signals: [], entities: [{ name: "Only Name" }] }),
    ).toThrow("name and type");
  });
});

describe("processWhatsAppSalience batch limit", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("judges only the configured number of pending slices", async () => {
    const groupJid = "120363batch@g.us";
    const groups = createWhatsAppGroupRepository(db);
    await groups.upsert({
      jid: groupJid,
      name: "Batch Group",
      description: null,
      updated_at: "2026-07-07T09:00:00.000Z",
    });
    const group = await groups.setIndexEnabled(groupJid, true);
    if (!group) throw new Error("missing group");
    await createUserRepository(db).create({
      id: "user-batch",
      name: "Batch User",
      email: "batch@example.com",
      whatsappNumber: "+15550001000",
    });
    await groups.refreshParticipants(groupJid, [
      { participantJid: "15550001000@s.whatsapp.net", phoneE164: "+15550001000", adminRole: null },
    ]);
    const conversation = await createConversationRepository(db).getOrCreate({
      platform: "whatsapp",
      kind: "group",
      providerConversationId: groupJid,
    });
    const repo = createConversationRepository(db);
    const slices = createConversationSlicesRepository(db);
    for (let index = 0; index < 2; index += 1) {
      const message = await repo.insertMessage({
        conversationId: conversation.id,
        providerMessageId: `batch-${index}`,
        senderJid: "15550001000@s.whatsapp.net",
        senderName: "Batch User",
        text: `Decision ${index}`,
        receivedAt: `2026-07-07T09:0${index}:00.000Z`,
      });
      await slices.insertIfAbsent({
        conversationId: conversation.id,
        firstMessageId: message.row.id,
        lastMessageId: message.row.id,
        startedAt: message.row.receivedAt,
        endedAt: message.row.receivedAt,
        messageCount: 1,
        denoisedMessageIds: [message.row.id],
        flushReason: "gap",
        rosterSnapshot: "[]",
      });
    }

    const summary = await processWhatsAppSalience({
      db,
      groups: [group],
      logger: fakeLogger(),
      generator: fakeGenerator({ salient: true, signals: ["decision"], entities: [] }),
      batchLimit: 1,
    });
    const rows = await db.selectFrom("conversation_slices").select(["salience_verdict"]).execute();
    const verdicts = rows.map((row) => row.salience_verdict);

    expect(summary).toMatchObject({ pendingConsidered: 1, judged: 1, kept: 1 });
    expect(verdicts.filter((verdict) => verdict === "kept")).toHaveLength(1);
    expect(verdicts.filter((verdict) => verdict === null)).toHaveLength(1);
  });

  it("allows only one overlapping salience run to call the LLM for a pending slice", async () => {
    const seeded = await seedPendingSlice(db);
    const generator = gatedGenerator({ salient: true, signals: ["decision"], entities: [] });
    const firstRun = processWhatsAppSalience({
      db,
      groups: [seeded.group],
      logger: fakeLogger(),
      generator,
      batchLimit: 1,
    });
    await generator.entered;

    let secondSettled = false;
    const secondRun = processWhatsAppSalience({
      db,
      groups: [seeded.group],
      logger: fakeLogger(),
      generator,
      batchLimit: 1,
    }).finally(() => {
      secondSettled = true;
    });
    const secondWait = vi
      .waitFor(() => expect(secondSettled).toBe(true), { timeout: 1000 })
      .then(
        () => undefined,
        (err: unknown) => err,
      );
    const secondWaitError = await secondWait;
    generator.release();
    const [firstSummary, secondSummary] = await Promise.all([firstRun, secondRun]);
    if (secondWaitError) throw secondWaitError;

    expect(generator.calls).toHaveLength(1);
    expect(firstSummary).toMatchObject({ pendingConsidered: 1, judged: 1, kept: 1 });
    expect(secondSummary).toMatchObject({ pendingConsidered: 1, judged: 0, kept: 0, failures: 0 });
  });

  it("reclaims a stale salience claim and persists the verdict", async () => {
    const seeded = await seedPendingSlice(db);
    const generator = fakeGenerator({ salient: true, signals: ["decision"], entities: [] });
    await db
      .updateTable("conversation_slices")
      .set({
        salience_claim_token: "stale-token",
        salience_claimed_at: "2000-01-01T00:00:00.000Z",
      })
      .where("id", "=", seeded.sliceId)
      .execute();

    const summary = await processWhatsAppSalience({
      db,
      groups: [seeded.group],
      logger: fakeLogger(),
      generator,
      batchLimit: 1,
    });
    const slice = await db
      .selectFrom("conversation_slices")
      .select(["salience_verdict", "salience_claim_token", "salience_claimed_at"])
      .where("id", "=", seeded.sliceId)
      .executeTakeFirstOrThrow();

    expect(generator.calls).toHaveLength(1);
    expect(summary).toMatchObject({ pendingConsidered: 1, judged: 1, kept: 1 });
    expect(slice).toEqual({ salience_verdict: "kept", salience_claim_token: null, salience_claimed_at: null });
  });

  it("skips the batch without claiming slices when no generator is configured", async () => {
    const seeded = await seedPendingSlice(db);

    const summary = await processWhatsAppSalience({
      db,
      groups: [seeded.group],
      logger: fakeLogger(),
      generator: null,
      batchLimit: 5,
    });
    const slice = await db
      .selectFrom("conversation_slices")
      .select(["salience_verdict", "salience_claim_token", "salience_claimed_at"])
      .where("id", "=", seeded.sliceId)
      .executeTakeFirstOrThrow();

    expect(summary).toMatchObject({ pendingConsidered: 1, judged: 0, failures: 1 });
    expect(slice).toEqual({ salience_verdict: null, salience_claim_token: null, salience_claimed_at: null });
  });
});
