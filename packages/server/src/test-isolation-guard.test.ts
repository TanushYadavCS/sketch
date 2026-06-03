import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards the `isolate: false` invariant of the `unit` test project.
 *
 * The unit project runs without isolation for speed: within a worker the module
 * graph and the global environment are shared across files. So anything a file
 * mutates at that shared level outlives the file and bleeds into the next one,
 * flaking nondeterministically (and usually in an innocent sibling file, which
 * makes it brutal to trace). Three constructs do exactly this:
 *
 * - `vi.mock()` replaces a module in the shared module cache.
 * - `vi.useFakeTimers()` swaps the global timers/Date; an afterEach restore is
 *   not enough, since a missed or failed restore poisons every later file.
 * - `setupServer()` installs a global MSW interceptor; the web suite already has
 *   one shared server, so a second one races it. Use `server.use()` instead.
 *
 * Any unit test file using one of these MUST be named `*.isolated.test.{ts,tsx}`
 * so it runs in the isolated project. This test fails the build otherwise, so the
 * suite can't silently regress into flakiness. (Plain `vi.fn()`/`vi.spyOn()` and
 * shared `server.use()` are local and safe, so they are not flagged.)
 *
 * Scope: `*.test.ts(x)` files in the unit project (excludes `*.isolated.test.*`
 * and `*.integration.test.*`, both of which run with isolation).
 */

const SRC_ROOT = import.meta.dirname;
/** This guard file naturally contains the patterns it scans for; skip itself. */
const SELF = "test-isolation-guard.test.ts";
const SHARED_STATE_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "vi.mock()", re: /\bvi\s*\.\s*mock\s*\(/ },
  { label: "vi.useFakeTimers()", re: /\bvi\s*\.\s*useFakeTimers\s*\(/ },
  { label: "setupServer()", re: /\bsetupServer\s*\(/ },
];

function unitTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      out.push(...unitTestFiles(full));
    } else if (
      (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) &&
      entry.name !== SELF &&
      !entry.name.endsWith(".isolated.test.ts") &&
      !entry.name.endsWith(".isolated.test.tsx") &&
      !entry.name.endsWith(".integration.test.ts") &&
      !entry.name.endsWith(".integration.test.tsx")
    ) {
      out.push(full);
    }
  }
  return out;
}

describe("test isolation guard", () => {
  it("no isolate:false unit file mutates shared worker state (rename it to *.isolated.test.{ts,tsx})", () => {
    const offenders = unitTestFiles(SRC_ROOT)
      .map((file) => {
        const src = readFileSync(file, "utf8");
        const hits = SHARED_STATE_PATTERNS.filter((p) => p.re.test(src)).map((p) => p.label);
        return { file: file.slice(SRC_ROOT.length + 1), hits };
      })
      .filter((o) => o.hits.length > 0);

    const message = offenders.length
      ? `These files mutate worker-global state but run in the non-isolated 'unit' project, where the module graph and globals are shared across files, so the mutation leaks and flakes. Rename each to *.isolated.test.{ts,tsx}:\n  ${offenders
          .map((o) => `${o.file} (${o.hits.join(", ")})`)
          .join("\n  ")}`
      : "";
    expect(offenders, message).toEqual([]);
  });
});
