import os from "node:os";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

const cpus = os.availableParallelism?.() ?? os.cpus().length;

/**
 * Worker count auto-scales to the host (override with VITEST_MAX_WORKERS), using
 * cores-1 to leave one core for the main thread / OS. Mirrors the server config.
 */
const maxWorkers = process.env.VITEST_MAX_WORKERS
  ? Math.max(1, Number(process.env.VITEST_MAX_WORKERS))
  : Math.max(1, cpus - 1);

const alias = {
  "@": resolve(import.meta.dirname, "src"),
  "@sketch/shared": resolve(import.meta.dirname, "../shared/src/index.ts"),
  "@sketch/ui/components": resolve(import.meta.dirname, "../ui/src/components/ui"),
  "@sketch/ui/hooks": resolve(import.meta.dirname, "../ui/src/hooks"),
  "@sketch/ui/lib": resolve(import.meta.dirname, "../ui/src/lib"),
  "@sketch/ui": resolve(import.meta.dirname, "../ui/src"),
  "@ui/components/ui": resolve(import.meta.dirname, "../ui/src/components/ui"),
  "@ui/hooks": resolve(import.meta.dirname, "../ui/src/hooks"),
  "@ui/lib": resolve(import.meta.dirname, "../ui/src/lib"),
  "@ui": resolve(import.meta.dirname, "../ui/src"),
};

/**
 * Three test tiers, mirroring the server (see "Testing" in CLAUDE.md / AGENTS.md).
 *
 * - `unit` — the fast inner-loop tier, run with `isolate: false`. The module graph
 *   is built once per worker and reused across files instead of being torn down and
 *   re-evaluated per file; that per-file re-evaluation is the dominant suite cost, so
 *   dropping it roughly halves wall time and CPU. Safe ONLY because every file that
 *   mocks a module (`vi.mock`) is quarantined into `unit-isolated` below — a shared
 *   module cache makes `vi.mock` leak across files and flake nondeterministically.
 *   `test-isolation-guard` fails the build if a `vi.mock` file lands here by mistake.
 *   (Plain `vi.fn()` callback props are local and safe; only `vi.mock` leaks.)
 * - `unit-isolated` — files that use `vi.mock`, run with `isolate: true` so each gets
 *   a fresh module registry. Selected by the `*.isolated.test.{ts,tsx}` suffix.
 * - `integration` — any future web test that crosses a real external boundary
 *   (a real backend, a browser engine, etc.). Selected by `*.integration.test.{ts,tsx}`.
 *
 * `plugins` and `resolve` are declared per-project, not at the root: Vitest 4 does
 * NOT propagate root-level Vite config into inline `projects`, so the React JSX
 * transform and path aliases would be missing from project runs otherwise.
 */
const shared = {
  environment: "happy-dom" as const,
  setupFiles: ["./src/test/setup.ts"],
  globals: true,
} as const;

const viteConfig = { plugins: [react()], resolve: { alias } } as const;

export default defineConfig({
  test: {
    maxWorkers,
    minWorkers: 1,
    projects: [
      {
        ...viteConfig,
        test: {
          ...shared,
          name: "unit",
          isolate: false,
          include: ["src/**/*.test.{ts,tsx}"],
          exclude: [...configDefaults.exclude, "src/**/*.integration.test.{ts,tsx}", "src/**/*.isolated.test.{ts,tsx}"],
        },
      },
      {
        ...viteConfig,
        test: {
          ...shared,
          name: "unit-isolated",
          isolate: true,
          include: ["src/**/*.isolated.test.{ts,tsx}"],
        },
      },
      {
        ...viteConfig,
        test: {
          ...shared,
          name: "integration",
          isolate: true,
          include: ["src/**/*.integration.test.{ts,tsx}"],
        },
      },
    ],
  },
});
