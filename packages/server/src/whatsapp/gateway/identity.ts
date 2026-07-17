import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname, uptime } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function readTrimmed(path: string): Promise<string | null> {
  try {
    return (await readFile(path, "utf8")).trim() || null;
  } catch {
    return null;
  }
}

export async function loadHostId(dataDir: string): Promise<string> {
  const path = join(dataDir, "host-id");
  const existing = await readTrimmed(path);
  if (existing) return existing;
  await mkdir(dataDir, { recursive: true });
  const generated = randomUUID();
  try {
    await writeFile(path, `${generated}\n`, { flag: "wx", mode: 0o600 });
    return generated;
  } catch {
    return (await readTrimmed(path)) ?? generated;
  }
}

export async function loadBootId(): Promise<string> {
  const kernelBootId = await readTrimmed("/proc/sys/kernel/random/boot_id");
  if (kernelBootId) return kernelBootId;
  try {
    return `${hostname()}:${Math.floor(Date.now() / 1000 - uptime())}`;
  } catch {
    return `${hostname()}:boot-unknown`;
  }
}

export async function loadPidStartTime(pid = process.pid): Promise<string> {
  const stat = await readTrimmed(`/proc/${pid}/stat`);
  const fields = stat?.split(" ");
  if (fields?.[21]) return fields[21];
  try {
    const result = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)]);
    const startedAt = result.stdout.trim();
    if (startedAt) return startedAt;
  } catch {}
  return pid === process.pid ? String(Math.floor(Date.now() - process.uptime() * 1000)) : "";
}
