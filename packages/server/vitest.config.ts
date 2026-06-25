import os from "node:os";
import { configDefaults, defineConfig } from "vitest/config";

const cpus = os.availableParallelism?.() ?? os.cpus().length;

/**
 * Worker count auto-scales to the host (override with VITEST_MAX_WORKERS).
 * cores-1 leaves one core for the main thread / OS. CI pins it to the runner's
 * vCPU count. When running many agents/worktrees concurrently, set
 * VITEST_MAX_WORKERS low (e.g. 2) per agent so the machine isn't oversubscribed —
 * total threads across agents should stay near the core count.
 */
const maxWorkers = process.env.VITEST_MAX_WORKERS
  ? Math.max(1, Number(process.env.VITEST_MAX_WORKERS))
  : Math.max(1, cpus - 1);

/**
 * Three projects (see "Testing" in CLAUDE.md / AGENTS.md):
 *
 * - `unit` — the fast inner-loop tier, run with `isolate: false`. The module
 *   graph is built once per worker and reused across files instead of being torn
 *   down and re-evaluated per file. That re-evaluation was the entire cost of the
 *   suite (module *evaluation*, not transform), so dropping it roughly halves both
 *   wall time and CPU. Safe ONLY because every file that mocks a module (`vi.mock`)
 *   is quarantined into `unit-isolated` below — a shared module cache makes
 *   `vi.mock` leak across files and flake nondeterministically. `test-isolation-guard`
 *   fails the build if a `vi.mock` file lands here by mistake.
 * - `unit-isolated` — files that use `vi.mock`, run with `isolate: true` so each
 *   gets a fresh module registry. Selected by the `*.isolated.test.ts` suffix.
 * - `integration` — heavyweight tests that boot a real runtime substrate or cross a
 *   real external boundary (Postgres via PGlite ~1.3 GB WASM heap, real subprocess
 *   spawns, real sockets). Selected by `*.integration.test.ts`.
 *
 * Pool is "threads": for this suite (many small files) thread workers spawn far
 * cheaper than forked processes.
 */
const shared = {
  environment: "node" as const,
  globalSetup: ["src/test-global-setup.ts"],
  setupFiles: ["src/test-setup.ts"],
  env: {
    DATA_DIR: "/tmp/sketch-test-data",
  },
} as const;

export default defineConfig({
  test: {
    pool: "threads",
    maxWorkers,
    projects: [
      {
        test: {
          ...shared,
          name: "unit",
          isolate: false,
          include: ["src/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "src/**/*.integration.test.ts", "src/**/*.isolated.test.ts"],
        },
      },
      {
        test: {
          ...shared,
          name: "unit-isolated",
          isolate: true,
          include: ["src/**/*.isolated.test.ts"],
        },
      },
      {
        test: {
          ...shared,
          name: "integration",
          /**
           * Adds the PGlite-template reset on top of the shared SQLite-template
           * globalSetup. Integration-only, so the fast unit inner loop never runs
           * it (and never builds or caches a PGlite template).
           */
          globalSetup: [...shared.globalSetup, "src/test-global-setup-pg.ts"],
          isolate: true,
          /**
           * Pinned to one worker so only a single PGlite (~1.3 GB WASM heap) is
           * live at a time. Each worker thread is its own realm with its own heap,
           * so inheriting the global cores-1 cap booted up to ~7 PGlite at once
           * (~9 GB) and OOM'd memory-constrained boxes. With isolate:true and the
           * default sequence.groupOrder, maxWorkers:1 routes this project into its
           * own serial group that runs alone, leaving the unit tiers' parallelism
           * untouched. Raising this above 1 requires a distinct sequence.groupOrder
           * or Vitest 4 throws (different maxWorkers within the same group).
           */
          maxWorkers: 1,
          include: ["src/**/*.integration.test.ts"],
          /**
           * PGlite (in-process WASM Postgres) pays a slow cold-boot. Even serial,
           * the default 10s hook / 5s test timeouts are too tight for boot +
           * migrations; give the heavyweight substrate generous headroom.
           */
          hookTimeout: 30_000,
          testTimeout: 30_000,
        },
      },
    ],
  },
});
