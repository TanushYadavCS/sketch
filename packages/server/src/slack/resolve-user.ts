/**
 * Resolve a Slack user to a users table row. Handles three cases:
 * 1. User found by Slack ID (existing). Backfills email if missing.
 * 2. User not found by Slack ID but found by email (admin-created). Links Slack ID.
 * 3. User not found at all. Creates a new row.
 *
 * When linking by email, only links if the matched user doesn't already have
 * a different Slack ID to avoid accidental identity merging.
 */
import type { Logger } from "../logger";
import { upsertSlackIdentity } from "./upsert-identity";

type UserRow = {
  id: string;
  name: string;
  email: string | null;
  auth_role: string;
  slack_user_id: string | null;
  whatsapp_number: string | null;
  created_at: string;
  email_verified_at: string | null;
  tool_progress: string | null;
  reasoning_text: number | null;
  timezone: string | null;
};

export interface ResolveSlackUserDeps {
  users: {
    findBySlackId(slackUserId: string): Promise<UserRow | undefined>;
    findByEmail(email: string): Promise<UserRow | undefined>;
    create(data: {
      name: string;
      slackUserId: string;
      email: string | null;
      emailVerified?: boolean;
    }): Promise<UserRow>;
    update(
      id: string,
      data: {
        slackUserId?: string | null;
        email?: string | null;
        emailVerified?: boolean;
        timezone?: string | null;
        skipEntityLinking?: boolean;
      },
    ): Promise<UserRow>;
  };
  getUserInfo(
    slackUserId: string,
  ): Promise<{ name: string; realName: string; email: string | null; tz: string | null }>;
  logger: Logger;
}

export class SlackIdentityConflictError extends Error {
  constructor(
    readonly conflict: {
      email: string;
      existingUserId: string;
      existingSlackUserId: string;
      incomingSlackUserId: string;
    },
  ) {
    super(
      `Email ${conflict.email} is already linked to Slack user ${conflict.existingSlackUserId}; refusing to link ${conflict.incomingSlackUserId}`,
    );
  }
}

export async function resolveSlackUser(slackUserId: string, deps: ResolveSlackUserDeps): Promise<UserRow> {
  const { users, getUserInfo, logger } = deps;

  let user = await users.findBySlackId(slackUserId);
  logger.debug({ slackUserId, found: !!user, userId: user?.id }, "resolveSlackUser: findBySlackId result");

  let cachedUserInfo: Awaited<ReturnType<typeof getUserInfo>> | undefined;
  const fetchUserInfo = async () => {
    if (!cachedUserInfo) cachedUserInfo = await getUserInfo(slackUserId);
    return cachedUserInfo;
  };

  if (!user) {
    const userInfo = await fetchUserInfo();
    logger.debug(
      { slackUserId, email: userInfo.email, realName: userInfo.realName },
      "resolveSlackUser: Slack profile",
    );

    if (userInfo.email) {
      const result = await upsertSlackIdentity(users, {
        name: userInfo.realName,
        email: userInfo.email,
        slackUserId,
      });

      if (result.status === "conflict") {
        logger.warn(
          {
            existingId: result.user.id,
            email: result.conflict.email,
            existingSlackId: result.conflict.existingSlackUserId,
            newSlackId: result.conflict.incomingSlackUserId,
          },
          "resolveSlackUser: email already linked to a different Slack user",
        );
        throw new SlackIdentityConflictError({
          email: result.conflict.email,
          existingUserId: result.user.id,
          existingSlackUserId: result.conflict.existingSlackUserId,
          incomingSlackUserId: result.conflict.incomingSlackUserId,
        });
      }

      const resolvedUser = result.user;
      user = resolvedUser;
      if (result.status === "created") {
        logger.info({ userId: resolvedUser.id, name: resolvedUser.name }, "New user created");
      } else if (result.status === "updated") {
        logger.info({ userId: resolvedUser.id, name: resolvedUser.name }, "Linked Slack ID to existing user by email");
      }
    }
    if (!user) {
      user = await users.create({
        name: userInfo.realName,
        slackUserId,
        email: userInfo.email,
        emailVerified: !!userInfo.email,
      });
      logger.info({ userId: user.id, name: user.name }, "New user created");
    }
  } else if (!user.email) {
    const userInfo = await fetchUserInfo();
    if (userInfo.email) {
      user = await users.update(user.id, { email: userInfo.email, emailVerified: true });
      logger.debug({ userId: user.id, email: userInfo.email }, "resolveSlackUser: backfilled email (auto-verified)");
    }
  } else {
    logger.debug({ userId: user.id, name: user.name }, "resolveSlackUser: existing user with email, no changes");
  }

  if (!user.timezone) {
    const userInfo = await fetchUserInfo();
    if (userInfo.tz) {
      user = await users.update(user.id, { timezone: userInfo.tz });
      logger.debug({ userId: user.id, timezone: userInfo.tz }, "resolveSlackUser: hydrated timezone from Slack");
    }
  }

  return user;
}
