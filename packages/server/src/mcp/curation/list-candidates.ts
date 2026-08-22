import type { Kysely } from "kysely";
import { z } from "zod/v4";
import type { DB } from "../../db/schema";
import { clampLimit, jsonResult, listCandidates } from "./queries";

export const curationListCandidatesSchema = {
  kind: z.enum(["unlinked_project", "stuck_review_rows"]).describe("Candidate family to list."),
  limit: z.number().optional().describe("Page size. Default 50, max 100."),
  offset: z.number().optional().describe("Offset. Default 0."),
  entityType: z.string().optional().describe("stuck_review_rows filter."),
  candidateReason: z.string().optional().describe("stuck_review_rows filter; use none for null."),
  origin: z.enum(["tracker", "inferred"]).optional().describe("stuck_review_rows origin filter."),
};

export type CurationListCandidatesArgs = z.infer<z.ZodObject<typeof curationListCandidatesSchema>>;

export async function handleCurationListCandidates(args: CurationListCandidatesArgs, db: Kysely<DB>) {
  return jsonResult(
    await listCandidates(db, {
      kind: args.kind,
      limit: clampLimit(args.limit, 50, 100),
      offset: Math.max(0, Math.trunc(args.offset ?? 0)),
      entityType: args.entityType,
      candidateReason: args.candidateReason,
      origin: args.origin,
    }),
  );
}
