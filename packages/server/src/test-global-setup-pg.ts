import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Path to the cached PGlite template: a gzipped `dumpDataDir` tarball of the
 * fully-migrated Postgres schema. `createTestPgDb()` builds it once per run and
 * restores from it via `loadDataDir` thereafter (skips initdb + the migration
 * replay). Keyed by cwd so parallel worktrees never share or clobber each
 * other's cache, which would otherwise let one worktree's schema leak into
 * another's tests.
 */
export const PG_TEMPLATE_PATH = join(
  tmpdir(),
  `sketch-pg-template-${createHash("sha1").update(process.cwd()).digest("hex").slice(0, 12)}.tgz`,
);

/**
 * Integration-only globalSetup: delete the cached PGlite template at the start of
 * every run so it is always rebuilt from the current migration set (no staleness
 * across runs or migration edits). This only unlinks a file — it never boots
 * PGlite — so unlike building the template here, it adds zero memory to the
 * long-lived main process (PGlite's ~1.3 GB WASM heap never returns to the OS on
 * close). Attached to the integration project alone, so the fast unit inner loop
 * never runs it and never builds a template.
 */
export default async function resetPgTemplate(): Promise<void> {
  await rm(PG_TEMPLATE_PATH, { force: true });
}
