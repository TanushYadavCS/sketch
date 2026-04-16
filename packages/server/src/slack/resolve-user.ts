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
      data: { slackUserId?: string | null; email?: string | null; emailVerified?: boolean },
    ): Promise<UserRow>;
  };
  getUserInfo(slackUserId: string): Promise<{ name: string; realName: string; email: string | null }>;
  logger: Logger;
}

export async function resolveSlackUser(slackUserId: string, deps: ResolveSlackUserDeps): Promise<UserRow> {
  const { users, getUserInfo, logger } = deps;

  let user = await users.findBySlackId(slackUserId);
  logger.debug({ slackUserId, found: !!user, userId: user?.id }, "resolveSlackUser: findBySlackId result");

  if (!user) {
    const userInfo = await getUserInfo(slackUserId);
    logger.debug(
      { slackUserId, email: userInfo.email, realName: userInfo.realName },
      "resolveSlackUser: Slack profile",
    );

    if (userInfo.email) {
      const existing = await users.findByEmail(userInfo.email);
      logger.debug(
        {
          email: userInfo.email,
          found: !!existing,
          existingId: existing?.id,
          existingSlackId: existing?.slack_user_id,
        },
        "resolveSlackUser: findByEmail result",
      );

      if (existing && !existing.slack_user_id) {
        user = await users.update(existing.id, { slackUserId, emailVerified: true });
        logger.info({ userId: user.id, name: user.name }, "Linked Slack ID to existing user by email");
      } else if (existing?.slack_user_id) {
        logger.debug(
          { existingId: existing.id, existingSlackId: existing.slack_user_id, newSlackId: slackUserId },
          "resolveSlackUser: skipped linking, user already has a Slack ID",
        );
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
    const userInfo = await getUserInfo(slackUserId);
    if (userInfo.email) {
      user = await users.update(user.id, { email: userInfo.email, emailVerified: true });
      logger.debug({ userId: user.id, email: userInfo.email }, "resolveSlackUser: backfilled email (auto-verified)");
    }
  } else {
    logger.debug({ userId: user.id, name: user.name }, "resolveSlackUser: existing user with email, no changes");
  }
  return user;
}
