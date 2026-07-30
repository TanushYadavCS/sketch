import type { Logger } from "pino";
import type { Config } from "./config";

const MANAGED_MEMBER_REQUEST_TIMEOUT_MS = 30_000;

const managedMemberSyncTails = new Map<string, Promise<void>>();

export async function withManagedMemberSyncLock<T>(tenantUserId: string, operation: () => Promise<T>): Promise<T> {
  const previous = managedMemberSyncTails.get(tenantUserId) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  managedMemberSyncTails.set(tenantUserId, current);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (managedMemberSyncTails.get(tenantUserId) === current) {
      managedMemberSyncTails.delete(tenantUserId);
    }
  }
}

export async function withManagedMemberSyncLocks<T>(tenantUserIds: string[], operation: () => Promise<T>): Promise<T> {
  const uniqueIds = [...new Set(tenantUserIds)].sort();
  const acquire = (index: number): Promise<T> => {
    const tenantUserId = uniqueIds[index];
    if (!tenantUserId) return operation();
    return withManagedMemberSyncLock(tenantUserId, () => acquire(index + 1));
  };
  return acquire(0);
}

export interface ManagedMemberUser {
  id: string;
  type: string;
  email: string | null;
  whatsapp_number: string | null;
  name: string;
}

export interface ManagedMemberUserSource {
  list(): Promise<ManagedMemberUser[]>;
  findById(id: string): Promise<ManagedMemberUser | undefined>;
}

export interface ManagedMemberRegistrationInput {
  tenantUserId: string;
  email: string;
  name: string;
  phoneNumber: string;
  sendInvite?: boolean;
  managedWhatsappDmEnabled?: boolean;
}

export interface ManagedMemberRemovalInput {
  tenantUserId: string;
  email: string;
}

export interface ManagedMemberRegistrationResult {
  registered: boolean;
  emailSent?: boolean;
  whatsappSent?: boolean;
  mappingStatus?: "active" | "inactive" | "inactive_conflict" | "unchanged";
}

export interface ManagedMemberReconciliationResult {
  skipped: boolean;
  total: number;
  synced: number;
  conflictUserIds: string[];
  failedUserIds: string[];
}

export class ManagedMemberRegistrationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ManagedMemberRegistrationError";
  }
}

function managedPlatformUrl(config: Config): string | null {
  return config.MANAGED_WHATSAPP_PLATFORM_URL ?? config.MANAGED_URL ?? null;
}

function shouldRegisterManagedMembers(config: Config): boolean {
  return Boolean(managedPlatformUrl(config) && config.MANAGED_WHATSAPP_TENANT_TOKEN);
}

function errorFromBody(body: unknown): { code: string; message: string } {
  if (typeof body === "object" && body !== null && "error" in body) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "object" && error !== null) {
      const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "ERROR";
      const message =
        typeof (error as { message?: unknown }).message === "string"
          ? (error as { message: string }).message
          : "Managed member registration failed";
      return { code, message };
    }
    if (typeof error === "string") return { code: "ERROR", message: error };
  }
  return { code: "ERROR", message: "Managed member registration failed" };
}

export async function registerManagedTenantMember(
  config: Config,
  input: ManagedMemberRegistrationInput,
  requestFetch: typeof fetch = fetch,
): Promise<ManagedMemberRegistrationResult> {
  if (!shouldRegisterManagedMembers(config)) return { registered: false };

  const platformUrl = managedPlatformUrl(config);
  if (!platformUrl || !config.MANAGED_WHATSAPP_TENANT_TOKEN) {
    throw new ManagedMemberRegistrationError(503, "UNCONFIGURED", "Managed member registration is not configured");
  }

  const response = await requestFetch(`${platformUrl.replace(/\/+$/u, "")}/api/tenant/members`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${config.MANAGED_WHATSAPP_TENANT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(MANAGED_MEMBER_REQUEST_TIMEOUT_MS),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = errorFromBody(body);
    throw new ManagedMemberRegistrationError(response.status, error.code, error.message);
  }

  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const emailSent = record.emailSent === true;
  const whatsappSent = record.whatsappSent === true;
  const mappingStatus =
    record.mappingStatus === "active" ||
    record.mappingStatus === "inactive" ||
    record.mappingStatus === "inactive_conflict" ||
    record.mappingStatus === "unchanged"
      ? record.mappingStatus
      : undefined;
  if (input.managedWhatsappDmEnabled !== undefined && !mappingStatus) {
    throw new ManagedMemberRegistrationError(
      502,
      "ROUTING_SYNC_UNCONFIRMED",
      "Managed WhatsApp routing sync was not confirmed",
    );
  }
  if (input.sendInvite !== false && !emailSent) {
    throw new ManagedMemberRegistrationError(502, "INVITE_DELIVERY_FAILED", "Managed member invite delivery failed");
  }

  return {
    registered: true,
    emailSent,
    whatsappSent,
    ...(mappingStatus ? { mappingStatus } : {}),
  };
}

export async function removeManagedTenantMember(
  config: Config,
  input: ManagedMemberRemovalInput,
  requestFetch: typeof fetch = fetch,
): Promise<{ removed: boolean }> {
  if (!shouldRegisterManagedMembers(config)) return { removed: false };

  const platformUrl = managedPlatformUrl(config);
  if (!platformUrl || !config.MANAGED_WHATSAPP_TENANT_TOKEN) {
    throw new ManagedMemberRegistrationError(503, "UNCONFIGURED", "Managed member registration is not configured");
  }

  const email = input.email.trim().toLowerCase();
  const query = new URLSearchParams({ tenantUserId: input.tenantUserId });
  const response = await requestFetch(
    `${platformUrl.replace(/\/+$/u, "")}/api/tenant/members/${encodeURIComponent(email)}?${query.toString()}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${config.MANAGED_WHATSAPP_TENANT_TOKEN}`,
      },
      signal: AbortSignal.timeout(MANAGED_MEMBER_REQUEST_TIMEOUT_MS),
    },
  );

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = errorFromBody(body);
    throw new ManagedMemberRegistrationError(response.status, error.code, error.message);
  }

  return { removed: true };
}

export async function reconcileManagedTenantMembers(
  config: Config,
  users: ManagedMemberUserSource,
  logger: Logger,
): Promise<ManagedMemberReconciliationResult> {
  if (!(managedPlatformUrl(config) && config.MANAGED_WHATSAPP_TENANT_TOKEN)) {
    return { skipped: true, total: 0, synced: 0, conflictUserIds: [], failedUserIds: [] };
  }

  const currentUsers = await users.list();
  const humanUserIds = currentUsers.flatMap((user) =>
    user.type === "human" && user.email && user.whatsapp_number ? [user.id] : [],
  );
  const desiredStatus = config.WHATSAPP_DM_PROVIDER === "managed" ? "active" : "inactive";
  const conflictUserIds: string[] = [];
  const failedUserIds: string[] = [];
  let synced = 0;

  for (const tenantUserId of humanUserIds) {
    await withManagedMemberSyncLock(tenantUserId, async () => {
      const user = await users.findById(tenantUserId);
      if (user?.type !== "human" || !user.email || !user.whatsapp_number) return;

      try {
        const result = await registerManagedTenantMember(config, {
          tenantUserId: user.id,
          email: user.email,
          name: user.name,
          phoneNumber: user.whatsapp_number,
          sendInvite: false,
          managedWhatsappDmEnabled: config.WHATSAPP_DM_PROVIDER === "managed",
        });
        if (result.mappingStatus === desiredStatus) synced += 1;
        else if (result.mappingStatus === "inactive_conflict") conflictUserIds.push(user.id);
        else failedUserIds.push(user.id);
      } catch (err) {
        failedUserIds.push(user.id);
        logger.warn({ err, userId: user.id }, "Managed member reconciliation failed");
      }
    });
  }

  return {
    skipped: false,
    total: humanUserIds.length,
    synced,
    conflictUserIds,
    failedUserIds,
  };
}
