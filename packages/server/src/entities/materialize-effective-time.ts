import type { IndexedFileFactRow, MaterializeDeps } from "./materialize-types";

export async function resolveEffectiveAt(
  deps: MaterializeDeps,
  fact: IndexedFileFactRow,
  explicitTime?: string,
): Promise<string | null> {
  const sourceTimes = fact.indexed_file_id ? await deps.getIndexedFileSourceTime(fact.indexed_file_id) : null;
  const value =
    explicitTime ?? sourceTimes?.source_updated_at ?? sourceTimes?.source_created_at ?? sourceTimes?.synced_at;
  if (!value) return null;
  return new Date(value).toISOString();
}
