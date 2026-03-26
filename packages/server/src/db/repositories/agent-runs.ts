import { randomUUID } from "node:crypto";
import type { Insertable, Kysely } from "kysely";
import type { DB } from "../schema";

type NewAgentRun = Insertable<DB["agent_runs"]>;
type NewToolCall = Insertable<DB["tool_calls"]>;

export function createAgentRunsRepo(db: Kysely<DB>) {
  return {
    async insertRun(run: Omit<NewAgentRun, "id"> & { id?: string }): Promise<string> {
      const id = run.id ?? randomUUID();
      await db
        .insertInto("agent_runs")
        .values({ ...run, id })
        .execute();
      return id;
    },

    async insertToolCalls(calls: NewToolCall[]): Promise<void> {
      if (calls.length === 0) return;
      await db.insertInto("tool_calls").values(calls).execute();
    },
  };
}
