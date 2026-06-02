/**
 * Entity-timeline: file mentions of a single entity, ordered newest-first,
 * one row per file (multiple mentions on the same file collapse). Caller
 * groups by month in TypeScript — we keep the query dialect-portable.
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { DB } from "../schema";
import { type FileViewer, fileVisibilityPredicate } from "./connectors";

export interface TimelineItem {
  fileId: string;
  fileName: string;
  sourceType: string;
  occurredAt: string;
  mentionConfidence: "EXTRACTED" | "INFERRED" | "AMBIGUOUS";
  mentionCount: number;
  contextSnippet: string | null;
  url: string | null;
}

export interface TimelineGroup {
  month: string; // "YYYY-MM"
  items: TimelineItem[];
}

const CONFIDENCE_ORDER: Record<string, number> = { EXTRACTED: 0, INFERRED: 1, AMBIGUOUS: 2 };

function normalizeConfidence(value: string): TimelineItem["mentionConfidence"] {
  return value === "EXTRACTED" || value === "INFERRED" || value === "AMBIGUOUS" ? value : "AMBIGUOUS";
}

function monthKey(iso: string): string {
  // Parse the ISO timestamp's date portion directly; avoids Date-object
  // timezone surprises across SQLite/Postgres returned strings.
  const match = iso.match(/^(\d{4})-(\d{2})/);
  if (match) return `${match[1]}-${match[2]}`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function createEntityTimelineRepository(db: Kysely<DB>) {
  return {
    /**
     * List timeline rows for an entity, with file RBAC. Collapses per-file
     * mentions into one TimelineItem per file (mentionCount = count of
     * mentions on that file). Sorted newest-first.
     */
    async listTimelineForEntity(
      entityId: string,
      opts: { limit: number; viewer: FileViewer },
    ): Promise<{ groups: TimelineGroup[]; truncated: boolean; totalCount: number }> {
      const { limit, viewer } = opts;

      let rowsQuery = db
        .selectFrom("entity_mentions")
        .innerJoin("indexed_files", "indexed_files.id", "entity_mentions.indexed_file_id")
        .select([
          "indexed_files.id as file_id",
          "indexed_files.file_name",
          "indexed_files.source as file_source",
          "indexed_files.source_updated_at",
          "indexed_files.source_created_at",
          "indexed_files.provider_url",
          "entity_mentions.confidence",
          "entity_mentions.context_snippet",
          "entity_mentions.mentioned_at",
        ])
        .where("entity_mentions.entity_id", "=", entityId)
        .orderBy(
          sql`COALESCE(indexed_files.source_updated_at, indexed_files.source_created_at, entity_mentions.mentioned_at)`,
          "desc",
        )
        // Pull a bigger window so per-file collapse can still hit `limit` items
        // even when files have multiple mentions. Worst-case bounded at limit*5.
        .limit(limit * 5);
      if (!viewer.isAdmin) rowsQuery = rowsQuery.where(fileVisibilityPredicate(viewer));
      const rows = await rowsQuery.execute();

      const byFile = new Map<string, TimelineItem>();
      for (const row of rows) {
        const occurredAt = row.source_updated_at ?? row.source_created_at ?? row.mentioned_at;
        const existing = byFile.get(row.file_id);
        if (existing) {
          existing.mentionCount += 1;
          // Keep the strongest confidence seen for this file (EXTRACTED beats INFERRED beats AMBIGUOUS).
          const inboundRank = CONFIDENCE_ORDER[row.confidence] ?? 3;
          const existingRank = CONFIDENCE_ORDER[existing.mentionConfidence] ?? 3;
          if (inboundRank < existingRank) existing.mentionConfidence = normalizeConfidence(row.confidence);
          if (!existing.contextSnippet && row.context_snippet) existing.contextSnippet = row.context_snippet;
          continue;
        }
        byFile.set(row.file_id, {
          fileId: row.file_id,
          fileName: row.file_name,
          sourceType: row.file_source,
          occurredAt,
          mentionConfidence: normalizeConfidence(row.confidence),
          mentionCount: 1,
          contextSnippet: row.context_snippet ?? null,
          url: row.provider_url ?? null,
        });
      }

      const ordered = Array.from(byFile.values()).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
      const truncated = ordered.length > limit;
      const capped = ordered.slice(0, limit);

      const groupsMap = new Map<string, TimelineItem[]>();
      for (const item of capped) {
        const key = monthKey(item.occurredAt);
        const bucket = groupsMap.get(key);
        if (bucket) bucket.push(item);
        else groupsMap.set(key, [item]);
      }
      const groups: TimelineGroup[] = Array.from(groupsMap.entries())
        .sort(([a], [b]) => b.localeCompare(a))
        .map(([month, items]) => ({ month, items }));

      return { groups, truncated, totalCount: capped.length };
    },
  };
}
