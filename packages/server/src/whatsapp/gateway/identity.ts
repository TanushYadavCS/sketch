import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname, uptime } from "node:os";
import { join } from "node:path";

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
  return (
    (await readTrimmed("/proc/sys/kernel/random/boot_id")) ??
    `${hostname()}:${Math.floor(Date.now() / 1000 - uptime())}`
  );
}

export async function loadPidStartTime(): Promise<string> {
  const stat = await readTrimmed(`/proc/${process.pid}/stat`);
  const fields = stat?.split(" ");
  return fields?.[21] ?? String(Math.floor(Date.now() - process.uptime() * 1000));
}
