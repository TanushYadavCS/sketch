import { Hono } from "hono";
import type { Kysely } from "kysely";
import { whereLiveEntity } from "../db/repositories/entities";
import type { DB } from "../db/schema";
import { createProjectBindingsService } from "../entities/project-bindings";
import { createProjectMembersService } from "../entities/project-members";
import { denyIfNotAdmin } from "./auth-helpers";

export interface ProjectSummary {
  id: string;
  name: string;
  origin: "derived" | "defined";
  status: string;
  sourceCount: number;
  subProjectCount: number;
}

async function listProjectRows(db: Kysely<DB>) {
  return db
    .selectFrom("entities")
    .select(["id", "name", "status"])
    .where("source_type", "=", "project")
    .where("status", "=", "confirmed")
    .where("deleted_at", "is", null)
    .orderBy("name", "asc")
    .execute();
}

async function originFor(db: Kysely<DB>, projectId: string): Promise<"derived" | "defined"> {
  const ref = await db
    .selectFrom("entity_source_refs")
    .select("id")
    .where("entity_id", "=", projectId)
    .executeTakeFirst();
  return ref ? "derived" : "defined";
}

async function subProjectCount(db: Kysely<DB>, projectId: string): Promise<number> {
  const row = await db
    .selectFrom("entity_relationships as r")
    .innerJoin("entities as e", "e.id", "r.source_entity_id")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("r.relationship_type", "=", "part_of")
    .where("r.target_entity_id", "=", projectId)
    .where(whereLiveEntity("e"))
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

async function subProjects(db: Kysely<DB>, projectId: string): Promise<{ id: string; name: string }[]> {
  return db
    .selectFrom("entity_relationships as r")
    .innerJoin("entities as e", "e.id", "r.source_entity_id")
    .select(["e.id as id", "e.name as name"])
    .where("r.relationship_type", "=", "part_of")
    .where("r.target_entity_id", "=", projectId)
    .where("e.deleted_at", "is", null)
    .orderBy("e.name", "asc")
    .execute();
}

export function createProjectRoutes(db: Kysely<DB>) {
  const routes = new Hono();
  const bindings = createProjectBindingsService(db);
  const members = createProjectMembersService(db);

  routes.get("/", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;
    const rows = await listProjectRows(db);
    const projects: ProjectSummary[] = [];
    for (const row of rows) {
      const effective = await bindings.resolveEffectiveBindings(row.id);
      projects.push({
        id: row.id,
        name: row.name,
        origin: await originFor(db, row.id),
        status: row.status,
        sourceCount: effective.length,
        subProjectCount: await subProjectCount(db, row.id),
      });
    }
    return c.json({ projects });
  });

  routes.get("/:id", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;
    const id = c.req.param("id");
    const row = await db
      .selectFrom("entities")
      .select(["id", "name", "status", "source_type", "deleted_at"])
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row || row.source_type !== "project" || row.deleted_at !== null) {
      return c.json({ error: { code: "PROJECT_NOT_FOUND", message: "project not found" } }, 404);
    }
    const sources = await bindings.resolveEffectiveBindings(id);
    const memberResult = await members.resolveProjectMembers(id, { limit: 200 });
    const children = await subProjects(db, id);
    const project: ProjectSummary = {
      id: row.id,
      name: row.name,
      origin: await originFor(db, id),
      status: row.status,
      sourceCount: sources.length,
      subProjectCount: children.length,
    };
    return c.json({
      project,
      sources,
      members: memberResult.members,
      truncated: memberResult.truncated,
      subProjects: children,
    });
  });

  return routes;
}
