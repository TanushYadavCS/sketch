/**
 * Syncs featured skills from the sketch-skills GitHub repo into the local Claude skills directory.
 * Clones on first run, pulls on subsequent runs. Non-fatal: logs a warning and continues on any failure.
 */
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Config } from "../config";
import type { Logger } from "../logger";

const SKILLS_REPO = "https://github.com/canvasxai/sketch-skills.git";
const SKILL_FILE_NAME = "SKILL.md";

interface FeaturedSkillManifestEntry {
  path: string;
  sync?: {
    managedPaths?: string[];
  };
}

interface FeaturedSkillsManifest {
  skills: Record<string, FeaturedSkillManifestEntry>;
}

function isSafeSkillId(value: string): boolean {
  return (
    /^[a-z0-9][a-z0-9-_]{0,63}$/i.test(value) && !value.includes("..") && !value.includes("/") && !value.includes("\\")
  );
}

function resolveManagedPath(root: string, subpath: string): string | null {
  const trimmed = subpath.trim();
  if (!trimmed || isAbsolute(trimmed)) return null;

  const resolved = resolve(root, trimmed);
  const rel = relative(root, resolved);
  if (rel === "" || rel === "." || rel.startsWith("..") || rel.split("/").includes("..")) return null;

  return resolved;
}

export async function syncFeaturedSkills(config: Config, logger: Logger): Promise<void> {
  const skillsCache = join(config.SKETCH_CONFIG_DIR, "skills-repo");
  const skillsTarget = join(config.CLAUDE_CONFIG_DIR, "skills");

  try {
    if (existsSync(skillsCache)) {
      execSync("git pull --ff-only", { cwd: skillsCache, stdio: "pipe" });
      logger.info("Updated featured skills from remote");
    } else {
      mkdirSync(config.SKETCH_CONFIG_DIR, { recursive: true });
      execSync(`git clone --depth 1 ${SKILLS_REPO} ${skillsCache}`, { stdio: "pipe" });
      logger.info("Cloned featured skills repo");
    }

    const manifestPath = join(skillsCache, "manifest.json");
    if (!existsSync(manifestPath)) {
      logger.warn("No manifest.json found in skills repo, skipping skill copy");
      return;
    }

    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as FeaturedSkillsManifest;
    mkdirSync(skillsTarget, { recursive: true });

    let copied = 0;
    let skipped = 0;
    let updated = 0;
    for (const [id, skill] of Object.entries(manifest.skills)) {
      if (!isSafeSkillId(id) || typeof skill.path !== "string") {
        logger.warn({ id }, "Skipping invalid featured skill manifest entry");
        continue;
      }
      const src = resolveManagedPath(skillsCache, skill.path);
      const dest = resolveManagedPath(skillsTarget, id);
      if (!src || !dest) {
        logger.warn({ id }, "Skipping featured skill path outside the managed roots");
        continue;
      }
      if (!existsSync(src)) {
        logger.warn({ id, src }, "Featured skill path missing in source repo, skipping");
        continue;
      }

      if (!existsSync(dest)) {
        cpSync(src, dest, { recursive: true });
        copied++;
        continue;
      }

      const managedPaths = skill.sync?.managedPaths ?? [];
      if (managedPaths.length === 0) {
        skipped++;
        continue;
      }

      if (!managedPaths.includes(SKILL_FILE_NAME)) {
        logger.warn({ id, managedPaths }, "Managed skill sync requires SKILL.md in managedPaths");
        skipped++;
        continue;
      }

      for (const relativePath of managedPaths) {
        const managedSrc = resolveManagedPath(src, relativePath);
        const managedDest = resolveManagedPath(dest, relativePath);
        if (!managedSrc || !managedDest) {
          logger.warn({ id, relativePath }, "Skipping invalid managed skill sync path");
          continue;
        }
        if (!existsSync(managedSrc)) {
          logger.warn({ id, relativePath }, "Managed skill sync path missing in source repo");
          continue;
        }

        mkdirSync(dirname(managedDest), { recursive: true });
        cpSync(managedSrc, managedDest, { force: true, recursive: true });
        updated++;
      }
    }

    logger.info({ copied, skipped, total: Object.keys(manifest.skills).length, updated }, "Synced featured skills");
  } catch (err) {
    logger.warn({ err }, "Failed to sync featured skills, continuing with existing skills");
  }
}
