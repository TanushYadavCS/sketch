import type { Kysely } from "kysely";
import { z } from "zod/v4";
import type { DB } from "../../db/schema";
import { jsonResult, sharedEvidence } from "./queries";

const entityIdsDescription = [
  "Two to five entity ids to compare.",
  "sharedFiles is the intersection across ALL provided entities; a trio can return 0 while " +
    "a pair inside it shares many.",
  "pairwiseSharedFiles gives each pair.",
  "Person fields appear only for all-person input, and sharedCorporateDomains appears only for all-company input.",
].join(" ");

export const curationSharedEvidenceSchema = {
  entityIds: z.array(z.string()).min(2).max(5).describe(entityIdsDescription),
};

export type CurationSharedEvidenceArgs = z.infer<z.ZodObject<typeof curationSharedEvidenceSchema>>;

export async function handleCurationSharedEvidence(args: CurationSharedEvidenceArgs, db: Kysely<DB>) {
  return jsonResult(await sharedEvidence(db, args.entityIds));
}
