/**
 * D4 is observable only through publicMcp.userPrincipals because every other entry point resolves through
 * viewerPrincipals, which canonicalized phone and LID principals before PR-C. The branch point is
 * agent/tools/search.ts:97-111.
 */
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AccessPrincipalInput } from "../../connectors/types";
import { createUserRepository } from "../../db/repositories/users";
import type { DB } from "../../db/schema";
import { createTestPgDb } from "../../test-utils";
import {
  VISIBILITY_QUERY,
  allVisibilityFileIds,
  seedFileVisibilityFixture,
  visibilityFiles,
  visibilityUsers,
} from "../../test/file-visibility-e2e-fixture";
import { handleGetFileContent, handleSearch } from "./search";
import type { SketchMcpDeps, ToolResult } from "./types";

describe("file visibility through the agent tools", () => {
  let db: Kysely<DB>;

  beforeAll(async () => {
    db = await createTestPgDb();
    await seedFileVisibilityFixture(db);
  }, 30_000);

  afterAll(async () => {
    await db.destroy();
  });

  function depsForUser(userId: string): SketchMcpDeps {
    return {
      db,
      currentUserId: userId,
      userRepo: createUserRepository(db),
      slackEntitySyncEnabled: true,
    } as unknown as SketchMcpDeps;
  }

  function depsForPublicPrincipals(principals: AccessPrincipalInput[]): SketchMcpDeps {
    return {
      db,
      publicMcp: { userPrincipals: principals },
      slackEntitySyncEnabled: true,
    } as unknown as SketchMcpDeps;
  }

  function resultText(result: ToolResult): string {
    const first = result.content[0];
    return first && first.type === "text" ? first.text : "";
  }

  async function searchedFileIds(userId: string): Promise<string[]> {
    const result = await handleSearch({ query: VISIBILITY_QUERY, limit: 50 }, depsForUser(userId));
    return [...resultText(result).matchAll(/sketchId: (\S+)/gu)].map((match) => match[1]).sort();
  }

  async function canRead(userId: string, fileId: string): Promise<boolean> {
    const result = await handleGetFileContent({ fileId }, depsForUser(userId));
    return !resultText(result).includes(`File ${fileId} not found.`);
  }

  it.each([
    [
      `keeps Search and GetFileContent aligned for ${visibilityUsers.scopeMember.id}`,
      visibilityUsers.scopeMember.id,
      [visibilityFiles.private, visibilityFiles.propagated],
    ],
    [
      `keeps Search and GetFileContent aligned for ${visibilityUsers.fileGrant.id}`,
      visibilityUsers.fileGrant.id,
      [visibilityFiles.fileGrant, visibilityFiles.propagated],
    ],
    [
      `keeps Search and GetFileContent aligned for ${visibilityUsers.shareTarget.id}`,
      visibilityUsers.shareTarget.id,
      [visibilityFiles.manualShare, visibilityFiles.propagated],
    ],
    [
      `keeps Search and GetFileContent aligned for ${visibilityUsers.stranger.id}`,
      visibilityUsers.stranger.id,
      [visibilityFiles.propagated],
    ],
    [
      `keeps Search and GetFileContent aligned for ${visibilityUsers.slackOnly.id}`,
      visibilityUsers.slackOnly.id,
      [visibilityFiles.propagated],
    ],
    [
      "reaches a phone-scoped file through aligned Search and GetFileContent for a user whose stored number is punctuated",
      visibilityUsers.messyPhone.id,
      [visibilityFiles.phoneScope, visibilityFiles.propagated],
    ],
  ])("%s", async (_name, userId, expectedFileIds) => {
    const searched = await searchedFileIds(userId);
    expect(searched).toEqual([...expectedFileIds].sort());

    const readable: string[] = [];
    for (const fileId of allVisibilityFileIds) {
      if (await canRead(userId, fileId)) readable.push(fileId);
    }
    expect(readable.sort()).toEqual(searched);
  });

  it("keeps a private scoped file hidden while propagating an org-wide entity share", async () => {
    const searched = await searchedFileIds(visibilityUsers.stranger.id);
    expect(searched).not.toContain(visibilityFiles.private);
    expect(await canRead(visibilityUsers.stranger.id, visibilityFiles.private)).toBe(false);
    expect(searched).toContain(visibilityFiles.propagated);
    expect(await canRead(visibilityUsers.stranger.id, visibilityFiles.propagated)).toBe(true);
  });

  it("does not leak another email's entity share to a Slack-only agent", async () => {
    await expect(searchedFileIds(visibilityUsers.slackOnly.id)).resolves.not.toContain(
      visibilityFiles.individualEntityShare,
    );
    await expect(canRead(visibilityUsers.slackOnly.id, visibilityFiles.individualEntityShare)).resolves.toBe(false);
  });

  it("reaches a phone-scoped file through Search and GetFileContent for a user whose stored number is punctuated", async () => {
    await expect(searchedFileIds(visibilityUsers.messyPhone.id)).resolves.toContain(visibilityFiles.phoneScope);
    await expect(canRead(visibilityUsers.messyPhone.id, visibilityFiles.phoneScope)).resolves.toBe(true);
  });

  /** This is the sole D4 regression test because it exercises caller-supplied public MCP principals. */
  it("normalizes a raw public-MCP phone principal for Search and GetFileContent", async () => {
    const deps = depsForPublicPrincipals([{ type: "phone", value: visibilityUsers.messyPhone.whatsappNumber }]);
    const searchResult = await handleSearch({ query: VISIBILITY_QUERY, limit: 50 }, deps);
    expect(resultText(searchResult)).toContain(`sketchId: ${visibilityFiles.phoneScope}`);

    const contentResult = await handleGetFileContent({ fileId: visibilityFiles.phoneScope }, deps);
    expect(resultText(contentResult)).toContain(`${VISIBILITY_QUERY} content for ${visibilityFiles.phoneScope}`);
  });
});
