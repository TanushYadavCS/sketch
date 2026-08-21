import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { clusterClientFiles } from "./project-minting";

describe("participant_affiliation membership signal", () => {
  let db: Kysely<DB>;
  let fileCounter = 0;

  beforeEach(async () => {
    db = await createTestDb();
    fileCounter = 0;
    await db.insertInto("users").values({ id: "u1", name: "U", email: "u@example.com" }).execute();
    await db
      .insertInto("connector_configs")
      .values({
        id: "conn-1",
        connector_type: "fireflies",
        auth_type: "api_key",
        credentials: "{}",
        scope_config: "{}",
        created_by: "u1",
      })
      .execute();
    await db
      .insertInto("organization_domains")
      .values({ id: randomUUID(), domain: "canvasx.ai", source: "test", verified_at: new Date().toISOString() })
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function seedEntity(name: string, sourceType: string): Promise<string> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await db
      .insertInto("entities")
      .values({ id, name, source_type: sourceType, status: "confirmed", hotness: 0, created_at: now, updated_at: now })
      .execute();
    return id;
  }

  async function seedFile(fileName: string): Promise<string> {
    fileCounter += 1;
    const id = `file-${fileCounter}`;
    await db
      .insertInto("indexed_files")
      .values({
        id,
        connector_config_id: "conn-1",
        provider_file_id: `p-${id}`,
        file_name: fileName,
        content_category: "document",
        source: "fireflies",
        synced_at: new Date().toISOString(),
        embedding_status: "pending",
      })
      .execute();
    return id;
  }

  async function seedAttendee(fileId: string, email: string): Promise<void> {
    await db
      .insertInto("indexed_file_facts")
      .values({
        id: randomUUID(),
        indexed_file_id: fileId,
        source: "test",
        fact_type: "attendee",
        relation: "attended",
        subject_email: email,
        fact_key: `${fileId}:${email}`,
      })
      .execute();
  }

  async function seedEmailContact(entityId: string, email: string): Promise<void> {
    await db
      .insertInto("entity_contact_points")
      .values({ id: randomUUID(), entity_id: entityId, kind: "email", value: email, source: "test" })
      .execute();
  }

  async function seedEdge(personId: string, companyId: string, type: string, source: string): Promise<void> {
    await db
      .insertInto("entity_relationships")
      .values({
        id: randomUUID(),
        source_entity_id: personId,
        target_entity_id: companyId,
        relationship_type: type,
        confidence: "CONFIRMED",
        confidence_score: 1,
        source,
        valid_from: "",
      })
      .execute();
  }

  function memberFileIds(clusters: Awaited<ReturnType<typeof clusterClientFiles>>, companyId: string): string[] {
    return (clusters.find((cluster) => cluster.companyEntityId === companyId)?.files ?? []).map((f) => f.fileId);
  }

  it("attaches a file through a declared works_at participant but not llm or engaged_with edges", async () => {
    const oneStop = await seedEntity("One Stop AI", "company");
    const llmCo = await seedEntity("Llm Guess Co", "company");
    const engagedCo = await seedEntity("Engaged Co", "company");
    const declaredPerson = await seedEntity("Arun", "person");
    const llmPerson = await seedEntity("Guessed Person", "person");
    const engagedPerson = await seedEntity("Consultant", "person");
    await seedEmailContact(declaredPerson, "arun@gmail.com");
    await seedEmailContact(llmPerson, "guess@gmail.com");
    await seedEmailContact(engagedPerson, "consultant@gmail.com");
    await seedEdge(declaredPerson, oneStop, "works_at", "declared");
    await seedEdge(llmPerson, llmCo, "works_at", "llm_extraction");
    await seedEdge(engagedPerson, engagedCo, "engaged_with", "declared");

    const fileA = await seedFile("Sprint sync");
    await seedAttendee(fileA, "arun@gmail.com");
    const fileB = await seedFile("Random call");
    await seedAttendee(fileB, "guess@gmail.com");
    await seedAttendee(fileB, "consultant@gmail.com");

    const clusters = await clusterClientFiles(db, { minFiles: 1 });
    expect(memberFileIds(clusters, oneStop)).toEqual([fileA]);
    const attached = clusters.find((cluster) => cluster.companyEntityId === oneStop);
    expect(attached?.files[0]?.via).toEqual(["participant_affiliation"]);
    expect(memberFileIds(clusters, llmCo)).toEqual([]);
    expect(memberFileIds(clusters, engagedCo)).toEqual([]);
  });

  it("an own-org-affiliated person never attaches files to their client edge", async () => {
    const ownOrg = await seedEntity("Canvasx", "company");
    await db
      .insertInto("entity_domains")
      .values({
        id: randomUUID(),
        entity_id: ownOrg,
        domain: "canvasx.ai",
        kind: "corporate",
        source: "test",
        confidence: 1,
        is_primary: 1,
      })
      .execute();
    const client = await seedEntity("One Stop AI", "company");
    const internalPerson = await seedEntity("Teammate", "person");
    await seedEmailContact(internalPerson, "teammate@gmail.com");
    await seedEdge(internalPerson, ownOrg, "works_at", "email_domain");
    await seedEdge(internalPerson, client, "works_at", "declared");

    const internalFile = await seedFile("Internal weekly");
    await seedAttendee(internalFile, "teammate@gmail.com");

    const clusters = await clusterClientFiles(db, { minFiles: 1 });
    expect(memberFileIds(clusters, client)).toEqual([]);
  });

  it("whatsapp files attach through slice senders, never roster members", async () => {
    const oneStop = await seedEntity("One Stop AI", "company");
    const otherCo = await seedEntity("Other Co", "company");
    const sender = await seedEntity("Sender", "person");
    const rosterOnly = await seedEntity("Lurker", "person");
    await db
      .insertInto("entity_contact_points")
      .values([
        { id: randomUUID(), entity_id: sender, kind: "whatsapp", value: "+911111111111", source: "test" },
        { id: randomUUID(), entity_id: rosterOnly, kind: "whatsapp", value: "+922222222222", source: "test" },
      ])
      .execute();
    await seedEdge(sender, oneStop, "works_at", "declared");
    await seedEdge(rosterOnly, otherCo, "works_at", "declared");

    const waFile = await seedFile("Chat slice");
    const conversation = await db
      .insertInto("conversations")
      .values({ platform: "whatsapp", kind: "group", provider_conversation_id: "g1@g.us", display_name: "Ops group" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const message = await db
      .insertInto("conversation_messages")
      .values({
        conversation_id: conversation.id,
        provider_message_id: "m1",
        sender_jid: "911111111111@s.whatsapp.net",
        sender_name: "Sender",
        text: "hello",
        received_at: new Date().toISOString(),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("conversation_slices")
      .values({
        id: randomUUID(),
        conversation_id: conversation.id,
        first_message_id: message.id,
        last_message_id: message.id,
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        message_count: 1,
        flush_reason: "gap",
        roster_snapshot: JSON.stringify({ participants: [{ phone_e164: "+922222222222" }] }),
        indexed_file_id: waFile,
      })
      .execute();

    const clusters = await clusterClientFiles(db, { minFiles: 1 });
    expect(memberFileIds(clusters, oneStop)).toEqual([waFile]);
    expect(memberFileIds(clusters, otherCo)).toEqual([]);
  });
});
