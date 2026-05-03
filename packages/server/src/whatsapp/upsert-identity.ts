type UserRow = {
  id: string;
  name: string;
  email: string | null;
  whatsapp_number: string | null;
  email_verified_at: string | null;
};

type UpsertUsersDeps = {
  findByWhatsappNumber(whatsappNumber: string): Promise<UserRow | undefined>;
  findByEmail(email: string): Promise<UserRow | undefined>;
  create(data: {
    name: string;
    whatsappNumber: string;
    email?: string | null;
    emailVerified?: boolean;
  }): Promise<UserRow>;
  update(
    id: string,
    data: {
      name?: string;
      whatsappNumber?: string | null;
      email?: string | null;
      emailVerified?: boolean;
    },
  ): Promise<UserRow>;
};

export type UpsertWhatsAppIdentityResult =
  | { status: "created"; user: UserRow }
  | { status: "updated"; user: UserRow }
  | { status: "unchanged"; user: UserRow }
  | {
      status: "conflict";
      user: UserRow;
      conflict: { field: "email" | "whatsappNumber"; existingUserId: string; incomingValue: string };
    };

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function trimName(name: string): string {
  return name.trim();
}

function normalizeWhatsappNumber(whatsappNumber: string): string {
  return whatsappNumber.trim();
}

export async function upsertWhatsAppIdentity(
  users: UpsertUsersDeps,
  identity: { name: string; whatsappNumber: string; email?: string | null },
): Promise<UpsertWhatsAppIdentityResult> {
  const name = trimName(identity.name);
  const whatsappNumber = normalizeWhatsappNumber(identity.whatsappNumber);
  const email = identity.email ? normalizeEmail(identity.email) : null;

  const existingByWhatsapp = await users.findByWhatsappNumber(whatsappNumber);
  if (existingByWhatsapp) {
    if (email) {
      const existingByEmail = await users.findByEmail(email);
      if (existingByEmail && existingByEmail.id !== existingByWhatsapp.id) {
        return {
          status: "conflict",
          user: existingByWhatsapp,
          conflict: { field: "email", existingUserId: existingByEmail.id, incomingValue: email },
        };
      }
    }

    const needsNameUpdate = existingByWhatsapp.name !== name;
    const needsEmailUpdate = email !== null && existingByWhatsapp.email !== email;
    const needsVerification = email !== null && !existingByWhatsapp.email_verified_at;

    if (!needsNameUpdate && !needsEmailUpdate && !needsVerification) {
      return { status: "unchanged", user: existingByWhatsapp };
    }

    const updated = await users.update(existingByWhatsapp.id, {
      ...(needsNameUpdate ? { name } : {}),
      ...(needsEmailUpdate ? { email } : {}),
      ...(needsEmailUpdate || needsVerification ? { emailVerified: true } : {}),
    });
    return { status: "updated", user: updated };
  }

  if (email) {
    const existingByEmail = await users.findByEmail(email);
    if (existingByEmail) {
      if (existingByEmail.whatsapp_number && existingByEmail.whatsapp_number !== whatsappNumber) {
        return {
          status: "conflict",
          user: existingByEmail,
          conflict: { field: "whatsappNumber", existingUserId: existingByEmail.id, incomingValue: whatsappNumber },
        };
      }

      const needsNameUpdate = existingByEmail.name !== name;
      const needsWhatsappUpdate = existingByEmail.whatsapp_number !== whatsappNumber;
      const needsVerification = !existingByEmail.email_verified_at;

      if (!needsNameUpdate && !needsWhatsappUpdate && !needsVerification) {
        return { status: "unchanged", user: existingByEmail };
      }

      const updated = await users.update(existingByEmail.id, {
        ...(needsNameUpdate ? { name } : {}),
        ...(needsWhatsappUpdate ? { whatsappNumber } : {}),
        ...(needsVerification ? { emailVerified: true } : {}),
      });
      return { status: "updated", user: updated };
    }
  }

  const created = await users.create({
    name,
    whatsappNumber,
    ...(email ? { email, emailVerified: true } : {}),
  });
  return { status: "created", user: created };
}
