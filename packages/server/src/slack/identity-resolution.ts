import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { type AccessPrincipal, toEmailPrincipals } from "../connectors/types";
import { normalizeContactPointValue } from "../db/repositories/entities";
import type { DB } from "../db/schema";
import type { SlackIndexingFacade } from "./indexing-facade";

export type SlackRosterParticipantKind = "teammate" | "entity" | "external";

export interface SlackRosterParticipant {
  slackUserId: string;
  displayName: string;
  kind: SlackRosterParticipantKind;
  email: string | null;
}

export interface SlackRosterSnapshot {
  channelId: string;
  channelName: string;
  participants: SlackRosterParticipant[];
}

export interface ResolveSlackRosterOptions {
  db: Kysely<DB>;
  facade: SlackIndexingFacade;
  channelId: string;
  channelName: string;
  logger: Logger;
}

async function loadTeammatesBySlackId(
  db: Kysely<DB>,
  slackUserIds: string[],
): Promise<Map<string, { name: string; email: string | null }>> {
  if (slackUserIds.length === 0) return new Map();
  const rows = await db
    .selectFrom("users")
    .select(["slack_user_id", "name", "email"])
    .where("slack_user_id", "in", slackUserIds)
    .execute();
  const byId = new Map<string, { name: string; email: string | null }>();
  for (const row of rows) {
    if (row.slack_user_id) byId.set(row.slack_user_id, { name: row.name, email: row.email });
  }
  return byId;
}

/**
 * Single-match CRM lookup by email: an email shared by multiple entities is
 * ambiguous and resolves to nobody, mirroring the WhatsApp phone rule.
 */
async function findEntityByEmail(db: Kysely<DB>, email: string): Promise<{ name: string } | null> {
  let normalized: string;
  try {
    normalized = normalizeContactPointValue("email", email);
  } catch {
    return null;
  }
  const rows = await db
    .selectFrom("entity_contact_points")
    .innerJoin("entities", "entities.id", "entity_contact_points.entity_id")
    .select(["entities.id as entity_id", "entities.name as name"])
    .where("entity_contact_points.kind", "=", "email")
    .where("entity_contact_points.value", "=", normalized)
    .execute();
  const uniqueEntityIds = new Set(rows.map((row) => row.entity_id));
  if (uniqueEntityIds.size !== 1) return null;
  return { name: rows[0]?.name ?? "" };
}

/**
 * Resolves a channel's member roster through the identity ladder:
 * teammate (users.slack_user_id) → CRM entity (email contact point) →
 * Slack profile display name. Names are never invented and unresolved
 * members keep their real Slack profile name — there is no phone-style
 * masking regime for Slack.
 *
 * Bot members are excluded entirely: the indexing bot is a member of every
 * indexed channel by construction, and listing bots as participants feeds
 * their names into salience and downstream entity extraction as if they were
 * people. The profile lookup runs before the teammate match so a bot with a
 * stray users row is still filtered; when the lookup fails the member is kept
 * (fail-open to inclusion, mirroring the pre-existing unknown fallback).
 */
export async function resolveSlackChannelRoster(options: ResolveSlackRosterOptions): Promise<SlackRosterSnapshot> {
  const { db, facade, channelId, channelName, logger } = options;
  const memberIds = await facade.listChannelMembers(channelId);
  const teammates = await loadTeammatesBySlackId(db, memberIds);

  const participants: SlackRosterParticipant[] = [];
  for (const slackUserId of memberIds) {
    let profile: { realName: string; email: string | null; isBot: boolean } | null = null;
    try {
      profile = await facade.getUserInfo(slackUserId);
    } catch (err) {
      logger.warn({ err, channelId }, "Slack roster user lookup failed");
    }
    if (profile?.isBot) continue;

    const teammate = teammates.get(slackUserId);
    if (teammate) {
      participants.push({
        slackUserId,
        displayName: teammate.name,
        kind: "teammate",
        email: teammate.email,
      });
      continue;
    }

    if (!profile) {
      participants.push({ slackUserId, displayName: "unknown", kind: "external", email: null });
      continue;
    }

    const entity = profile.email ? await findEntityByEmail(db, profile.email) : null;
    if (entity?.name) {
      participants.push({ slackUserId, displayName: entity.name, kind: "entity", email: profile.email });
      continue;
    }
    participants.push({ slackUserId, displayName: profile.realName, kind: "external", email: profile.email });
  }

  return { channelId, channelName, participants };
}

export function teammateEmailsFromRoster(snapshot: SlackRosterSnapshot): string[] {
  const emails = snapshot.participants
    .filter((participant) => participant.kind === "teammate" && participant.email)
    .map((participant) => (participant.email as string).toLowerCase());
  return [...new Set(emails)];
}

export function accessPrincipalsFromRoster(snapshot: SlackRosterSnapshot): AccessPrincipal[] {
  const principals = snapshot.participants.map((participant) => ({
    type: "slack_user" as const,
    value: participant.slackUserId,
  }));
  const emails = toEmailPrincipals(teammateEmailsFromRoster(snapshot));
  return [
    ...new Map(
      [...principals, ...emails].map((principal) => [`${principal.type}\u0000${principal.value}`, principal]),
    ).values(),
  ];
}

export function parseSlackRosterSnapshot(raw: string | null): SlackRosterSnapshot | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.participants)) {
      return parsed as SlackRosterSnapshot;
    }
    return null;
  } catch {
    return null;
  }
}
