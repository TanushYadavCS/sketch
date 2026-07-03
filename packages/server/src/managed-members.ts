import type { Config } from "./config";

export interface ManagedMemberRegistrationInput {
  tenantUserId: string;
  email: string;
  name: string;
  phoneNumber: string;
  sendInvite?: boolean;
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
  return Boolean(config.MANAGED_URL || config.MANAGED_WHATSAPP_PLATFORM_URL || config.MANAGED_WHATSAPP_TENANT_TOKEN);
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
  return {
    registered: true,
    emailSent: record.emailSent === true,
    whatsappSent: record.whatsappSent === true,
  };
}
