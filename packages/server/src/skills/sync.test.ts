import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config";
import { syncFeaturedSkills } from "./sync";

const CLAUDE_CONFIG_DIR = "/tmp/test-claude";
const SKETCH_CONFIG_DIR = "/tmp/test-sketch";
const SKILLS_CACHE = join(SKETCH_CONFIG_DIR, "skills-repo");
const SKILLS_TARGET = join(CLAUDE_CONFIG_DIR, "skills");

const fakeConfig = {
  CLAUDE_CONFIG_DIR,
  SKETCH_CONFIG_DIR,
} as Config;

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  cpSync: vi.fn(),
}));

const { execSync } = await import("node:child_process");
const { existsSync, mkdirSync, readFileSync, cpSync } = await import("node:fs");

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

const MANIFEST_WITH_SKILLS = JSON.stringify({
  skills: {
    "skill-a": { path: "skills/skill-a" },
    "skill-b": { path: "skills/skill-b" },
  },
});

const MANIFEST_WITH_MANAGED_PATHS = JSON.stringify({
  skills: {
    canvas: {
      path: "skills/canvas",
      sync: {
        managedPaths: ["SKILL.md", "canvas-cli.js"],
      },
    },
  },
});

describe("syncFeaturedSkills", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("clones repo on first run when cache dir does not exist", async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      if (p === SKILLS_CACHE) return false;
      if (String(p).endsWith("manifest.json")) return false;
      return false;
    });

    const logger = makeLogger();
    await syncFeaturedSkills(fakeConfig, logger as never);

    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining("git clone --depth 1"),
      expect.objectContaining({ stdio: "pipe" }),
    );
    expect(execSync).not.toHaveBeenCalledWith("git pull --ff-only", expect.anything());
  });

  it("pulls on subsequent runs when cache dir exists", async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      if (p === SKILLS_CACHE) return true;
      if (String(p).endsWith("manifest.json")) return false;
      return false;
    });

    const logger = makeLogger();
    await syncFeaturedSkills(fakeConfig, logger as never);

    expect(execSync).toHaveBeenCalledWith(
      "git pull --ff-only",
      expect.objectContaining({ cwd: SKILLS_CACHE, stdio: "pipe" }),
    );
    expect(execSync).not.toHaveBeenCalledWith(expect.stringContaining("git clone"), expect.anything());
  });

  it("copies skill dirs based on manifest entries when destinations do not exist", async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s === SKILLS_CACHE) return true;
      if (s.endsWith("manifest.json")) return true;
      // Sources (inside SKILLS_CACHE) exist, destinations (inside SKILLS_TARGET) do not.
      if (s.startsWith(SKILLS_CACHE) && (s.includes("skills/skill-a") || s.includes("skills/skill-b"))) return true;
      return false;
    });
    vi.mocked(readFileSync).mockReturnValue(MANIFEST_WITH_SKILLS);

    const logger = makeLogger();
    await syncFeaturedSkills(fakeConfig, logger as never);

    expect(cpSync).toHaveBeenCalledTimes(2);
    expect(cpSync).toHaveBeenCalledWith(join(SKILLS_CACHE, "skills/skill-a"), join(SKILLS_TARGET, "skill-a"), {
      recursive: true,
    });
    expect(cpSync).toHaveBeenCalledWith(join(SKILLS_CACHE, "skills/skill-b"), join(SKILLS_TARGET, "skill-b"), {
      recursive: true,
    });
  });

  it("skips copy when destination dir already exists (preserves local edits)", async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s === SKILLS_CACHE) return true;
      if (s.endsWith("manifest.json")) return true;
      // Both source and destination exist — destination should be preserved.
      if (s.includes("skills/skill-a") || s.includes("skills/skill-b")) return true;
      return false;
    });
    vi.mocked(readFileSync).mockReturnValue(MANIFEST_WITH_SKILLS);

    const logger = makeLogger();
    await syncFeaturedSkills(fakeConfig, logger as never);

    expect(cpSync).not.toHaveBeenCalled();
  });

  it("copies only skills whose destinations do not exist (partial preservation)", async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s === SKILLS_CACHE) return true;
      if (s.endsWith("manifest.json")) return true;
      // skill-a destination already exists (preserve), skill-b destination does not (copy).
      if (s === join(SKILLS_TARGET, "skill-a")) return true;
      if (s === join(SKILLS_TARGET, "skill-b")) return false;
      // Both sources exist.
      if (s.startsWith(SKILLS_CACHE) && (s.includes("skills/skill-a") || s.includes("skills/skill-b"))) return true;
      return false;
    });
    vi.mocked(readFileSync).mockReturnValue(MANIFEST_WITH_SKILLS);

    const logger = makeLogger();
    await syncFeaturedSkills(fakeConfig, logger as never);

    expect(cpSync).toHaveBeenCalledTimes(1);
    expect(cpSync).toHaveBeenCalledWith(join(SKILLS_CACHE, "skills/skill-b"), join(SKILLS_TARGET, "skill-b"), {
      recursive: true,
    });
  });

  it("logs warn and does not throw when clone fails", async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      if (p === SKILLS_CACHE) return false;
      return false;
    });
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error("git not found");
    });

    const logger = makeLogger();
    await expect(syncFeaturedSkills(fakeConfig, logger as never)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "Failed to sync featured skills, continuing with existing skills",
    );
  });

  it("logs warn and returns early when manifest is missing", async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      if (p === SKILLS_CACHE) return true;
      if (String(p).endsWith("manifest.json")) return false;
      return false;
    });

    const logger = makeLogger();
    await syncFeaturedSkills(fakeConfig, logger as never);

    expect(logger.warn).toHaveBeenCalledWith("No manifest.json found in skills repo, skipping skill copy");
    expect(cpSync).not.toHaveBeenCalled();
  });

  it("creates target directory for skills", async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      if (p === SKILLS_CACHE) return true;
      if (String(p).endsWith("manifest.json")) return true;
      return false;
    });
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ skills: {} }));

    const logger = makeLogger();
    await syncFeaturedSkills(fakeConfig, logger as never);

    expect(mkdirSync).toHaveBeenCalledWith(SKILLS_TARGET, { recursive: true });
  });

  it("copies the full skill directory on first install even when managed paths are configured", async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s === SKILLS_CACHE) return true;
      if (s.endsWith("manifest.json")) return true;
      if (s === join(SKILLS_CACHE, "skills/canvas")) return true;
      return false;
    });
    vi.mocked(readFileSync).mockReturnValue(MANIFEST_WITH_MANAGED_PATHS);

    const logger = makeLogger();
    await syncFeaturedSkills(fakeConfig, logger as never);

    expect(cpSync).toHaveBeenCalledTimes(1);
    expect(cpSync).toHaveBeenCalledWith(join(SKILLS_CACHE, "skills/canvas"), join(SKILLS_TARGET, "canvas"), {
      recursive: true,
    });
  });

  it("updates only managed paths for existing skills", async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s === SKILLS_CACHE) return true;
      if (s.endsWith("manifest.json")) return true;
      if (s === join(SKILLS_TARGET, "canvas")) return true;
      if (s === join(SKILLS_CACHE, "skills/canvas")) return true;
      if (s === join(SKILLS_CACHE, "skills/canvas", "SKILL.md")) return true;
      if (s === join(SKILLS_CACHE, "skills/canvas", "canvas-cli.js")) return true;
      return false;
    });
    vi.mocked(readFileSync).mockReturnValue(MANIFEST_WITH_MANAGED_PATHS);

    const logger = makeLogger();
    await syncFeaturedSkills(fakeConfig, logger as never);

    expect(cpSync).toHaveBeenCalledTimes(2);
    expect(cpSync).toHaveBeenCalledWith(
      join(SKILLS_CACHE, "skills/canvas", "SKILL.md"),
      join(SKILLS_TARGET, "canvas", "SKILL.md"),
      {
        force: true,
        recursive: true,
      },
    );
    expect(cpSync).toHaveBeenCalledWith(
      join(SKILLS_CACHE, "skills/canvas", "canvas-cli.js"),
      join(SKILLS_TARGET, "canvas", "canvas-cli.js"),
      {
        force: true,
        recursive: true,
      },
    );
  });

  it("supports nested managed paths", async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s === SKILLS_CACHE) return true;
      if (s.endsWith("manifest.json")) return true;
      if (s === join(SKILLS_TARGET, "md-to-pdf")) return true;
      if (s === join(SKILLS_CACHE, "skills/md-to-pdf")) return true;
      if (s === join(SKILLS_CACHE, "skills/md-to-pdf", "SKILL.md")) return true;
      if (s === join(SKILLS_CACHE, "skills/md-to-pdf", "assets/default.css")) return true;
      return false;
    });
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        skills: {
          "md-to-pdf": {
            path: "skills/md-to-pdf",
            sync: {
              managedPaths: ["SKILL.md", "assets/default.css"],
            },
          },
        },
      }),
    );

    const logger = makeLogger();
    await syncFeaturedSkills(fakeConfig, logger as never);

    expect(mkdirSync).toHaveBeenCalledWith(join(SKILLS_TARGET, "md-to-pdf", "assets"), { recursive: true });
    expect(cpSync).toHaveBeenCalledWith(
      join(SKILLS_CACHE, "skills/md-to-pdf", "assets/default.css"),
      join(SKILLS_TARGET, "md-to-pdf", "assets/default.css"),
      { force: true, recursive: true },
    );
  });

  it("preserves non-managed files for existing skills", async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s === SKILLS_CACHE) return true;
      if (s.endsWith("manifest.json")) return true;
      if (s === join(SKILLS_TARGET, "identity")) return true;
      if (s === join(SKILLS_CACHE, "skills/identity")) return true;
      if (s === join(SKILLS_CACHE, "skills/identity", "SKILL.md")) return true;
      if (s === join(SKILLS_CACHE, "skills/identity", "SKILL-CONTEXT.md")) return true;
      return false;
    });
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        skills: {
          identity: {
            path: "skills/identity",
            sync: {
              managedPaths: ["SKILL.md"],
            },
          },
        },
      }),
    );

    const logger = makeLogger();
    await syncFeaturedSkills(fakeConfig, logger as never);

    expect(cpSync).toHaveBeenCalledTimes(1);
    expect(cpSync).toHaveBeenCalledWith(
      join(SKILLS_CACHE, "skills/identity", "SKILL.md"),
      join(SKILLS_TARGET, "identity", "SKILL.md"),
      {
        force: true,
        recursive: true,
      },
    );
    expect(cpSync).not.toHaveBeenCalledWith(
      join(SKILLS_CACHE, "skills/identity", "SKILL-CONTEXT.md"),
      expect.anything(),
      expect.anything(),
    );
  });

  it("warns and skips managed sync when SKILL.md is missing from managedPaths", async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s === SKILLS_CACHE) return true;
      if (s.endsWith("manifest.json")) return true;
      if (s === join(SKILLS_TARGET, "canvas")) return true;
      if (s === join(SKILLS_CACHE, "skills/canvas")) return true;
      if (s === join(SKILLS_CACHE, "skills/canvas", "canvas-cli.js")) return true;
      return false;
    });
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        skills: {
          canvas: {
            path: "skills/canvas",
            sync: {
              managedPaths: ["canvas-cli.js"],
            },
          },
        },
      }),
    );

    const logger = makeLogger();
    await syncFeaturedSkills(fakeConfig, logger as never);

    expect(cpSync).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ id: "canvas", managedPaths: ["canvas-cli.js"] }),
      "Managed skill sync requires SKILL.md in managedPaths",
    );
  });

  it("warns and skips invalid managed paths", async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s === SKILLS_CACHE) return true;
      if (s.endsWith("manifest.json")) return true;
      if (s === join(SKILLS_TARGET, "canvas")) return true;
      if (s === join(SKILLS_CACHE, "skills/canvas")) return true;
      if (s === join(SKILLS_CACHE, "skills/canvas", "SKILL.md")) return true;
      return false;
    });
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        skills: {
          canvas: {
            path: "skills/canvas",
            sync: {
              managedPaths: ["SKILL.md", "../secrets.env", "/absolute/path"],
            },
          },
        },
      }),
    );

    const logger = makeLogger();
    await syncFeaturedSkills(fakeConfig, logger as never);

    expect(cpSync).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ id: "canvas", relativePath: "../secrets.env" }),
      "Skipping invalid managed skill sync path",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ id: "canvas", relativePath: "/absolute/path" }),
      "Skipping invalid managed skill sync path",
    );
  });
});
