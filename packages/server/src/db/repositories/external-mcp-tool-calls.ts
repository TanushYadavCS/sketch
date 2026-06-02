import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { DB } from "../schema";

export function createExternalMcpToolCallRepository(db: Kysely<DB>) {
  return {
    async create(input: {
      tokenId: string;
      userId: string;
      toolName: string;
      success: boolean;
      durationMs: number;
    }): Promise<void> {
      await db
        .insertInto("external_mcp_tool_calls")
        .values({
          id: randomUUID(),
          token_id: input.tokenId,
          user_id: input.userId,
          tool_name: input.toolName,
          success: input.success ? 1 : 0,
          duration_ms: Math.max(0, Math.round(input.durationMs)),
        })
        .execute();
    },
  };
}
