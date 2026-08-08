/**
 * Walks a set of related files oldest-first, minting tasks from each through the real
 * HTTP route, so the recipe can be judged the way it will actually run.
 *
 * The point is the sequence, not any single file. File 1 has nothing before it. File 2
 * should build on file 1's tasks rather than restate them. By file 5 it is obvious
 * whether dedup and relevance are working.
 *
 * Goes through `createApp` + `app.request` rather than calling the minting functions, so
 * auth, permissions and serialization all run. Reads DATABASE_URL from the repo-root
 * .env like every other script here.
 *
 *   tsx src/scripts/mint-walk.ts --match praevorium --user himanshu@canvasx.ai
 *   tsx src/scripts/mint-walk.ts --match praevorium --reset     # clear prior output first
 *   tsx src/scripts/mint-walk.ts --match praevorium --dry-run   # list the files, mint nothing
 *
 * --reset deletes only the llm tasks and llm_task facts whose evidence is inside the
 * matched file set. It never touches tasks from other files or other provenances.
 */
import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "kysely";
import { SESSION_COOKIE } from "../api/auth";
import { signJwt } from "../auth/jwt";
import { loadConfig } from "../config";
import { createDatabase } from "../db/index";
import { createSettingsRepository } from "../db/repositories/settings";
import { createApp } from "../http";
import { createLogger } from "../logger";

interface MintContextBlock {
  key: string;
  label: string;
  selection: string;
  total: number;
  items: string[];
  truncated?: boolean;
}

interface MintCandidate {
  title: string;
  owner?: { name?: string | null; email?: string | null } | null;
  dueDate?: string | null;
  hasOwnerVerbObject: boolean;
  sourceExcerpt?: string | null;
  projectName?: string | null;
  taskId?: string | null;
}

interface MintResult {
  fileName: string;
  model: string;
  contentLength: number;
  truncated: boolean;
  context: MintContextBlock[];
  candidates: MintCandidate[];
  written: number;
  dumpDir?: string | null;
  similarFiles?: Array<{ fileId: string; fileName: string; similarity: number }>;
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}

const hasFlag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const match = arg("match");
  if (!match) throw new Error("--match <substring> is required, e.g. --match praevorium");
  const userEmail = arg("user", "himanshu@canvasx.ai") as string;
  const reset = hasFlag("reset");
  const dryRun = hasFlag("dry-run");
  const limit = Number(arg("limit", "0"));

  const config = loadConfig();
  const logger = createLogger(config);
  const db = await createDatabase(config);
  const app = createApp(db, config, { logger });

  const like = `%${match}%`;
  const files = await db
    .selectFrom("indexed_files")
    .select(["id", "file_name", "source", "source_created_at", "synced_at"])
    .where((eb) => eb.or([eb("file_name", "ilike", like), eb("content", "ilike", like)]))
    .orderBy(sql`coalesce(source_created_at, synced_at)` as never, "asc")
    .orderBy("id", "asc")
    .execute();

  const ordered = limit > 0 ? files.slice(0, limit) : files;
  console.log(`${ordered.length} files matching "${match}", oldest first\n`);
  for (const [i, f] of ordered.entries()) {
    console.log(
      `  ${String(i + 1).padStart(2)}. ${(f.source_created_at ?? f.synced_at ?? "").slice(0, 10)}  ${f.source.padEnd(16)}  ${f.file_name}`,
    );
  }
  if (dryRun) {
    await db.destroy();
    return;
  }

  const fileIds = ordered.map((f) => f.id);
  if (reset) {
    const taskIds = await db
      .selectFrom("task_evidence")
      .innerJoin("tasks", "tasks.id", "task_evidence.task_id")
      .select("tasks.id as id")
      .where("task_evidence.kind", "=", "file")
      .where("task_evidence.ref_id", "in", fileIds)
      .where("tasks.provenance", "=", "llm")
      .distinct()
      .execute();
    const ids = taskIds.map((t) => t.id);
    if (ids.length > 0) {
      await db.deleteFrom("task_evidence").where("task_id", "in", ids).execute();
      await db.deleteFrom("tasks").where("id", "in", ids).execute();
    }
    const facts = await db
      .deleteFrom("indexed_file_facts")
      .where("indexed_file_id", "in", fileIds)
      .where("fact_type", "=", "llm_task")
      .executeTakeFirst();
    console.log(
      `\nreset: deleted ${ids.length} llm tasks and ${Number(facts.numDeletedRows ?? 0)} llm_task facts scoped to these files\n`,
    );
  }

  const user = await db
    .selectFrom("users")
    .select(["id", "name", "auth_role"])
    .where("email", "=", userEmail)
    .executeTakeFirst();
  if (!user) throw new Error(`No user with email ${userEmail}`);

  const settings = await createSettingsRepository(db, config.ENCRYPTION_KEY).get();
  if (!settings?.jwt_secret) throw new Error("settings.jwt_secret is missing — cannot mint a session");
  const token = await signJwt(user.id, user.auth_role === "admin" ? "admin" : "member", settings.jwt_secret);
  const cookie = `${SESSION_COOKIE}=${token}`;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join("data", "mint-walks", `${match}__${stamp}`);
  await mkdir(outDir, { recursive: true });

  const rows: string[] = [];
  const md: string[] = [`# Mint walk — "${match}"`, "", `${ordered.length} files, oldest first, as ${user.name}.`, ""];
  let cumulativeWritten = 0;

  for (const [i, f] of ordered.entries()) {
    const n = i + 1;
    const date = (f.source_created_at ?? f.synced_at ?? "").slice(0, 10);
    const res = await app.request(`/api/connectors/files/${f.id}/tasks`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    const body = await res.text();
    if (res.status !== 200) {
      console.log(`\n${n}/${ordered.length}  ${date}  ${f.file_name}\n   HTTP ${res.status}  ${body.slice(0, 200)}`);
      md.push(
        `## ${n}. ${f.file_name}`,
        "",
        `\`${date}\` · ${f.source} · **HTTP ${res.status}** — ${body.slice(0, 300)}`,
        "",
      );
      rows.push(
        JSON.stringify({ n, fileId: f.id, fileName: f.file_name, date, status: res.status, body: body.slice(0, 500) }),
      );
      continue;
    }
    const r = JSON.parse(body) as MintResult;
    cumulativeWritten += r.written;

    const ctx = r.context.map((b) => `${b.key}=${b.items.length}/${b.total}`).join(" ");
    const promptChars = r.context.reduce((sum, b) => sum + b.items.join("\n").length, 0);
    console.log(
      `\n${n}/${ordered.length}  ${date}  ${f.source}  ${f.file_name}\n` +
        `   context: ${ctx}   content: ${r.contentLength}${r.truncated ? " (TRUNCATED)" : ""}\n` +
        `   minted ${r.candidates.length}, wrote ${r.written}  (running total ${cumulativeWritten})`,
    );
    if (r.similarFiles && r.similarFiles.length > 0) {
      const top = r.similarFiles.slice(0, 3).map((s) => `${s.similarity.toFixed(2)} ${s.fileName}`);
      console.log(`   nearest: ${top.join(" | ")}`);
    }
    for (const c of r.candidates) {
      const owner = c.owner?.name ?? c.owner?.email ?? "no owner";
      console.log(`      ${c.taskId ? "+" : "·"} ${c.title}  [${owner}${c.projectName ? ` · ${c.projectName}` : ""}]`);
    }

    md.push(
      `## ${n}. ${f.file_name}`,
      "",
      `\`${date}\` · ${f.source} · ${r.contentLength} chars${r.truncated ? " · **truncated**" : ""} · context ${promptChars} chars`,
      "",
      ...r.context.map((b) => `- **${b.label}** — ${b.items.length} of ${b.total}. _${b.selection}_`),
      "",
      ...(r.similarFiles && r.similarFiles.length > 0
        ? [
            "<details><summary>Nearest files by embedding</summary>",
            "",
            ...r.similarFiles.map((s) => `- \`${s.similarity.toFixed(3)}\` ${s.fileName}`),
            "",
            "</details>",
            "",
          ]
        : []),
      r.candidates.length === 0
        ? "_No tasks extracted._"
        : r.candidates
            .map(
              (c) =>
                `- ${c.taskId ? "**written**" : "_not written_"} — ${c.title}\n  - owner: ${c.owner?.name ?? c.owner?.email ?? "none"} · project: ${c.projectName ?? "none"} · due: ${c.dueDate ?? "none"}${c.sourceExcerpt ? `\n  - > ${c.sourceExcerpt}` : ""}`,
            )
            .join("\n"),
      "",
    );
    rows.push(JSON.stringify({ n, fileId: f.id, date, source: f.source, ...r }));
  }

  md.push("---", "", `**${cumulativeWritten} tasks written across ${ordered.length} files.**`, "");
  await writeFile(join(outDir, "walk.jsonl"), `${rows.join("\n")}\n`, "utf8");
  await writeFile(join(outDir, "walk.md"), md.join("\n"), "utf8");
  console.log(`\n\n${cumulativeWritten} tasks written across ${ordered.length} files.`);
  console.log(`\n${join(outDir, "walk.md")}`);

  await db.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
