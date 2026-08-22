import type { Kysely } from "kysely";
import { z } from "zod/v4";
import type { DB } from "../../db/schema";
import { jsonResult, listAffiliations } from "./queries";

export const curationListAffiliationsSchema = {
  personId: z.string().describe("Person entity id."),
};

export type CurationListAffiliationsArgs = z.infer<z.ZodObject<typeof curationListAffiliationsSchema>>;

export async function handleCurationListAffiliations(args: CurationListAffiliationsArgs, db: Kysely<DB>) {
  return jsonResult(await listAffiliations(db, args.personId));
}
