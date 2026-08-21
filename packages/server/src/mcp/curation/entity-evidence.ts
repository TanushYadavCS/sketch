import type { Kysely } from "kysely";
import { z } from "zod/v4";
import type { DB } from "../../db/schema";
import { clampLimit, jsonResult, rawEntityEvidence } from "./queries";

export const curationEntityEvidenceSchema = {
  entityId: z.string().describe("Entity id to inspect, including tombstoned ids."),
  mentionLimit: z.number().optional().describe("Mention rows to return. Default 20, max 50."),
};

export type CurationEntityEvidenceArgs = z.infer<z.ZodObject<typeof curationEntityEvidenceSchema>>;

export async function handleCurationEntityEvidence(args: CurationEntityEvidenceArgs, db: Kysely<DB>) {
  return jsonResult(await rawEntityEvidence(db, args.entityId, clampLimit(args.mentionLimit, 20, 50)));
}
