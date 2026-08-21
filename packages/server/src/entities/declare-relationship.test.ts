import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password";
import { loadExistingProjects } from "../connectors/weekly-mint";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";
import { declareRelationship } from "./declare-relationship";

const config = createTestConfig();
const logger = createTestLogger();
const ADMIN_EMAIL = "admin@test.com";
const PASSWORD = "testpassword123";

describe("declared relationships", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  let adminCookie: string;

  beforeEach(async () => {
    db = await createTestDb();
    const settings = createSettingsRepository(db);
    const users = createUserRepository(db);
    await settings.create();
    await users.create({
      name: "admin",
      email: ADMIN_EMAIL,
      emailVerified: true,
      passwordHash: await hashPassword(PASSWORD),
      authRole: "admin",
      skipEntityLinking: true,
    });
    await settings.update({ onboardingCompletedAt: new Date().toISOString() });
    app = createApp(db, config, { logger });
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: PASSWORD }),
    });
    adminCookie = res.headers.get("set-cookie") ?? "";
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

  async function seedEdge(sourceId: string, targetId: string, type: string, source: string): Promise<string> {
    const id = randomUUID();
    await db
      .insertInto("entity_relationships")
      .values({
        id,
        source_entity_id: sourceId,
        target_entity_id: targetId,
        relationship_type: type,
        confidence: "EXTRACTED",
        confidence_score: 0.8,
        source,
        valid_from: "",
      })
      .execute();
    return id;
  }

  it("rejects non-allowed pairs at the route", async () => {
    const person = await seedEntity("Arun", "person");
    const otherPerson = await seedEntity("Nikhil", "person");

    const badType = await app.request(`/api/entities/${person.toString()}/relationships`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ targetEntityId: otherPerson, relationshipType: "engagement_for" }),
    });
    expect(badType.status).toBe(400);

    const badTarget = await app.request(`/api/entities/${person.toString()}/relationships`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ targetEntityId: otherPerson, relationshipType: "works_at" }),
    });
    expect(badTarget.status).toBe(400);
    expect((await badTarget.json()).error.code).toBe("NOT_A_COMPANY");

    const project = await seedEntity("One Stop", "project");
    const company = await seedEntity("One Stop AI", "company");
    const projectEdge = await seedEdge(project, company, "engagement_for", "declared");
    const badDelete = await app.request(`/api/entities/${project.toString()}/relationships/${projectEdge}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(badDelete.status).toBe(404);
    const stillThere = await db
      .selectFrom("entity_relationships")
      .select("id")
      .where("id", "=", projectEdge)
      .executeTakeFirst();
    expect(stillThere).toBeTruthy();
  });

  it("a second declared employer replaces the first but leaves inferred and engaged_with rows", async () => {
    const person = await seedEntity("Arun", "person");
    const oldCompany = await seedEntity("Old Employer", "company");
    const newCompany = await seedEntity("One Stop AI", "company");
    const inferredCompany = await seedEntity("Guessed Employer", "company");
    const inferredId = await seedEdge(person, inferredCompany, "works_at", "llm_extraction");

    await declareRelationship(db, {
      personEntityId: person,
      companyEntityId: oldCompany,
      relationshipType: "works_at",
    });
    await declareRelationship(db, {
      personEntityId: person,
      companyEntityId: newCompany,
      relationshipType: "engaged_with",
    });
    const result = await declareRelationship(db, {
      personEntityId: person,
      companyEntityId: newCompany,
      relationshipType: "works_at",
    });

    const rows = await db
      .selectFrom("entity_relationships")
      .select(["id", "target_entity_id", "relationship_type", "source"])
      .where("source_entity_id", "=", person)
      .execute();
    const declaredWorksAt = rows.filter((row) => row.relationship_type === "works_at" && row.source === "declared");
    expect(declaredWorksAt).toEqual([
      { id: result.relationshipId, target_entity_id: newCompany, relationship_type: "works_at", source: "declared" },
    ]);
    expect(rows.map((row) => row.id)).toContain(inferredId);
    expect(rows.some((row) => row.relationship_type === "engaged_with" && row.source === "declared")).toBe(true);
  });

  it("weekly-mint scoping follows the declared edge over a stale llm edge", async () => {
    const project = await seedEntity("One Stop", "project");
    const rightCompany = await seedEntity("One Stop AI", "company");
    const wrongCompany = await seedEntity("Canvasx", "company");
    await seedEdge(project, wrongCompany, "engagement_for", "llm_extraction");
    await seedEdge(project, rightCompany, "engagement_for", "declared");

    const underRight = await loadExistingProjects(db, [], rightCompany);
    const underWrong = await loadExistingProjects(db, [], wrongCompany);
    expect(underRight.map((p) => p.name)).toEqual(["One Stop"]);
    expect(underWrong).toEqual([]);
  });
});
