import type { Kysely } from "kysely";
import { z } from "zod/v4";
import type { DB } from "../../db/schema";
import { findEntitiesForCuration, jsonResult } from "./queries";

export const curationFindEntitiesSchema = {
  queries: z.array(z.string()).describe("Names, aliases, or fragments to search for."),
  types: z.array(z.string()).optional().describe("Optional entity source_type filter."),
  includeTombstones: z.boolean().optional().describe("Include merged/deleted rows. Defaults to true."),
};

export type CurationFindEntitiesArgs = z.infer<z.ZodObject<typeof curationFindEntitiesSchema>>;

export async function handleCurationFindEntities(args: CurationFindEntitiesArgs, db: Kysely<DB>) {
  return jsonResult(await findEntitiesForCuration(db, args));
}
