import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { Kysely } from "kysely";
import {
  getEntityContextToolDescription,
  getEntityContextToolSchema,
  getFileContentToolDescription,
  getFileContentToolSchema,
  handleGetEntityContext,
  handleGetFileContent,
  handleSearch,
  handleSearchEntities,
  searchEntitiesToolDescription,
  searchEntitiesToolSchema,
  searchToolDescription,
  searchToolSchema,
} from "../../agent/tools/search";
import { type SketchMcpDeps, UploadCollector } from "../../agent/tools/types";
import { toEmailPrincipals } from "../../connectors/types";
import type { createExternalMcpToolCallRepository } from "../../db/repositories/external-mcp-tool-calls";
import type { createUserRepository } from "../../db/repositories/users";
import type { DB } from "../../db/schema";
import { Semaphore } from "./rate-limit";

type UserRepo = ReturnType<typeof createUserRepository>;
type AuditRepo = ReturnType<typeof createExternalMcpToolCallRepository>;

const MAX_FILE_CONTENT_CHARS = 50_000;
const toolSemaphore = new Semaphore(4);

export async function createPublicSketchMcpServer(params: {
  db: Kysely<DB>;
  userRepo: UserRepo;
  userId: string;
  tokenId: string;
  workspaceDir: string;
  auditRepo: AuditRepo;
}): Promise<McpServer> {
  const userPrincipals = toEmailPrincipals(await params.userRepo.getVerifiedEmailsForUser(params.userId));
  const deps: SketchMcpDeps = {
    uploadCollector: new UploadCollector(),
    workspaceDir: params.workspaceDir,
    db: params.db,
    userRepo: params.userRepo,
    currentUserId: params.userId,
    publicMcp: {
      userPrincipals,
      filterEntityMetadata: true,
      maxFileContentChars: MAX_FILE_CONTENT_CHARS,
    },
  };
  const server = new McpServer({ name: "sketch", version: "1.0.0" });

  function register<TArgs extends Record<string, unknown>>(
    name: string,
    description: string,
    inputSchema: ZodRawShapeCompat,
    handler: (args: TArgs, deps: SketchMcpDeps) => Promise<{ content: { type: "text"; text: string }[] }>,
  ) {
    server.registerTool(name, { description, inputSchema }, async (args) => {
      const startedAt = Date.now();
      let success = false;
      try {
        const result = await toolSemaphore.run(() => handler(args as TArgs, deps));
        success = true;
        return result;
      } finally {
        const durationMs = Date.now() - startedAt;
        void params.auditRepo
          .create({
            tokenId: params.tokenId,
            userId: params.userId,
            toolName: name,
            success,
            durationMs,
          })
          .catch(() => undefined);
      }
    });
  }

  register("sketch_search", searchToolDescription, searchToolSchema, handleSearch);
  register("sketch_search_entities", searchEntitiesToolDescription, searchEntitiesToolSchema, handleSearchEntities);
  register(
    "sketch_get_entity_context",
    getEntityContextToolDescription,
    getEntityContextToolSchema,
    handleGetEntityContext,
  );
  register("sketch_get_file_content", getFileContentToolDescription, getFileContentToolSchema, handleGetFileContent);

  return server;
}
