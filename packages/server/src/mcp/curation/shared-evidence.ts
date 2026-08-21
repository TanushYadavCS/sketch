import type { Kysely } from "kysely";
import { z } from "zod/v4";
import type { DB } from "../../db/schema";
import { jsonResult, sharedEvidence } from "./queries";

export const curationSharedEvidenceSchema = {
  entityIds: z.array(z.string()).min(2).max(5).describe("Two to five entity ids to compare."),
};

export type CurationSharedEvidenceArgs = z.infer<z.ZodObject<typeof curationSharedEvidenceSchema>>;

export async function handleCurationSharedEvidence(args: CurationSharedEvidenceArgs, db: Kysely<DB>) {
  return jsonResult(await sharedEvidence(db, args.entityIds));
}
