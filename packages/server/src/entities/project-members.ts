import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { DB } from "../db/schema";
import { ProjectBindingError, createProjectBindingsService, isLiveProject } from "./project-bindings";

const DEFAULT_LIMIT = 200;

export type MemberRow = {
  indexedFileId: string;
  fileName: string;
  fileType: string | null;
  source: string;
  providerUrl: string | null;
  viaProjectId: string | null;
  containerId: string | null;
  manual: boolean;
};

export function createProjectMembersService(db: Kysely<DB>) {
  const bindings = createProjectBindingsService(db);

  async function resolveProjectMembers(
    projectId: string,
    opts?: { limit?: number },
  ): Promise<{ members: MemberRow[]; truncated: boolean }> {
    const limit = opts?.limit ?? DEFAULT_LIMIT;
    const effective = await bindings.resolveEffectiveBindings(projectId);
    const containerByKey = new Map<string, { viaProjectId: string; containerId: string }>();
    for (const b of effective) {
      const key = `${b.source}:${b.containerId}`;
      if (!containerByKey.has(key)) {
        containerByKey.set(key, { viaProjectId: b.viaProjectId, containerId: b.containerId });
      }
    }

    const overrides = await db
      .selectFrom("entity_project_member_overrides")
      .select(["indexed_file_id", "mode"])
      .where("entity_id", "=", projectId)
      .execute();
    const excluded = new Set(overrides.filter((o) => o.mode === "exclude").map((o) => o.indexed_file_id));
    const includedIds = overrides.filter((o) => o.mode === "include").map((o) => o.indexed_file_id);

    const byFile = new Map<string, MemberRow>();

    if (containerByKey.size > 0) {
      const sources = [...new Set([...containerByKey.keys()].map((k) => k.split(":")[0]))];
      const containerIds = [...new Set([...containerByKey.values()].map((v) => v.containerId))];
      const rows = await db
        .selectFrom("indexed_file_facts as f")
        .innerJoin("indexed_files as i", "i.id", "f.indexed_file_id")
        .select([
          "i.id as id",
          "i.file_name as file_name",
          "i.file_type as file_type",
          "i.source as source",
          "i.provider_url as provider_url",
          "f.subject_source as subject_source",
          "f.subject_source_id as subject_source_id",
        ])
        .where("f.fact_type", "=", "parent_entity")
        .where("f.deleted_at", "is", null)
        .where("i.is_archived", "=", 0)
        .where("f.subject_source", "in", sources)
        .where("f.subject_source_id", "in", containerIds)
        .execute();
      for (const r of rows) {
        const key = `${r.subject_source}:${r.subject_source_id}`;
        const container = containerByKey.get(key);
        if (!container) continue;
        if (excluded.has(r.id)) continue;
        if (byFile.has(r.id)) continue;
        byFile.set(r.id, {
          indexedFileId: r.id,
          fileName: r.file_name,
          fileType: r.file_type,
          source: r.source,
          providerUrl: r.provider_url,
          viaProjectId: container.viaProjectId,
          containerId: container.containerId,
          manual: false,
        });
      }
    }

    const manualToAdd = includedIds.filter((id) => !byFile.has(id) && !excluded.has(id));
    if (manualToAdd.length > 0) {
      const files = await db
        .selectFrom("indexed_files")
        .select(["id", "file_name", "file_type", "source", "provider_url"])
        .where("id", "in", manualToAdd)
        .execute();
      for (const f of files) {
        byFile.set(f.id, {
          indexedFileId: f.id,
          fileName: f.file_name,
          fileType: f.file_type,
          source: f.source,
          providerUrl: f.provider_url,
          viaProjectId: null,
          containerId: null,
          manual: true,
        });
      }
    }

    const all = [...byFile.values()];
    return { members: all.slice(0, limit), truncated: all.length > limit };
  }

  return {
    resolveProjectMembers,

    async setMembership(
      projectId: string,
      indexedFileId: string,
      mode: "include" | "exclude",
      userId: string,
    ): Promise<void> {
      if (!(await isLiveProject(db, projectId))) throw new ProjectBindingError("NOT_A_PROJECT");
      const existing = await db
        .selectFrom("entity_project_member_overrides")
        .select("id")
        .where("entity_id", "=", projectId)
        .where("indexed_file_id", "=", indexedFileId)
        .executeTakeFirst();
      if (existing) {
        await db.updateTable("entity_project_member_overrides").set({ mode }).where("id", "=", existing.id).execute();
        return;
      }
      await db
        .insertInto("entity_project_member_overrides")
        .values({ id: randomUUID(), entity_id: projectId, indexed_file_id: indexedFileId, mode, created_by: userId })
        .execute();
    },

    async clearMembership(projectId: string, indexedFileId: string): Promise<boolean> {
      const res = await db
        .deleteFrom("entity_project_member_overrides")
        .where("entity_id", "=", projectId)
        .where("indexed_file_id", "=", indexedFileId)
        .executeTakeFirst();
      return Number(res.numDeletedRows ?? 0n) > 0;
    },
  };
}
