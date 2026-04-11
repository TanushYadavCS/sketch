/**
 * Syncs featured skills from the sketch-skills GitHub repo into the local Claude skills directory.
 * Clones on first run, pulls on subsequent runs. Non-fatal: logs a warning and continues on any failure.
 */
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config";
import type { Logger } from "../logger";

const SKILLS_REPO = "https://github.com/canvasxai/sketch-skills.git";

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

    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    mkdirSync(skillsTarget, { recursive: true });

    let copied = 0;
    let skipped = 0;
    for (const [id, skill] of Object.entries<{ path: string }>(manifest.skills)) {
      const src = join(skillsCache, skill.path);
      const dest = join(skillsTarget, id);
      if (existsSync(dest)) {
        skipped++;
        continue;
      }
      if (existsSync(src)) {
        cpSync(src, dest, { recursive: true });
        copied++;
      }
    }

    logger.info({ copied, skipped, total: Object.keys(manifest.skills).length }, "Synced featured skills");
  } catch (err) {
    logger.warn({ err }, "Failed to sync featured skills, continuing with existing skills");
  }
}
