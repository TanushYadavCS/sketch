import type { Kysely } from "kysely";
import { z } from "zod/v4";
import type { DB } from "../../db/schema";
import { companyDominance, jsonResult } from "./queries";

export const curationCompanyDominanceSchema = {
  projectId: z.string().describe("Project entity id."),
};

export type CurationCompanyDominanceArgs = z.infer<z.ZodObject<typeof curationCompanyDominanceSchema>>;

export async function handleCurationCompanyDominance(args: CurationCompanyDominanceArgs, db: Kysely<DB>) {
  return jsonResult(await companyDominance(db, args.projectId));
}
