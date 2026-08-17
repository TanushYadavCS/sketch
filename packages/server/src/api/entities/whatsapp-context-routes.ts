import { Hono } from "hono";
import type { Kysely } from "kysely";
import { createEntityRepository } from "../../db/repositories/entities";
import type { DB } from "../../db/schema";
import {
  EXCERPTS_PER_GROUP_DEFAULT,
  EXCERPTS_PER_GROUP_MAX,
  GROUP_LIMIT_DEFAULT,
  GROUP_LIMIT_MAX,
  MESSAGES_PER_GROUP_DEFAULT,
  MESSAGES_PER_GROUP_MAX,
  type WhatsAppIdentityRef,
  collectWhatsAppIdentityGroupContext,
  resolveWhatsAppViewerGroupJids,
} from "../../whatsapp/identity-group-context";
import {
  IDENTITY_QUEUE_LIMIT_DEFAULT,
  IDENTITY_QUEUE_LIMIT_MAX,
  dismissWhatsAppIdentity,
  listUnidentifiedWhatsAppContacts,
  viewerSharesGroupWithIdentity,
} from "../../whatsapp/identity-review-queue";
import { denyIfNotAdmin, getFileViewer } from "../auth-helpers";

function parsePositiveInt(raw: string | undefined, fallback: number, max: number): number | null {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw.trim());
  if (value < 1 || value > max) return null;
  return value;
}

/**
 * The WhatsApp identity an entity is known by: its `whatsapp_lid` contact
 * points plus the first phone-shaped one. An entity minted from a lid-only
 * group participant has the former and not the latter.
 */
async function loadEntityWhatsAppIdentity(db: Kysely<DB>, entityId: string): Promise<WhatsAppIdentityRef> {
  const rows = await db
    .selectFrom("entity_contact_points")
    .select(["kind", "value"])
    .where("entity_id", "=", entityId)
    .where("kind", "in", ["whatsapp_lid", "phone", "whatsapp"])
    .execute();

  return {
    lids: rows.filter((row) => row.kind === "whatsapp_lid").map((row) => row.value),
    phoneE164: rows.find((row) => row.kind === "phone" || row.kind === "whatsapp")?.value ?? null,
  };
}

export function createEntityWhatsAppContextRoutes(db: Kysely<DB>) {
  const routes = new Hono();
  const repo = createEntityRepository(db);

  /**
   * The review queue of WhatsApp contacts that still carry a placeholder name.
   *
   * Path is two segments deliberately: `profile-routes` registers `GET /:id`
   * ahead of this router, so a single-segment `/whatsapp-identities` would be
   * swallowed by it and answered as a missing entity.
   */
  routes.get("/whatsapp/identities", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;

    const limit = parsePositiveInt(c.req.query("limit"), IDENTITY_QUEUE_LIMIT_DEFAULT, IDENTITY_QUEUE_LIMIT_MAX);
    if (limit === null) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: `limit must be 1-${IDENTITY_QUEUE_LIMIT_MAX}` } },
        400,
      );
    }

    const viewerGroupJids = await resolveWhatsAppViewerGroupJids(db, c.get("sub") as string);
    const items = await listUnidentifiedWhatsAppContacts(db, viewerGroupJids, { limit });
    return c.json({ items, viewerHasWhatsAppIdentity: viewerGroupJids.length > 0 });
  });

  /**
   * Takes a contact out of the queue without naming them. Idempotent: an entity
   * already dismissed or already named returns 404 rather than reopening it.
   */
  routes.post("/:id/whatsapp-identity/dismissal", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;

    const entity = await repo.getEntity(c.req.param("id"), getFileViewer(c));
    if (!entity) {
      return c.json({ error: { code: "NOT_FOUND", message: "Entity not found" } }, 404);
    }

    const viewerGroupJids = await resolveWhatsAppViewerGroupJids(db, c.get("sub") as string);
    const identity = await loadEntityWhatsAppIdentity(db, entity.id);
    if (!(await viewerSharesGroupWithIdentity(db, viewerGroupJids, identity))) {
      return c.json({ error: { code: "NOT_FOUND", message: "Entity is not awaiting identification" } }, 404);
    }

    const dismissed = await dismissWhatsAppIdentity(db, entity.id, c.get("sub") as string);
    if (!dismissed) {
      return c.json({ error: { code: "NOT_FOUND", message: "Entity is not awaiting identification" } }, 404);
    }
    return c.json({ success: true });
  });

  /**
   * Group memberships and conversation excerpts that help an admin recognise an
   * entity whose WhatsApp name is unknown.
   *
   * Two gates apply together: the caller must be an admin, and results are
   * restricted to groups the caller is themselves a participant of. An admin who
   * is not in a group cannot read its messages here.
   */
  routes.get("/:id/whatsapp-context", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;

    const entity = await repo.getEntity(c.req.param("id"), getFileViewer(c));
    if (!entity) {
      return c.json({ error: { code: "NOT_FOUND", message: "Entity not found" } }, 404);
    }

    const groupLimit = parsePositiveInt(c.req.query("groups"), GROUP_LIMIT_DEFAULT, GROUP_LIMIT_MAX);
    const messagesPerGroup = parsePositiveInt(
      c.req.query("messagesPerGroup"),
      MESSAGES_PER_GROUP_DEFAULT,
      MESSAGES_PER_GROUP_MAX,
    );
    const excerptsPerGroup = parsePositiveInt(
      c.req.query("excerptsPerGroup"),
      EXCERPTS_PER_GROUP_DEFAULT,
      EXCERPTS_PER_GROUP_MAX,
    );
    if (groupLimit === null || messagesPerGroup === null || excerptsPerGroup === null) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: `groups must be 1-${GROUP_LIMIT_MAX}, messagesPerGroup 1-${MESSAGES_PER_GROUP_MAX}, excerptsPerGroup 1-${EXCERPTS_PER_GROUP_MAX}`,
          },
        },
        400,
      );
    }

    const viewerGroupJids = await resolveWhatsAppViewerGroupJids(db, c.get("sub") as string);
    const identity = await loadEntityWhatsAppIdentity(db, entity.id);

    /**
     * A caller who shares no group with this contact is told nothing about
     * them — not even that they have a WhatsApp identity. Answering with an
     * empty group list but `entityHasWhatsAppIdentity: true` would confirm the
     * contact exists on WhatsApp to someone with no right to see them, which is
     * the one fact this endpoint is meant to protect.
     */
    const shared =
      (identity.lids.length > 0 || identity.phoneE164 !== null) &&
      (await viewerSharesGroupWithIdentity(db, viewerGroupJids, identity));

    if (!shared) {
      return c.json({
        entityId: entity.id,
        viewerHasWhatsAppIdentity: viewerGroupJids.length > 0,
        entityHasWhatsAppIdentity: false,
        groups: [],
        totalGroups: 0,
        truncated: false,
      });
    }

    const context = await collectWhatsAppIdentityGroupContext(db, identity, {
      groupLimit,
      messagesPerGroup,
      excerptsPerGroup,
      restrictToGroupJids: viewerGroupJids,
    });

    return c.json({
      entityId: entity.id,
      viewerHasWhatsAppIdentity: viewerGroupJids.length > 0,
      entityHasWhatsAppIdentity: true,
      ...context,
    });
  });

  return routes;
}
