/**
 * Git worktree helper for isolated feature development.
 *
 * Create: pnpm worktree:create <branch>
 *   - Creates ../sketch-<branch> worktree on a new branch tracking origin/main
 *   - Copies .env from main repo with worktree-local data paths, inits .planning submodule (skips if no access)
 *   - Installs dependencies
 *
 * Remove: pnpm worktree:remove <branch>
 *   - Removes the worktree and deletes the local branch
 *
 * List: pnpm worktree:list
 *   - Lists all active worktrees
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAIN_REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(cmd: string, cwd?: string) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd });
}

function envValue(value: string): string {
  return /[\s#"'\\]/.test(value) ? JSON.stringify(value) : value;
}

function setEnvValue(env: string, key: string, value: string): string {
  const line = `${key}=${envValue(value)}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  return pattern.test(env) ? env.replace(pattern, line) : `${env.trimEnd()}\n${line}\n`;
}

function createWorktreeEnv(worktreeDir: string) {
  const sourceEnv = resolve(MAIN_REPO, ".env");
  const targetEnv = resolve(worktreeDir, ".env");
  const dataDir = resolve(worktreeDir, "data");

  if (!existsSync(sourceEnv)) {
    console.log("No .env found in main repo; create one from .env.example before running dev.");
    return;
  }

  let env = readFileSync(sourceEnv, "utf8");
  env = setEnvValue(env, "DATA_DIR", dataDir);
  env = setEnvValue(env, "SQLITE_PATH", resolve(dataDir, "sketch.db"));
  writeFileSync(targetEnv, env);
}

function linkSharedDataDir(worktreeDir: string) {
  const sourceDataDir = resolve(MAIN_REPO, "data");
  const targetDataDir = resolve(worktreeDir, "data");

  if (!existsSync(sourceDataDir)) {
    console.log("No data directory found in main repo; skipping shared data symlink.");
    return;
  }

  if (existsSync(targetDataDir)) {
    console.log("Data path already exists in worktree; leaving unchanged.");
    return;
  }

  symlinkSync(sourceDataDir, targetDataDir, "dir");
}

function create(branch: string) {
  const worktreeDir = resolve(MAIN_REPO, "..", `sketch-${branch}`);

  if (existsSync(worktreeDir)) {
    console.error(`Error: ${worktreeDir} already exists`);
    process.exit(1);
  }

  console.log(`Creating worktree at ${worktreeDir} on branch '${branch}'...\n`);
  run(`git worktree add -b ${branch} ${worktreeDir} origin/main`);

  console.log("\nCreating worktree-local .env...");
  createWorktreeEnv(worktreeDir);

  console.log("Symlinking shared data directory...");
  linkSharedDataDir(worktreeDir);

  console.log("Initializing .planning submodule...");
  try {
    run("git submodule update --init .planning", worktreeDir);
  } catch {
    console.log("Skipping .planning (private repo, no access). Worktree will work without it.");
  }

  console.log("\nInstalling dependencies...");
  run("pnpm install", worktreeDir);

  console.log(`\nDone! Worktree ready at ${worktreeDir}`);
  console.log(`  cd ${worktreeDir}`);
}

function remove(branch: string) {
  const worktreeDir = resolve(MAIN_REPO, "..", `sketch-${branch}`);

  if (!existsSync(worktreeDir)) {
    console.error(`Error: ${worktreeDir} does not exist`);
    process.exit(1);
  }

  console.log(`Removing worktree at ${worktreeDir}...\n`);

  console.log("Cleaning up submodule...");
  try {
    run("git submodule deinit --force .planning", worktreeDir);
  } catch {
    // Submodule was never initialized, nothing to clean up
  }

  run(`git worktree remove --force ${worktreeDir}`);
  run(`git branch -d ${branch}`);

  console.log("\nDone!");
}

function list() {
  run("git worktree list");
}

const action = process.argv[2];
const branch = process.argv[3];

if (action === "list") {
  list();
} else if (action === "create" || action === "remove") {
  if (!branch) {
    console.error(`Usage: pnpm worktree:${action} <branch>`);
    process.exit(1);
  }
  action === "create" ? create(branch) : remove(branch);
} else {
  console.error("Usage: pnpm worktree:create <branch> | pnpm worktree:remove <branch> | pnpm worktree:list");
  process.exit(1);
}
