import type { Kysely } from "kysely";
import { parseFollowupReviewCommand } from "../commands";
import { createConversationFollowupsRepository } from "../db/repositories/conversation-followups";
import { createEntityRepository } from "../db/repositories/entities";
import { createTaskDurabilityTransitionRepository } from "../db/repositories/task-durability-transition";
import { resolvePersonEntitiesForUser as resolveLinkedPersonEntitiesForUser } from "../db/repositories/user-entity-resolver";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";

type FollowupReviewSurface = "slack" | "whatsapp";

type RecommendationReviewResult =
  | { status: "confirmed"; taskId: string }
  | { status: "kept_open"; taskId: string }
  | { status: "stale" }
  | { status: "unauthorized" }
  | { status: "not_found" };

type SeedReviewResult =
  | { status: "accepted"; taskId: string; mode: "hybrid" | "durable_only" }
  | { status: "dismissed"; mode: "hybrid" | "durable_only" }
  | {
      status: "already_reviewed";
      decision: "track" | "dismiss";
      taskId?: string;
      mode: "hybrid" | "durable_only";
    }
  | { status: "not_found" };

export type FollowupReviewCommandResult = { handled: false } | { handled: true; message: string };

export type FollowupReviewCommandHandler = (input: {
  text: string;
  userId: string;
  surface: FollowupReviewSurface;
}) => Promise<FollowupReviewCommandResult>;

interface FollowupReviewCommandDependencies {
  users: {
    getVerifiedEmailsForUser(userId: string): Promise<string[]>;
  };
  entities: {
    getPersonEntitiesByEmails(emails: string[]): Promise<Map<string, Array<{ id: string }>>>;
  };
  resolvePersonEntitiesForUser(userId: string, emails: string[]): Promise<Map<string, Array<{ id: string }>>>;
  followups: {
    reviewRecommendation(input: {
      code: string;
      action: "confirm_done" | "keep_open";
      userId: string;
      assigneeEntityIds: string[];
      surface: string;
      now: string;
    }): Promise<RecommendationReviewResult>;
  };
  transition: {
    reviewSeedCandidate(input: {
      userId: string;
      code: string;
      decision: "track" | "dismiss";
      surface: string;
      now: string;
    }): Promise<SeedReviewResult>;
  };
  now: () => string;
}

const NOT_FOUND_MESSAGE = "I couldn't find an active follow-up review for that code.";
const FAILURE_MESSAGE = "I couldn't update that follow-up right now. Please try again.";

function recommendationMessage(result: RecommendationReviewResult): string {
  switch (result.status) {
    case "confirmed":
      return "Marked the follow-up done.";
    case "kept_open":
      return "Kept the follow-up open.";
    case "stale":
      return "That follow-up review was already handled or has expired.";
    case "unauthorized":
    case "not_found":
      return NOT_FOUND_MESSAGE;
  }
}

function seedMessage(result: SeedReviewResult): string {
  switch (result.status) {
    case "accepted":
      return "Now tracking that follow-up.";
    case "dismissed":
      return "Dismissed that reconstructed follow-up.";
    case "already_reviewed":
      return "That follow-up review was already handled.";
    case "not_found":
      return NOT_FOUND_MESSAGE;
  }
}

export function createFollowupReviewCommandHandler(
  db: Kysely<DB>,
  overrides: Partial<FollowupReviewCommandDependencies> = {},
): FollowupReviewCommandHandler {
  const users = overrides.users ?? createUserRepository(db);
  const entities = overrides.entities ?? createEntityRepository(db);
  const resolvePersonEntities =
    overrides.resolvePersonEntitiesForUser ??
    (overrides.entities
      ? (_userId: string, emails: string[]) => entities.getPersonEntitiesByEmails(emails)
      : (userId: string, emails: string[]) => resolveLinkedPersonEntitiesForUser(db, userId, emails));
  const followups = overrides.followups ?? createConversationFollowupsRepository(db);
  const transition = overrides.transition ?? createTaskDurabilityTransitionRepository(db);
  const now = overrides.now ?? (() => new Date().toISOString());

  return async ({ text, userId, surface }) => {
    const command = parseFollowupReviewCommand(text);
    if (!command) return { handled: false };

    try {
      if (command.action === "confirm_done" || command.action === "keep_open") {
        const verifiedEmails = await users.getVerifiedEmailsForUser(userId);
        const peopleByEmail = await resolvePersonEntities(userId, verifiedEmails);
        const assigneeEntityIds = [...new Set([...peopleByEmail.values()].flat().map((person) => person.id))];
        const result = await followups.reviewRecommendation({
          code: command.code,
          action: command.action,
          userId,
          assigneeEntityIds,
          surface,
          now: now(),
        });
        return { handled: true, message: recommendationMessage(result) };
      }

      const result = await transition.reviewSeedCandidate({
        userId,
        code: command.code,
        decision: command.action,
        surface,
        now: now(),
      });
      return { handled: true, message: seedMessage(result) };
    } catch {
      return { handled: true, message: FAILURE_MESSAGE };
    }
  };
}
