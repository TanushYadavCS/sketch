import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { Kysely } from "kysely";
import type { createExternalMcpToolCallRepository } from "../../db/repositories/external-mcp-tool-calls";
import type { DB } from "../../db/schema";
import { Semaphore } from "../server/rate-limit";
import {
  type CurationCompanyDominanceArgs,
  curationCompanyDominanceSchema,
  handleCurationCompanyDominance,
} from "./company-dominance";
import {
  type CurationEntityEvidenceArgs,
  curationEntityEvidenceSchema,
  handleCurationEntityEvidence,
} from "./entity-evidence";
import { type CurationFindEntitiesArgs, curationFindEntitiesSchema, handleCurationFindEntities } from "./find-entities";
import { handleCurationGraphOverview } from "./graph-overview";
import {
  type CurationListAffiliationsArgs,
  curationListAffiliationsSchema,
  handleCurationListAffiliations,
} from "./list-affiliations";
import {
  type CurationListCandidatesArgs,
  curationListCandidatesSchema,
  handleCurationListCandidates,
} from "./list-candidates";
import {
  type CurationSharedEvidenceArgs,
  curationSharedEvidenceSchema,
  handleCurationSharedEvidence,
} from "./shared-evidence";

type AuditRepo = ReturnType<typeof createExternalMcpToolCallRepository>;
type ToolResult = { content: { type: "text"; text: string }[] };

const toolSemaphore = new Semaphore(4);
const emptySchema = {};
const sharedEvidenceDescription = [
  "Return shared evidence.",
  "sharedFiles is the intersection across ALL provided entities; a trio can return 0 while " +
    "a pair inside it shares many.",
  "pairwiseSharedFiles gives each pair.",
  "Person fields appear only for all-person input, and sharedCorporateDomains appears only for all-company input.",
].join(" ");

export async function createCurationMcpServer(params: {
  db: Kysely<DB>;
  userId: string;
  tokenId: string;
  auditRepo: AuditRepo;
}): Promise<McpServer> {
  const server = new McpServer({ name: "sketch-curation", version: "1.0.0" });

  function register<TArgs extends Record<string, unknown>>(
    name: string,
    description: string,
    inputSchema: ZodRawShapeCompat,
    handler: (args: TArgs) => Promise<ToolResult>,
  ) {
    server.registerTool(name, { description, inputSchema }, async (args) => {
      const startedAt = Date.now();
      let success = false;
      try {
        const result = await toolSemaphore.run(() => handler(args as TArgs));
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

  register(
    "curation_graph_overview",
    "Return global graph counts and read-only curation backlog summary.",
    emptySchema,
    () => handleCurationGraphOverview(params.db),
  );
  register<CurationFindEntitiesArgs>(
    "curation_find_entities",
    "Find live and tombstoned entities by exact, substring, and merge-aware tombstone tiers.",
    curationFindEntitiesSchema,
    (args) => handleCurationFindEntities(args, params.db),
  );
  register<CurationEntityEvidenceArgs>(
    "curation_entity_evidence",
    "Return raw admin evidence for a live or tombstoned entity without viewer filtering.",
    curationEntityEvidenceSchema,
    (args) => handleCurationEntityEvidence(args, params.db),
  );
  register<CurationCompanyDominanceArgs>(
    "curation_company_dominance",
    "Return exact mention and participant-affiliation file counts for a project.",
    curationCompanyDominanceSchema,
    (args) => handleCurationCompanyDominance(args, params.db),
  );
  register<CurationListAffiliationsArgs>(
    "curation_list_affiliations",
    "Return works_at and engaged_with evidence plus email-domain flags for a person.",
    curationListAffiliationsSchema,
    (args) => handleCurationListAffiliations(args, params.db),
  );
  register<CurationSharedEvidenceArgs>(
    "curation_shared_evidence",
    sharedEvidenceDescription,
    curationSharedEvidenceSchema,
    (args) => handleCurationSharedEvidence(args, params.db),
  );
  register<CurationListCandidatesArgs>(
    "curation_list_candidates",
    "List read-only curation candidate rows for supported candidate families.",
    curationListCandidatesSchema,
    (args) => handleCurationListCandidates(args, params.db),
  );

  return server;
}
