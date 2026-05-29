import type { EntityMentionConfidence, EntityMentionRelation } from "../db/repositories/entities";
import type { MaterializeDeps } from "./materialize-types";

export async function createMentionFromFact(
  deps: MaterializeDeps,
  data: {
    entityId: string;
    indexedFileId: string;
    contextSnippet: string | null;
    confidence: EntityMentionConfidence;
    source: string;
    relation: EntityMentionRelation;
  },
): Promise<void> {
  const now = new Date().toISOString();
  if (data.confidence === "EXTRACTED") {
    await deps.db
      .updateTable("entity_mentions")
      .set({
        context_snippet: data.contextSnippet,
        confidence: "EXTRACTED",
        source: data.source,
        mentioned_at: now,
      })
      .where("entity_id", "=", data.entityId)
      .where("indexed_file_id", "=", data.indexedFileId)
      .where("relation", "=", data.relation)
      .where("confidence", "!=", "EXTRACTED")
      .execute();
  }

  await deps.entityRepo.createMention({
    entityId: data.entityId,
    indexedFileId: data.indexedFileId,
    contextSnippet: data.contextSnippet,
    confidence: data.confidence,
    source: data.source,
    relation: data.relation,
  });
}
