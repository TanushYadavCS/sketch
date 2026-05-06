type UserRow = {
  id: string;
  name: string;
  email: string | null;
  slack_user_id: string | null;
  whatsapp_number: string | null;
  created_at: string;
  email_verified_at: string | null;
  tool_progress: string | null;
  reasoning_text: number | null;
  timezone: string | null;
};

type UpsertUsersDeps = {
  findBySlackId(slackUserId: string): Promise<UserRow | undefined>;
  findByEmail(email: string): Promise<UserRow | undefined>;
  create(data: {
    name: string;
    slackUserId: string;
    email: string;
    emailVerified?: boolean;
  }): Promise<UserRow>;
  update(
    id: string,
    data: {
      name?: string;
      slackUserId?: string | null;
      email?: string | null;
      emailVerified?: boolean;
    },
  ): Promise<UserRow>;
};

export type UpsertSlackIdentityResult =
  | { status: "created"; user: UserRow }
  | { status: "updated"; user: UserRow }
  | { status: "unchanged"; user: UserRow }
  | {
      status: "conflict";
      user: UserRow;
      conflict: { email: string; existingSlackUserId: string; incomingSlackUserId: string };
    };

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function trimName(name: string): string {
  return name.trim();
}

export async function upsertSlackIdentity(
  users: UpsertUsersDeps,
  identity: { name: string; email: string; slackUserId: string },
): Promise<UpsertSlackIdentityResult> {
  const name = trimName(identity.name);
  const email = normalizeEmail(identity.email);

  const existingBySlack = await users.findBySlackId(identity.slackUserId);
  if (existingBySlack) {
    const needsNameUpdate = existingBySlack.name !== name;
    const needsEmailUpdate = existingBySlack.email !== email;
    const needsVerification = !existingBySlack.email_verified_at;

    if (!needsNameUpdate && !needsEmailUpdate && !needsVerification) {
      return { status: "unchanged", user: existingBySlack };
    }

    const updated = await users.update(existingBySlack.id, {
      ...(needsNameUpdate ? { name } : {}),
      ...(needsEmailUpdate ? { email } : {}),
      ...(needsEmailUpdate || needsVerification ? { emailVerified: true } : {}),
    });
    return { status: "updated", user: updated };
  }

  const existingByEmail = await users.findByEmail(email);
  if (existingByEmail) {
    if (existingByEmail.slack_user_id && existingByEmail.slack_user_id !== identity.slackUserId) {
      return {
        status: "conflict",
        user: existingByEmail,
        conflict: {
          email,
          existingSlackUserId: existingByEmail.slack_user_id,
          incomingSlackUserId: identity.slackUserId,
        },
      };
    }

    const needsNameUpdate = existingByEmail.name !== name;
    const needsSlackUpdate = existingByEmail.slack_user_id !== identity.slackUserId;
    const needsVerification = !existingByEmail.email_verified_at;

    if (!needsNameUpdate && !needsSlackUpdate && !needsVerification) {
      return { status: "unchanged", user: existingByEmail };
    }

    const updated = await users.update(existingByEmail.id, {
      ...(needsNameUpdate ? { name } : {}),
      ...(needsSlackUpdate ? { slackUserId: identity.slackUserId } : {}),
      ...(needsVerification ? { emailVerified: true } : {}),
    });
    return { status: "updated", user: updated };
  }

  const created = await users.create({
    name,
    email,
    slackUserId: identity.slackUserId,
    emailVerified: true,
  });
  return { status: "created", user: created };
}
