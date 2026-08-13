import { type Context, Hono } from "hono";
import type { Kysely } from "kysely";
import type { DB } from "../../db/schema";
import {
  EntityMergeError,
  type EntityMergeErrorCode,
  type EntityMergeMove,
  mergeEntities,
  previewMerge,
  unmergeEntities,
} from "../../entities/merge";
import { isAdmin } from "../auth-helpers";

function denyIfNotMergeAdmin(c: Context): Response | null {
  if (isAdmin(c)) return null;
  return c.json({ error: { code: "OWNER_SCOPE_DENIED", message: "admin required" } }, 403);
}

function statusForError(code: EntityMergeErrorCode): 404 | 409 | 422 {
  switch (code) {
    case "ENTITY_NOT_FOUND":
    case "MERGE_NOT_FOUND":
      return 404;
    case "TYPE_MISMATCH":
    case "SELF_MERGE":
      return 422;
    default:
      return 409;
  }
}

function handleMergeError(c: Context, err: unknown): Response {
  if (err instanceof EntityMergeError) {
    return c.json(
      {
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ?? {}),
        },
      },
      statusForError(err.code),
    );
  }
  throw err;
}

function redactMove(move: EntityMergeMove): Omit<EntityMergeMove, "payload"> {
  if ("payload" in move) {
    const { payload: _payload, ...redacted } = move;
    return redacted;
  }
  return move;
}

export function createEntityMergeRoutes(db: Kysely<DB>) {
  const routes = new Hono();

  routes.get("/merges", async (c) => {
    const denied = denyIfNotMergeAdmin(c);
    if (denied) return denied;
    const entityId = c.req.query("entityId");
    const groupId = c.req.query("groupId");
    if (!entityId && !groupId) {
      return c.json({ error: { code: "BAD_REQUEST", message: "entityId or groupId is required" } }, 400);
    }

    let query = db
      .selectFrom("entity_merges")
      .select([
        "id",
        "group_id",
        "merged_by",
        "survivor_entity_id",
        "merged_entity_id",
        "entity_type",
        "merged_at",
        "unmerged_at",
        "unmerged_by_user_id",
      ])
      .orderBy("merged_at", "desc")
      .orderBy("id", "desc");
    if (entityId) {
      query = query.where((eb) =>
        eb.or([eb("survivor_entity_id", "=", entityId), eb("merged_entity_id", "=", entityId)]),
      );
    }
    if (groupId) query = query.where("group_id", "=", groupId);
    const merges = await query.execute();

    return c.json({ merges });
  });

  routes.post("/merges", async (c) => {
    const denied = denyIfNotMergeAdmin(c);
    if (denied) return denied;
    const body = (await c.req.json().catch(() => ({}))) as {
      survivorId?: string;
      loserId?: string;
      groupId?: string;
    };
    if (!body.survivorId || !body.loserId) {
      return c.json({ error: { code: "BAD_REQUEST", message: "survivorId and loserId are required" } }, 400);
    }

    try {
      const result = await mergeEntities(db, {
        survivorId: body.survivorId,
        loserId: body.loserId,
        userId: c.get("sub"),
        groupId: body.groupId,
      });
      return c.json({ mergeId: result.mergeId, moves: result.moves.map(redactMove) });
    } catch (err) {
      return handleMergeError(c, err);
    }
  });

  routes.delete("/merges/groups/:groupId", async (c) => {
    const denied = denyIfNotMergeAdmin(c);
    if (denied) return denied;

    const groupId = c.req.param("groupId");
    const merges = await db
      .selectFrom("entity_merges")
      .select(["id"])
      .where("group_id", "=", groupId)
      .where("unmerged_at", "is", null)
      .orderBy("merged_at", "desc")
      .orderBy("id", "desc")
      .execute();
    if (merges.length === 0) {
      return c.json({ error: { code: "MERGE_NOT_FOUND", message: "active merge group not found" } }, 404);
    }

    try {
      for (const merge of merges) {
        await unmergeEntities(db, { mergeId: merge.id, userId: c.get("sub") });
      }
      return c.json({ ok: true, reversed: merges.length });
    } catch (err) {
      return handleMergeError(c, err);
    }
  });

  routes.delete("/merges/:mergeId", async (c) => {
    const denied = denyIfNotMergeAdmin(c);
    if (denied) return denied;

    try {
      await unmergeEntities(db, { mergeId: c.req.param("mergeId"), userId: c.get("sub") });
      return c.json({ ok: true });
    } catch (err) {
      return handleMergeError(c, err);
    }
  });

  routes.get("/:id/merge-preview", async (c) => {
    const denied = denyIfNotMergeAdmin(c);
    if (denied) return denied;
    const loserId = c.req.query("against");
    if (!loserId) {
      return c.json({ error: { code: "BAD_REQUEST", message: "against query param is required" } }, 400);
    }
    return c.json(await previewMerge(db, { survivorId: c.req.param("id"), loserId }));
  });

  return routes;
}
