import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Kysely } from "kysely";
import type { Config } from "../../config";
import { createWhatsAppSessionLeaseRepository } from "../../db/repositories/whatsapp-session-lease";
import type { DB, WhatsAppSessionLeaseTable } from "../../db/schema";
import type { Logger } from "../../logger";
import { WHATSAPP_FACADE_CONTRACT_VERSION, type WhatsAppFacadeHealth } from "../facade-contract";
import { GatewayClientFacade } from "../gateway-client-facade";
import { WHATSAPP_GATEWAY_DEFAULT_PORT, WHATSAPP_GATEWAY_HOST } from "./http-server";
import { loadBootId, loadHostId, loadPidStartTime } from "./identity";

export const WHATSAPP_GATEWAY_READINESS_TIMEOUT_MS = 30_000;
export const WHATSAPP_GATEWAY_HEALTH_INTERVAL_MS = 30_000;
export const WHATSAPP_GATEWAY_SHUTDOWN_GRACE_MS = 10_000;
export const WHATSAPP_GATEWAY_KILL_GRACE_MS = 5_000;
export const WHATSAPP_GATEWAY_LOGGED_OUT_EXIT_CODE = 64;

type LeaseRow = import("kysely").Selectable<WhatsAppSessionLeaseTable>;

export function whatsappGatewayRestartBackoffMs(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt - 1));
}

export function whatsappGatewayShouldRespawn(exitCode: number | null): boolean {
  return exitCode !== WHATSAPP_GATEWAY_LOGGED_OUT_EXIT_CODE;
}

export function whatsappGatewayExitDecision(exitCode: number | null, attempt: number) {
  return whatsappGatewayShouldRespawn(exitCode)
    ? ({ action: "respawn", delayMs: whatsappGatewayRestartBackoffMs(attempt) } as const)
    : ({ action: "re-pair" } as const);
}

export function whatsappGatewayHealthMatches(
  health: { scriptHash: string; contractVersion: string },
  expectedHash: string,
): boolean {
  return health.scriptHash === expectedHash && health.contractVersion === WHATSAPP_FACADE_CONTRACT_VERSION;
}

export function whatsappGatewayHealthDecision(
  health: { scriptHash: string; contractVersion: string },
  expectedHash: string,
) {
  return whatsappGatewayHealthMatches(health, expectedHash) ? "healthy" : "restart";
}

export function classifyWhatsAppGatewayLease(params: {
  lease: LeaseRow | null | undefined;
  hostId: string;
  bootId: string;
  health?: { scriptHash: string; contractVersion: string } | null;
  expectedHash: string;
  heartbeatFresh: boolean;
}): "spawn" | "wait" | "adopt" | "replace" {
  const { lease } = params;
  if (!lease || !params.heartbeatFresh) return "spawn";
  if (lease.owner_kind !== "gateway") return "wait";
  if (lease.host_id !== params.hostId || lease.boot_id !== params.bootId) return "wait";
  if (!lease.gateway_http_token || !params.health) return "replace";
  if (lease.script_hash !== params.expectedHash || lease.contract_version !== WHATSAPP_FACADE_CONTRACT_VERSION) {
    return "replace";
  }
  return whatsappGatewayHealthDecision(params.health, params.expectedHash) === "healthy" ? "adopt" : "replace";
}

export interface WhatsAppGatewaySupervisorOptions {
  db: Kysely<DB>;
  config: Config;
  logger: Logger;
  gatewayScriptPath?: string;
  spawn?: typeof spawn;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  nodeArgs?: string[];
  stdio?: SpawnOptions["stdio"];
  onOwnershipLost?: () => Promise<void> | void;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function gatewayBaseUrl(port: number): string {
  return `http://${WHATSAPP_GATEWAY_HOST}:${port}`;
}

async function fileHash(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function defaultGatewayScriptPath(): string {
  const current = fileURLToPath(import.meta.url);
  return basename(dirname(current)) === "dist" && current.endsWith(".js")
    ? join(dirname(current), "wa-gateway.js")
    : join(dirname(current), "../../../dist/wa-gateway.js");
}

export class WhatsAppGatewaySupervisor {
  private readonly leases;
  private readonly spawnImpl: typeof spawn;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private child: ChildProcess | null = null;
  private client: GatewayClientFacade | null = null;
  private lease: LeaseRow | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private restarting = false;
  private stopping = false;
  private healthFailures = 0;
  private restartAttempt = 0;
  private loggedOut = false;
  private startedSuccessfully = false;
  private respawnScheduled = false;
  private lastHealth: WhatsAppFacadeHealth | null = null;
  private pairingSpawn: Promise<GatewayClientFacade> | null = null;
  private readonly expectedExits = new WeakSet<ChildProcess>();

  constructor(private readonly options: WhatsAppGatewaySupervisorOptions) {
    this.leases = createWhatsAppSessionLeaseRepository(options.db, {
      ...(options.config.DB_TYPE === "sqlite" ? { sqlitePath: options.config.SQLITE_PATH } : {}),
    });
    this.spawnImpl = options.spawn ?? spawn;
    this.sleep = options.sleep ?? delay;
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<GatewayClientFacade | null> {
    this.stopping = false;
    const scriptPath = this.options.gatewayScriptPath ?? defaultGatewayScriptPath();
    const expectedHash = await fileHash(scriptPath);
    const hostId = await loadHostId(this.options.config.DATA_DIR);
    const bootId = await loadBootId();

    const adopted = await this.tryAdopt(expectedHash, hostId, bootId);
    if (adopted) {
      this.startedSuccessfully = true;
      this.startHealthPolling(scriptPath);
      return adopted;
    }

    const observedLease = await this.leases.get();
    if (!(await this.leases.getFresh()) && observedLease?.owner_kind === "gateway") {
      await this.stopLeaseOwner(
        observedLease,
        observedLease.gateway_http_token ? this.createClient(observedLease.gateway_http_token) : null,
      );
    }

    await this.waitForTakeoverEligibility(hostId, bootId);
    let client: GatewayClientFacade;
    try {
      client = await this.spawnAndWait(scriptPath, expectedHash);
    } catch (error) {
      if (!this.loggedOut) throw error;
      this.options.logger.info("WhatsApp gateway requires pairing; continuing server startup without a live gateway");
      return null;
    }
    this.startedSuccessfully = true;
    this.startHealthPolling(scriptPath);
    return client;
  }

  get facade(): GatewayClientFacade | null {
    return this.client;
  }

  get requiresPairing(): boolean {
    return this.loggedOut;
  }

  get isConnected(): boolean {
    return !this.stopping && !this.loggedOut && this.client !== null && this.lastHealth?.socketState === "connected";
  }

  /**
   * Concurrent pairing requests share one in-flight spawn: the pre-spawn checks
   * (`this.child`) sit after an await on `fileHash`, so without the memo two
   * simultaneous callers could both pass them and double-spawn the gateway.
   */
  async ensurePairingReady(): Promise<GatewayClientFacade> {
    if (!this.loggedOut && this.client) return this.client;
    if (this.pairingSpawn) return this.pairingSpawn;
    if (this.child) throw new Error("WhatsApp gateway is still starting");
    this.pairingSpawn = this.spawnForPairing();
    try {
      return await this.pairingSpawn;
    } finally {
      this.pairingSpawn = null;
    }
  }

  private async spawnForPairing(): Promise<GatewayClientFacade> {
    this.loggedOut = false;
    this.stopping = false;
    const scriptPath = this.options.gatewayScriptPath ?? defaultGatewayScriptPath();
    const expectedHash = await fileHash(scriptPath);
    const client = await this.spawnAndWait(scriptPath, expectedHash);
    this.startedSuccessfully = true;
    this.restartAttempt = 0;
    this.startHealthPolling(scriptPath);
    return client;
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    this.stopHealthPolling();
    await this.stopGateway();
  }

  async stopExistingGateway(): Promise<void> {
    const lease = await this.leases.get();
    if (lease?.owner_kind !== "gateway") return;
    await this.stopLeaseOwner(lease, lease.gateway_http_token ? this.createClient(lease.gateway_http_token) : null);
  }

  private async tryAdopt(expectedHash: string, hostId: string, bootId: string): Promise<GatewayClientFacade | null> {
    const lease = await this.leases.getFresh();
    if (!lease || lease.owner_kind !== "gateway" || !lease.gateway_http_token) return null;
    if (lease.host_id !== hostId || lease.boot_id !== bootId) return null;

    const candidate = this.createClient(lease.gateway_http_token);
    try {
      const health = await candidate.health();
      if (
        lease.script_hash === expectedHash &&
        lease.contract_version === WHATSAPP_FACADE_CONTRACT_VERSION &&
        whatsappGatewayHealthDecision(health, expectedHash) === "healthy"
      ) {
        this.lease = lease;
        this.client = candidate;
        this.lastHealth = health;
        this.options.logger.info({ pid: lease.pid }, "Adopted healthy WhatsApp gateway process");
        return candidate;
      }
    } catch (error) {
      this.options.logger.warn({ error, pid: lease.pid }, "Existing WhatsApp gateway was not healthy for adoption");
    }

    await this.stopLeaseOwner(lease, candidate);
    return null;
  }

  private async waitForTakeoverEligibility(hostId: string, bootId: string): Promise<void> {
    for (;;) {
      const lease = await this.leases.getFresh();
      if (!lease) return;
      if (lease.owner_kind === "gateway" && lease.host_id === hostId && lease.boot_id === bootId) {
        await this.stopLeaseOwner(lease, lease.gateway_http_token ? this.createClient(lease.gateway_http_token) : null);
      } else {
        await this.sleep(1_000);
      }
    }
  }

  private async spawnAndWait(scriptPath: string, expectedHash: string): Promise<GatewayClientFacade> {
    this.loggedOut = false;
    const port = this.options.config.WHATSAPP_GATEWAY_PORT ?? WHATSAPP_GATEWAY_DEFAULT_PORT;
    const existingLease = await this.leases.get();
    const gatewayHttpToken = existingLease?.gateway_http_token ?? randomBytes(32).toString("hex");
    const child = this.spawnImpl(process.execPath, [...(this.options.nodeArgs ?? []), scriptPath], {
      env: {
        ...process.env,
        ...this.options.env,
        WHATSAPP_GATEWAY_PORT: String(port),
        WHATSAPP_GATEWAY_HTTP_TOKEN: gatewayHttpToken,
      },
      stdio: this.options.stdio ?? "inherit",
    });
    this.child = child;
    child.once("exit", (code, signal) => void this.onChildExit(child, code, signal));
    const deadline = this.now() + WHATSAPP_GATEWAY_READINESS_TIMEOUT_MS;
    for (;;) {
      if (this.loggedOut) throw new Error("WhatsApp gateway logged out; pairing is required");
      if (!this.child) throw new Error("WhatsApp gateway exited before becoming ready");
      if (this.now() >= deadline) {
        await this.stopGateway();
        throw new Error("WhatsApp gateway did not become ready within 30 seconds");
      }
      const lease = await this.leases.getFresh();
      if (lease?.owner_kind === "gateway" && lease.gateway_http_token) {
        const client = this.createClient(lease.gateway_http_token);
        try {
          const health = await client.health();
          if (
            lease.script_hash !== expectedHash ||
            lease.contract_version !== WHATSAPP_FACADE_CONTRACT_VERSION ||
            whatsappGatewayHealthDecision(health, expectedHash) === "restart"
          ) {
            await this.stopLeaseOwner(lease, client);
            throw new Error("WhatsApp gateway contract or script hash did not match the app");
          }
          this.lease = lease;
          this.client = client;
          this.lastHealth = health;
          return client;
        } catch (error) {
          this.options.logger.debug({ error }, "Waiting for WhatsApp gateway readiness");
        }
      }
      await this.sleep(250);
    }
  }

  private startHealthPolling(scriptPath: string): void {
    this.stopHealthPolling();
    this.healthTimer = setInterval(() => void this.pollHealth(scriptPath), WHATSAPP_GATEWAY_HEALTH_INTERVAL_MS);
    this.healthTimer.unref?.();
  }

  private stopHealthPolling(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  private async pollHealth(scriptPath: string): Promise<void> {
    if (this.stopping || this.restarting || !this.client) return;
    try {
      const expectedHash = await fileHash(scriptPath);
      const health = await this.client.health();
      if (whatsappGatewayHealthDecision(health, expectedHash) === "restart") {
        await this.restart("gateway contract skew");
        return;
      }
      this.lastHealth = health;
      this.healthFailures = 0;
      this.restartAttempt = 0;
    } catch (error) {
      this.healthFailures += 1;
      this.options.logger.warn({ error, failures: this.healthFailures }, "WhatsApp gateway health check failed");
      if (this.healthFailures >= 3) await this.restart("three consecutive health failures");
    }
  }

  private async restart(reason: string): Promise<void> {
    if (this.restarting || this.stopping || this.loggedOut) return;
    this.restarting = true;
    this.options.logger.warn({ reason }, "Restarting WhatsApp gateway");
    try {
      await this.stopGateway();
      const scriptPath = this.options.gatewayScriptPath ?? defaultGatewayScriptPath();
      const expectedHash = await fileHash(scriptPath);
      const client = await this.spawnAndWait(scriptPath, expectedHash);
      if (!this.child || this.client !== client)
        throw new Error("WhatsApp gateway exited while restart readiness completed");
      this.healthFailures = 0;
      this.restartAttempt = 0;
    } catch (error) {
      this.scheduleRespawn("failed gateway restart");
      throw error;
    } finally {
      this.restarting = false;
    }
  }

  private async onChildExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (this.child !== child) return;
    const expectedExit = this.expectedExits.delete(child);
    const exitedLease = this.lease;
    const wasReady = this.client !== null && exitedLease !== null;
    if (exitedLease && child.pid === exitedLease.pid) {
      await this.leases
        .release({ ownerToken: exitedLease.owner_token, generation: exitedLease.generation })
        .catch((error) => this.options.logger.warn({ error }, "Failed to release the exited gateway lease"));
    }
    this.child = null;
    this.client = null;
    this.lease = null;
    this.lastHealth = null;
    if (expectedExit || this.stopping) return;
    const decision = whatsappGatewayExitDecision(code, this.restartAttempt + 1);
    if (decision.action === "re-pair") {
      this.loggedOut = true;
      this.stopHealthPolling();
      this.options.logger.warn("WhatsApp gateway logged out; automatic respawn stopped until re-pairing");
      return;
    }
    if (!wasReady && !this.startedSuccessfully) return;
    this.scheduleRespawn("unexpected gateway exit", { code, signal });
  }

  private scheduleRespawn(reason: string, context: Record<string, unknown> = {}): void {
    if (this.respawnScheduled || this.stopping || this.loggedOut) return;
    this.restartAttempt += 1;
    const backoffMs = whatsappGatewayRestartBackoffMs(this.restartAttempt);
    this.respawnScheduled = true;
    this.options.logger.warn(
      { ...context, backoffMs, attempt: this.restartAttempt },
      "WhatsApp gateway respawn scheduled",
    );
    void this.runScheduledRespawn(reason, backoffMs);
  }

  private async runScheduledRespawn(reason: string, backoffMs: number): Promise<void> {
    try {
      await this.sleep(backoffMs);
    } catch (error) {
      this.respawnScheduled = false;
      this.options.logger.error({ error }, "WhatsApp gateway respawn backoff failed");
      this.scheduleRespawn("failed gateway respawn backoff");
      return;
    }
    this.respawnScheduled = false;
    if (this.stopping || this.loggedOut) return;
    try {
      await this.restart(reason);
    } catch (error) {
      if (!this.stopping && !this.loggedOut) {
        this.options.logger.error({ error }, "WhatsApp gateway respawn failed");
      }
    }
  }

  private async stopGateway(): Promise<void> {
    if (this.child) this.expectedExits.add(this.child);
    const lease = this.lease ?? (await this.leases.getFresh()) ?? null;
    const client = this.client ?? (lease?.gateway_http_token ? this.createClient(lease.gateway_http_token) : null);
    await this.stopLeaseOwner(lease, client);
    if (!lease && this.child) await this.stopUnleasedChild(this.child);
    this.client = null;
    this.lease = null;
    this.child = null;
  }

  private async stopUnleasedChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      this.sleep(WHATSAPP_GATEWAY_KILL_GRACE_MS),
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }

  private async stopLeaseOwner(lease: LeaseRow | null, client: GatewayClientFacade | null): Promise<void> {
    if (!lease) return;
    const shutdownRequest = client
      ? client.shutdown(WHATSAPP_GATEWAY_SHUTDOWN_GRACE_MS).catch((error) => {
          this.options.logger.warn({ error, pid: lease.pid }, "WhatsApp gateway graceful shutdown request failed");
        })
      : Promise.resolve();
    const [stopped] = await Promise.all([
      this.waitUntilStopped(lease, WHATSAPP_GATEWAY_SHUTDOWN_GRACE_MS),
      shutdownRequest,
    ]);
    if (stopped) return;
    if (!(await this.signalLeaseOwner(lease, "SIGTERM"))) return;
    if (await this.waitUntilStopped(lease, WHATSAPP_GATEWAY_KILL_GRACE_MS)) return;
    await this.signalLeaseOwner(lease, "SIGKILL");
    await this.waitUntilStopped(lease, WHATSAPP_GATEWAY_KILL_GRACE_MS);
  }

  private async waitUntilStopped(lease: LeaseRow, timeoutMs: number): Promise<boolean> {
    const localProcessMatch = await this.localProcessMatches(lease);
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      const current = await this.leases.getFresh();
      if (current && current.owner_token !== lease.owner_token) return true;
      if (localProcessMatch === false) return true;
      if (localProcessMatch === null && !current) return true;
      if (localProcessMatch && (await loadPidStartTime(lease.pid)) !== lease.pid_start_time) return true;
      await this.sleep(100);
    }
    return false;
  }

  private async localProcessMatches(lease: LeaseRow): Promise<boolean | null> {
    const [hostId, bootId] = await Promise.all([loadHostId(this.options.config.DATA_DIR), loadBootId()]);
    if (lease.host_id !== hostId || lease.boot_id !== bootId) return null;
    const pidStartTime = await loadPidStartTime(lease.pid);
    return Boolean(pidStartTime && pidStartTime === lease.pid_start_time);
  }

  private async signalLeaseOwner(lease: LeaseRow, signal: NodeJS.Signals): Promise<boolean> {
    const [hostId, bootId, pidStartTime] = await Promise.all([
      loadHostId(this.options.config.DATA_DIR),
      loadBootId(),
      loadPidStartTime(lease.pid),
    ]);
    if (lease.host_id !== hostId || lease.boot_id !== bootId || lease.pid_start_time !== pidStartTime) return false;
    try {
      process.kill(lease.pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  private createClient(token: string): GatewayClientFacade {
    return new GatewayClientFacade({
      baseUrl: gatewayBaseUrl(this.options.config.WHATSAPP_GATEWAY_PORT ?? WHATSAPP_GATEWAY_DEFAULT_PORT),
      token,
      logger: this.options.logger,
      beforePairingStart: () => this.ensurePairingReady().then(() => undefined),
    });
  }
}

export class InProcessWhatsAppLease {
  private readonly leases;
  private readonly ownerToken = randomUUID();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private fence: { ownerToken: string; generation: number } | null = null;
  private heartbeatFailures = 0;
  private lastHeartbeatSuccess = performance.now();

  constructor(private readonly options: Omit<WhatsAppGatewaySupervisorOptions, "gatewayScriptPath" | "spawn">) {
    this.leases = createWhatsAppSessionLeaseRepository(options.db, {
      ...(options.config.DB_TYPE === "sqlite" ? { sqlitePath: options.config.SQLITE_PATH } : {}),
    });
  }

  async acquire(): Promise<void> {
    if (this.fence && (await this.leases.isOwned(this.fence))) return;
    const supervisor = new WhatsAppGatewaySupervisor(this.options);
    const fresh = await this.leases.getFresh();
    if (fresh?.owner_kind === "gateway") {
      await supervisor.stopExistingGateway();
    }
    while (await this.leases.getFresh()) await (this.options.sleep ?? delay)(1_000);
    const result = await this.leases.acquire({
      ownerKind: "inprocess",
      ownerToken: this.ownerToken,
      gatewayHttpToken: randomBytes(32).toString("hex"),
      hostId: await loadHostId(this.options.config.DATA_DIR),
      bootId: await loadBootId(),
      pid: process.pid,
      pidStartTime: await loadPidStartTime(),
      scriptHash: "inprocess",
      contractVersion: WHATSAPP_FACADE_CONTRACT_VERSION,
    });
    if (!result.acquired || !result.lease) throw new Error("Could not acquire the in-process WhatsApp session lease");
    this.fence = { ownerToken: this.ownerToken, generation: result.lease.generation };
    this.lastHeartbeatSuccess = performance.now();
    this.heartbeatFailures = 0;
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), 10_000);
    this.heartbeatTimer.unref?.();
  }

  async assertOwned(): Promise<void> {
    if (!this.fence || !(await this.leases.isOwned(this.fence))) {
      throw new Error("In-process WhatsApp socket open rejected because the session lease is not owned");
    }
  }

  async release(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.fence) await this.leases.release(this.fence);
    this.fence = null;
  }

  async resetHistoryGeneration(): Promise<void> {
    if (!this.fence) throw new Error("In-process WhatsApp lease is not acquired");
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (!(await this.leases.resetHistoryGeneration(this.fence))) {
      throw new Error("In-process WhatsApp history generation reset was fenced out");
    }
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), 10_000);
    this.heartbeatTimer.unref?.();
  }

  async withLeaseFence<T>(callback: Parameters<typeof this.leases.withLeaseFence<T>>[1]): Promise<T> {
    if (!this.fence) throw new Error("In-process WhatsApp lease is not acquired");
    return this.leases.withLeaseFence(this.fence, callback);
  }

  private async heartbeat(): Promise<void> {
    try {
      if (!(await this.leases.heartbeat(this.ownerToken))) {
        this.options.logger.error("In-process WhatsApp session lease ownership was lost");
        await this.options.onOwnershipLost?.();
        await this.release();
        return;
      }
      this.lastHeartbeatSuccess = performance.now();
      this.heartbeatFailures = 0;
    } catch (error) {
      this.heartbeatFailures += 1;
      this.options.logger.warn({ error }, "In-process WhatsApp session lease heartbeat failed");
      if (this.heartbeatFailures >= 3 && performance.now() - this.lastHeartbeatSuccess > 25_000) {
        await this.options.onOwnershipLost?.();
        await this.release();
      }
    }
  }
}
