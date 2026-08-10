import type { Kysely } from "kysely";
import { signJwt } from "../auth/jwt";
import { hashPassword } from "../auth/password";
import { createConnectorRepository } from "../db/repositories/connectors";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import type { createApp } from "../http";

export const VISIBILITY_PASSWORD = "visibility-test-password";
export const VISIBILITY_QUERY = "visibilitysentinel";

export const visibilityUsers = {
  admin: { id: "visibility-user-admin", email: "admin@test" },
  scopeMember: { id: "visibility-user-scope-member", email: "scope-member@test" },
  fileGrant: { id: "visibility-user-file-grant", email: "file-grant@test" },
  shareTarget: { id: "visibility-user-share-target", email: "share-target@test" },
  stranger: { id: "visibility-user-stranger", email: "stranger@test" },
  slackOnly: { id: "visibility-user-slack-only", email: null, slackUserId: "U-VISIBILITY-SLACK-ONLY" },
  messyPhone: {
    id: "visibility-user-messy-phone",
    email: "messy-phone@test",
    whatsappNumber: "+91 9101299347",
  },
} as const;

export const visibilityFiles = {
  propagated: "file-propagated",
  private: "file-private",
  fileGrant: "file-grant",
  manualShare: "file-manual-share",
  individualEntityShare: "file-individual-entity-share",
  phoneScope: "file-phone-scope",
} as const;

export const allVisibilityFileIds = Object.values(visibilityFiles);

const NOW = "2026-08-08T08:00:00.000Z";

export async function seedFileVisibilityFixture(db: Kysely<DB>): Promise<void> {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  const passwordHash = await hashPassword(VISIBILITY_PASSWORD);
  await settings.create();

  await users.create({
    id: visibilityUsers.admin.id,
    name: "Visibility Admin",
    email: visibilityUsers.admin.email,
    emailVerified: true,
    passwordHash,
    authRole: "admin",
    skipEntityLinking: true,
  });
  await users.create({
    id: visibilityUsers.scopeMember.id,
    name: "Scope Member",
    email: visibilityUsers.scopeMember.email,
    emailVerified: true,
    passwordHash,
    authRole: "member",
    skipEntityLinking: true,
  });
  await users.create({
    id: visibilityUsers.fileGrant.id,
    name: "File Grant",
    email: visibilityUsers.fileGrant.email,
    emailVerified: true,
    passwordHash,
    authRole: "member",
    skipEntityLinking: true,
  });
  await users.create({
    id: visibilityUsers.shareTarget.id,
    name: "Share Target",
    email: visibilityUsers.shareTarget.email,
    emailVerified: true,
    passwordHash,
    authRole: "member",
    skipEntityLinking: true,
  });
  await users.create({
    id: visibilityUsers.stranger.id,
    name: "Stranger",
    email: visibilityUsers.stranger.email,
    emailVerified: true,
    passwordHash,
    authRole: "member",
    skipEntityLinking: true,
  });
  await users.create({
    id: visibilityUsers.slackOnly.id,
    name: "Slack Only",
    email: null,
    slackUserId: visibilityUsers.slackOnly.slackUserId,
    passwordHash,
    authRole: "member",
    skipEntityLinking: true,
  });
  await users.create({
    id: visibilityUsers.messyPhone.id,
    name: "Messy Phone",
    email: visibilityUsers.messyPhone.email,
    emailVerified: true,
    whatsappNumber: visibilityUsers.messyPhone.whatsappNumber,
    passwordHash,
    authRole: "member",
    skipEntityLinking: true,
  });

  await settings.update({
    onboardingCompletedAt: NOW,
    adminCanReadAllFiles: true,
  });

  const connector = await createConnectorRepository(db).createConfig({
    connectorType: "google_drive",
    authType: "system",
    credentials: JSON.stringify({ type: "system" }),
    createdBy: visibilityUsers.admin.id,
  });

  await db
    .insertInto("access_scopes")
    .values([
      {
        id: "visibility-scope-main",
        connector_config_id: connector.id,
        scope_type: "drive",
        provider_scope_id: "visibility-main",
        label: "Visibility main scope",
      },
      {
        id: "visibility-scope-locked",
        connector_config_id: connector.id,
        scope_type: "drive",
        provider_scope_id: "visibility-locked",
        label: "Visibility locked scope",
      },
      {
        id: "visibility-scope-phone",
        connector_config_id: connector.id,
        scope_type: "whatsapp_group",
        provider_scope_id: "visibility-phone",
        label: "Visibility phone scope",
      },
    ])
    .execute();

  await db
    .insertInto("access_scope_members")
    .values([
      {
        access_scope_id: "visibility-scope-main",
        principal_type: "email",
        principal_value: visibilityUsers.scopeMember.email,
      },
      {
        access_scope_id: "visibility-scope-locked",
        principal_type: "email",
        principal_value: "scope-lock-holder@test",
      },
      {
        access_scope_id: "visibility-scope-phone",
        principal_type: "phone",
        principal_value: "+919101299347",
      },
    ])
    .execute();

  await db
    .insertInto("indexed_files")
    .values([
      fixtureFile(connector.id, visibilityFiles.propagated, "visibility-scope-main"),
      fixtureFile(connector.id, visibilityFiles.private, "visibility-scope-main"),
      fixtureFile(connector.id, visibilityFiles.fileGrant, "visibility-scope-locked"),
      fixtureFile(connector.id, visibilityFiles.manualShare, "visibility-scope-locked"),
      fixtureFile(connector.id, visibilityFiles.individualEntityShare, "visibility-scope-locked"),
      fixtureFile(connector.id, visibilityFiles.phoneScope, "visibility-scope-phone"),
    ])
    .execute();

  await db
    .insertInto("file_access")
    .values({
      indexed_file_id: visibilityFiles.fileGrant,
      principal_type: "email",
      principal_value: visibilityUsers.fileGrant.email,
    })
    .execute();
  await db
    .insertInto("file_share_emails")
    .values({
      indexed_file_id: visibilityFiles.manualShare,
      email: visibilityUsers.shareTarget.email,
      granted_by_user_id: visibilityUsers.admin.id,
    })
    .execute();

  await db
    .insertInto("entities")
    .values([
      {
        id: "visibility-entity-org-wide",
        name: "Org-wide visibility entity",
        source_type: "manual",
        subtype: null,
        aliases: null,
        metadata: null,
        source_ref_id: null,
        status: "confirmed",
        hotness: 0,
        created_at: NOW,
        updated_at: NOW,
        share_with_everyone: 1,
        deleted_at: null,
        merged_into_entity_id: null,
      },
      {
        id: "visibility-entity-individual",
        name: "Individually shared visibility entity",
        source_type: "manual",
        subtype: null,
        aliases: null,
        metadata: null,
        source_ref_id: null,
        status: "confirmed",
        hotness: 0,
        created_at: NOW,
        updated_at: NOW,
        share_with_everyone: 0,
        deleted_at: null,
        merged_into_entity_id: null,
      },
    ])
    .execute();
  await db
    .insertInto("entity_mentions")
    .values([
      fixtureMention("visibility-mention-org-wide", "visibility-entity-org-wide", visibilityFiles.propagated),
      fixtureMention(
        "visibility-mention-individual",
        "visibility-entity-individual",
        visibilityFiles.individualEntityShare,
      ),
    ])
    .execute();
  await db
    .insertInto("entity_share_emails")
    .values({
      entity_id: "visibility-entity-individual",
      email: "someone-else@test",
      granted_by_user_id: visibilityUsers.admin.id,
    })
    .execute();
}

function fixtureFile(connectorConfigId: string, id: string, accessScopeId: string) {
  return {
    id,
    connector_config_id: connectorConfigId,
    provider_file_id: id,
    file_name: `${VISIBILITY_QUERY} ${id}`,
    file_type: "document",
    content_category: "document",
    content: `${VISIBILITY_QUERY} content for ${id}`,
    content_hash: `hash-${id}`,
    source: "google_drive",
    synced_at: NOW,
    source_updated_at: NOW,
    access_scope_id: accessScopeId,
  };
}

function fixtureMention(id: string, entityId: string, fileId: string) {
  return {
    id,
    entity_id: entityId,
    indexed_file_id: fileId,
    chunk_index: null,
    context_snippet: null,
    confidence: "EXTRACTED",
    source: "test",
    relation: "mentioned",
    mentioned_at: NOW,
  };
}

export async function loginVisibilityUser(app: ReturnType<typeof createApp>, email: string): Promise<string> {
  const response = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: VISIBILITY_PASSWORD }),
  });
  if (response.status !== 200) {
    throw new Error(`Login failed for ${email}: ${response.status} ${await response.text()}`);
  }
  return response.headers.get("set-cookie") ?? "";
}

export async function visibilitySessionCookie(
  db: Kysely<DB>,
  userId: string,
  role: "admin" | "member" = "member",
): Promise<string> {
  const settings = await createSettingsRepository(db).get();
  if (!settings?.jwt_secret) throw new Error("Visibility fixture JWT secret is missing");
  return `sketch_session=${await signJwt(userId, role, settings.jwt_secret)}`;
}
