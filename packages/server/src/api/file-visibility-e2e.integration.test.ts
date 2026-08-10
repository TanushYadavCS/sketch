/**
 * D4 is observable only through publicMcp.userPrincipals because every other entry point resolves through
 * viewerPrincipals, which canonicalized phone and LID principals before PR-C. The branch point is
 * agent/tools/search.ts:97-111.
 */
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestLogger, createTestPgDb } from "../test-utils";
import {
  allVisibilityFileIds,
  loginVisibilityUser,
  seedFileVisibilityFixture,
  visibilityFiles,
  visibilitySessionCookie,
  visibilityUsers,
} from "../test/file-visibility-e2e-fixture";

type FileListResponse = { files: Array<{ id: string }>; hasMore: boolean };

describe("file visibility through the HTTP API", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  const cookies = new Map<string, string>();

  beforeAll(async () => {
    db = await createTestPgDb();
    await seedFileVisibilityFixture(db);
    app = createApp(db, createTestConfig({ DB_TYPE: "postgres", SLACK_ENTITY_SYNC: true }), {
      logger: createTestLogger(),
    });

    for (const user of [
      visibilityUsers.admin,
      visibilityUsers.scopeMember,
      visibilityUsers.fileGrant,
      visibilityUsers.shareTarget,
      visibilityUsers.stranger,
      visibilityUsers.messyPhone,
    ]) {
      cookies.set(user.id, await loginVisibilityUser(app, user.email));
    }
    cookies.set(visibilityUsers.slackOnly.id, await visibilitySessionCookie(db, visibilityUsers.slackOnly.id));
  }, 30_000);

  afterAll(async () => {
    await db.destroy();
  });

  async function listedFileIds(userId: string): Promise<string[]> {
    const response = await app.request("/api/connectors/all-files?limit=200", {
      headers: { Cookie: cookies.get(userId) ?? "" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as FileListResponse;
    expect(body.hasMore).toBe(false);
    return body.files.map((file) => file.id).sort();
  }

  async function contentStatus(userId: string, fileId: string): Promise<number> {
    const response = await app.request(`/api/connectors/files/${fileId}/content`, {
      headers: { Cookie: cookies.get(userId) ?? "" },
    });
    await response.text();
    return response.status;
  }

  it.each([
    [
      `keeps the list and content surfaces aligned for ${visibilityUsers.admin.id}`,
      visibilityUsers.admin.id,
      allVisibilityFileIds,
    ],
    [
      `keeps the list and content surfaces aligned for ${visibilityUsers.scopeMember.id}`,
      visibilityUsers.scopeMember.id,
      [visibilityFiles.private, visibilityFiles.propagated],
    ],
    [
      `keeps the list and content surfaces aligned for ${visibilityUsers.fileGrant.id}`,
      visibilityUsers.fileGrant.id,
      [visibilityFiles.fileGrant, visibilityFiles.propagated],
    ],
    [
      `keeps the list and content surfaces aligned for ${visibilityUsers.shareTarget.id}`,
      visibilityUsers.shareTarget.id,
      [visibilityFiles.manualShare, visibilityFiles.propagated],
    ],
    [
      `keeps the list and content surfaces aligned for ${visibilityUsers.stranger.id}`,
      visibilityUsers.stranger.id,
      [visibilityFiles.propagated],
    ],
    [
      `keeps the list and content surfaces aligned for ${visibilityUsers.slackOnly.id}`,
      visibilityUsers.slackOnly.id,
      [visibilityFiles.propagated],
    ],
    [
      "reaches a phone-scoped file on the aligned list and content surfaces for a user whose stored number is punctuated",
      visibilityUsers.messyPhone.id,
      [visibilityFiles.phoneScope, visibilityFiles.propagated],
    ],
  ])("%s", async (_name, userId, expectedFileIds) => {
    const listed = await listedFileIds(userId);
    expect(listed).toEqual([...expectedFileIds].sort());

    const openable: string[] = [];
    for (const fileId of allVisibilityFileIds) {
      const status = await contentStatus(userId, fileId);
      if (status === 200) openable.push(fileId);
      else expect(status).toBe(403);
    }
    expect(openable.sort()).toEqual(listed);
  });

  it("keeps a private scoped file hidden from a stranger on both routes", async () => {
    await expect(listedFileIds(visibilityUsers.stranger.id)).resolves.not.toContain(visibilityFiles.private);
    await expect(contentStatus(visibilityUsers.stranger.id, visibilityFiles.private)).resolves.toBe(403);
  });

  it("propagates an org-wide entity share on both routes", async () => {
    await expect(listedFileIds(visibilityUsers.stranger.id)).resolves.toContain(visibilityFiles.propagated);
    await expect(contentStatus(visibilityUsers.stranger.id, visibilityFiles.propagated)).resolves.toBe(200);
  });

  it("does not leak another email's entity share to a Slack-only viewer", async () => {
    await expect(listedFileIds(visibilityUsers.slackOnly.id)).resolves.not.toContain(
      visibilityFiles.individualEntityShare,
    );
    await expect(contentStatus(visibilityUsers.slackOnly.id, visibilityFiles.individualEntityShare)).resolves.toBe(403);
  });

  it("reaches a phone-scoped file on both routes for a user whose stored number is punctuated", async () => {
    await expect(listedFileIds(visibilityUsers.messyPhone.id)).resolves.toContain(visibilityFiles.phoneScope);
    await expect(contentStatus(visibilityUsers.messyPhone.id, visibilityFiles.phoneScope)).resolves.toBe(200);
  });
});
