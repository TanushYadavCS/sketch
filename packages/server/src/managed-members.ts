import type { Logger } from "pino";
import type { Config } from "./config";

const MANAGED_MEMBER_REQUEST_TIMEOUT_MS = 30_000;

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
  users: Array<{
    id: string;
    type: string;
    email: string | null;
    whatsapp_number: string | null;
    name: string;
  }>,
  logger: Logger,
): Promise<ManagedMemberReconciliationResult> {
  if (!(managedPlatformUrl(config) && config.MANAGED_WHATSAPP_TENANT_TOKEN)) {
    return { skipped: true, total: 0, synced: 0, conflictUserIds: [], failedUserIds: [] };
  }

  const humanUsers = users.flatMap((user) =>
    user.type === "human" && user.email && user.whatsapp_number
      ? [{ ...user, email: user.email, whatsappNumber: user.whatsapp_number }]
      : [],
  );
  const desiredStatus = config.WHATSAPP_DM_PROVIDER === "managed" ? "active" : "inactive";
  const conflictUserIds: string[] = [];
  const failedUserIds: string[] = [];
  let synced = 0;

  for (const user of humanUsers) {
    try {
      const result = await registerManagedTenantMember(config, {
        tenantUserId: user.id,
        email: user.email,
        name: user.name,
        phoneNumber: user.whatsappNumber,
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
  }

  return {
    skipped: false,
    total: humanUsers.length,
    synced,
    conflictUserIds,
    failedUserIds,
  };
}
