import type { Config } from "./config";

export interface ManagedMemberRegistrationInput {
  tenantUserId: string;
  email: string;
  name: string;
  phoneNumber: string;
  sendInvite?: boolean;
}

export interface ManagedMemberRemovalInput {
  email: string;
}

export interface ManagedMemberRegistrationResult {
  registered: boolean;
  emailSent?: boolean;
  whatsappSent?: boolean;
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
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = errorFromBody(body);
    throw new ManagedMemberRegistrationError(response.status, error.code, error.message);
  }

  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const emailSent = record.emailSent === true;
  const whatsappSent = record.whatsappSent === true;
  if (input.sendInvite !== false && !emailSent) {
    throw new ManagedMemberRegistrationError(502, "INVITE_DELIVERY_FAILED", "Managed member invite delivery failed");
  }

  return {
    registered: true,
    emailSent,
    whatsappSent,
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
  const response = await requestFetch(
    `${platformUrl.replace(/\/+$/u, "")}/api/tenant/members/${encodeURIComponent(email)}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${config.MANAGED_WHATSAPP_TENANT_TOKEN}`,
      },
    },
  );

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = errorFromBody(body);
    throw new ManagedMemberRegistrationError(response.status, error.code, error.message);
  }

  return { removed: true };
}
