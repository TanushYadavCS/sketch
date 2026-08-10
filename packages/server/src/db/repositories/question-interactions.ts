import { randomUUID } from "node:crypto";
import { type WebChatQuestion, webChatQuestionAnswerSchema } from "@sketch/shared";
import type { Kysely, Transaction } from "kysely";
import type { DB } from "../schema";

type Executor = Kysely<DB> | Transaction<DB>;
export type QuestionInteractionState = "pending" | "answered" | "cancelled" | "expired" | "delivery_failed";
export const QUESTION_INTERACTION_PUBLIC_CODE_LENGTH = 10;
export const QUESTION_INTERACTION_PUBLIC_CODE_MAX_ATTEMPTS = 8;
export interface QuestionInteractionTarget {
  platform: "web" | "slack" | "whatsapp";
  conversationKind: "dm" | "channel" | "group";
  conversationId: string;
  threadId: string | null;
  requesterPrincipalId: string;
  eligibleResponderPrincipalIds: string[];
}
export interface QuestionInteractionQuestion {
  questionId: string;
  prompt: string;
  options: WebChatQuestion["options"];
  allowsCustomResponse: boolean;
}
export interface ResumeWork {
  interactionId: string;
  sessionId: string;
  taskId: string | null;
  agentRunId: string | null;
  resumeContext: unknown;
  answers: Array<{ questionId: string; optionId?: string; customResponse?: string }>;
}
export interface QuestionInteractionDeliverySnapshot {
  id: string;
  attempt: number;
  transport: string;
  capability: string;
  status: string;
  providerMessageRef: string | null;
  requestKey: string;
  errorCode: string | null;
}
export interface QuestionInteractionSnapshot {
  interactionId: string;
  publicCode: string;
  state: QuestionInteractionState;
  target: QuestionInteractionTarget;
  sessionId: string;
  taskId: string | null;
  agentRunId: string | null;
  resumeContext: unknown;
  expiresAt: string;
  answeredAt: string | null;
  cancelledAt: string | null;
  expiredAt: string | null;
  deliveryRef: string | null;
  questions: QuestionInteractionQuestion[];
  deliveries: QuestionInteractionDeliverySnapshot[];
}
export interface PendingQuestionInteractionStepSnapshot {
  interaction: QuestionInteractionSnapshot;
  question: QuestionInteractionQuestion;
  questionNumber: number;
  questionCount: number;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}
function isoNow(): string {
  return new Date().toISOString();
}
function eventKey(inboundEventId: string): string {
  return inboundEventId;
}
function createPublicCode(): string {
  return randomUUID().replaceAll("-", "").slice(0, QUESTION_INTERACTION_PUBLIC_CODE_LENGTH).toUpperCase();
}
function activeScopeKey(target: QuestionInteractionTarget): string {
  return JSON.stringify([target.platform, target.conversationId, target.threadId, target.requesterPrincipalId]);
}
async function loadInteraction(executor: Executor, id: string) {
  return executor.selectFrom("question_interactions").selectAll().where("id", "=", id).executeTakeFirst();
}
async function resumeWork(executor: Executor, interactionId: string): Promise<ResumeWork | undefined> {
  const interaction = await loadInteraction(executor, interactionId);
  if (!interaction || interaction.state !== "answered") return undefined;
  const items = await executor
    .selectFrom("question_interaction_items")
    .selectAll()
    .where("interaction_id", "=", interactionId)
    .orderBy("ordinal")
    .execute();
  if (items.some((item) => !item.answered_at)) return undefined;
  return {
    interactionId,
    sessionId: interaction.session_id,
    taskId: interaction.task_id,
    agentRunId: interaction.agent_run_id,
    resumeContext: parseJson(interaction.resume_context_json),
    answers: items.map((item) =>
      item.selected_option_id
        ? { questionId: item.question_id, optionId: item.selected_option_id }
        : { questionId: item.question_id, customResponse: item.custom_response ?? "" },
    ),
  };
}
async function interactionSnapshot(
  executor: Executor,
  interactionId: string,
): Promise<QuestionInteractionSnapshot | undefined> {
  const interaction = await loadInteraction(executor, interactionId);
  if (!interaction) return undefined;
  const [items, deliveries] = await Promise.all([
    executor
      .selectFrom("question_interaction_items")
      .selectAll()
      .where("interaction_id", "=", interactionId)
      .orderBy("ordinal")
      .execute(),
    executor
      .selectFrom("question_interaction_deliveries")
      .selectAll()
      .where("interaction_id", "=", interactionId)
      .orderBy("attempt")
      .execute(),
  ]);
  return {
    interactionId: interaction.id,
    publicCode: interaction.public_code,
    state: interaction.state as QuestionInteractionState,
    target: {
      platform: interaction.platform as QuestionInteractionTarget["platform"],
      conversationKind: interaction.conversation_kind as QuestionInteractionTarget["conversationKind"],
      conversationId: interaction.conversation_id,
      threadId: interaction.thread_id,
      requesterPrincipalId: interaction.requester_principal_id,
      eligibleResponderPrincipalIds: parseJson(interaction.eligible_responder_principal_ids_json),
    },
    sessionId: interaction.session_id,
    taskId: interaction.task_id,
    agentRunId: interaction.agent_run_id,
    resumeContext: parseJson(interaction.resume_context_json),
    expiresAt: interaction.expires_at,
    answeredAt: interaction.answered_at,
    cancelledAt: interaction.cancelled_at,
    expiredAt: interaction.expired_at,
    deliveryRef: interaction.delivery_ref,
    questions: items.map((item) => ({
      questionId: item.question_id,
      prompt: item.prompt,
      options: parseJson(item.options_json),
      allowsCustomResponse: Boolean(item.allows_custom_response),
    })),
    deliveries: deliveries.map((delivery) => ({
      id: delivery.id,
      attempt: delivery.attempt,
      transport: delivery.transport,
      capability: delivery.capability,
      status: delivery.status,
      providerMessageRef: delivery.provider_message_ref,
      requestKey: delivery.request_key,
      errorCode: delivery.error_code,
    })),
  };
}

export function createQuestionInteractionsRepository(db: Kysely<DB>) {
  async function addEvent(
    executor: Executor,
    input: {
      interactionId: string;
      eventType: string;
      actorPrincipalId: string;
      payload?: unknown;
      inboundEventId?: string | null;
    },
  ) {
    await executor
      .insertInto("question_interaction_events")
      .values({
        id: randomUUID(),
        interaction_id: input.interactionId,
        event_type: input.eventType,
        inbound_event_id: input.inboundEventId ?? null,
        event_key: input.inboundEventId ? eventKey(input.inboundEventId) : randomUUID(),
        actor_principal_id: input.actorPrincipalId,
        payload_json: JSON.stringify(input.payload ?? {}),
        created_at: isoNow(),
      })
      .execute();
  }
  return {
    async createPendingQuestionInteraction(input: {
      id?: string;
      taskId?: string | null;
      agentRunId?: string | null;
      sessionId: string;
      target: QuestionInteractionTarget;
      questions: QuestionInteractionQuestion[];
      resumeContext: unknown;
      expiresAt: string;
    }) {
      if (input.questions.length < 1) throw new Error("An interaction requires at least one question");
      const id = input.id ?? randomUUID();
      return db.transaction().execute(async (trx) => {
        if (input.taskId) {
          const active = await trx
            .selectFrom("question_interactions")
            .select("id")
            .where("task_id", "=", input.taskId)
            .where("state", "=", "pending")
            .executeTakeFirst();
          if (active) throw new Error("An active question interaction already exists for this task");
        }
        let activeScopeQuery = trx
          .selectFrom("question_interactions")
          .select("id")
          .where("state", "=", "pending")
          .where("platform", "=", input.target.platform)
          .where("conversation_id", "=", input.target.conversationId)
          .where("requester_principal_id", "=", input.target.requesterPrincipalId);
        activeScopeQuery =
          input.target.threadId === null
            ? activeScopeQuery.where("thread_id", "is", null)
            : activeScopeQuery.where("thread_id", "=", input.target.threadId);
        const activeScope = await activeScopeQuery.executeTakeFirst();
        if (activeScope) throw new Error("An active question interaction already exists for this conversation scope");
        const now = isoNow();
        let inserted = false;
        for (let attempt = 0; attempt < QUESTION_INTERACTION_PUBLIC_CODE_MAX_ATTEMPTS; attempt += 1) {
          try {
            await trx
              .insertInto("question_interactions")
              .values({
                id,
                public_code: createPublicCode(),
                active_scope_key: activeScopeKey(input.target),
                active_task_key: input.taskId ?? null,
                state: "pending",
                platform: input.target.platform,
                conversation_kind: input.target.conversationKind,
                conversation_id: input.target.conversationId,
                thread_id: input.target.threadId,
                requester_principal_id: input.target.requesterPrincipalId,
                eligible_responder_principal_ids_json: JSON.stringify(input.target.eligibleResponderPrincipalIds),
                session_id: input.sessionId,
                task_id: input.taskId ?? null,
                agent_run_id: input.agentRunId ?? null,
                resume_context_json: JSON.stringify(input.resumeContext),
                expires_at: input.expiresAt,
                answered_at: null,
                cancelled_at: null,
                expired_at: null,
                delivery_ref: null,
                created_at: now,
                updated_at: now,
              })
              .execute();
            inserted = true;
            break;
          } catch (error) {
            const existing = await trx
              .selectFrom("question_interactions")
              .select("id")
              .where("id", "=", id)
              .executeTakeFirst();
            if (existing || attempt === QUESTION_INTERACTION_PUBLIC_CODE_MAX_ATTEMPTS - 1) throw error;
          }
        }
        if (!inserted) throw new Error("Unable to allocate a public interaction code");
        await trx
          .insertInto("question_interaction_items")
          .values(
            input.questions.map((question, ordinal) => ({
              interaction_id: id,
              ordinal,
              question_id: question.questionId,
              prompt: question.prompt,
              options_json: JSON.stringify(question.options),
              allows_custom_response: question.allowsCustomResponse ? 1 : 0,
              selected_option_id: null,
              custom_response: null,
              answered_by_principal_id: null,
              answered_at: null,
            })),
          )
          .execute();
        await addEvent(trx, {
          interactionId: id,
          eventType: "created",
          actorPrincipalId: input.target.requesterPrincipalId,
        });
        return loadInteraction(trx, id);
      });
    },
    async claimQuestionInteractionDelivery(input: {
      interactionId: string;
      requestKey: string;
      transport: string;
      capability: string;
    }) {
      const existing = await db
        .selectFrom("question_interaction_deliveries")
        .selectAll()
        .where("request_key", "=", input.requestKey)
        .executeTakeFirst();
      if (existing) return { kind: "already_claimed" as const, delivery: existing };
      const interaction = await loadInteraction(db, input.interactionId);
      if (!interaction || interaction.state !== "pending") return { kind: "not_pending" as const };
      const attempt =
        (
          await db
            .selectFrom("question_interaction_deliveries")
            .select("attempt")
            .where("interaction_id", "=", input.interactionId)
            .orderBy("attempt", "desc")
            .executeTakeFirst()
        )?.attempt ?? -1;
      const delivery = {
        id: randomUUID(),
        interaction_id: input.interactionId,
        attempt: attempt + 1,
        transport: input.transport,
        capability: input.capability,
        status: "claimed",
        provider_message_ref: null,
        request_key: input.requestKey,
        error_code: null,
        created_at: isoNow(),
        updated_at: isoNow(),
      };
      try {
        await db.insertInto("question_interaction_deliveries").values(delivery).execute();
      } catch {
        const replay = await db
          .selectFrom("question_interaction_deliveries")
          .selectAll()
          .where("request_key", "=", input.requestKey)
          .executeTakeFirst();
        if (replay) return { kind: "already_claimed" as const, delivery: replay };
        throw new Error("Unable to claim interaction delivery");
      }
      return { kind: "claimed" as const, delivery };
    },
    async recordQuestionInteractionDeliveryResult(input: {
      deliveryId: string;
      status: "sent" | "failed";
      providerMessageRef?: string | null;
      errorCode?: string | null;
    }) {
      await db
        .updateTable("question_interaction_deliveries")
        .set({
          status: input.status,
          provider_message_ref: input.providerMessageRef ?? null,
          error_code: input.errorCode ?? null,
          updated_at: isoNow(),
        })
        .where("id", "=", input.deliveryId)
        .execute();
    },
    async submitQuestionInteractionAnswer(input: {
      interactionId: string;
      questionId: string;
      optionId?: string;
      customResponse?: string;
      responderPrincipalId: string;
      inboundEventId: string;
      receivedAt: string;
    }) {
      return db.transaction().execute(async (trx) => {
        const duplicate = await trx
          .selectFrom("question_interaction_events")
          .select("id")
          .where("interaction_id", "=", input.interactionId)
          .where("event_key", "=", eventKey(input.inboundEventId))
          .executeTakeFirst();
        if (duplicate)
          return {
            kind: "duplicate" as const,
            state: (await loadInteraction(trx, input.interactionId))?.state,
            resumeWork: await resumeWork(trx, input.interactionId),
          };
        const interaction = await loadInteraction(trx, input.interactionId);
        if (!interaction || interaction.state !== "pending")
          return { kind: "not_pending" as const, state: interaction?.state };
        if (new Date(interaction.expires_at).getTime() <= new Date(input.receivedAt).getTime()) {
          const expired = await trx
            .updateTable("question_interactions")
            .set({
              state: "expired",
              active_scope_key: null,
              active_task_key: null,
              expired_at: input.receivedAt,
              updated_at: isoNow(),
            })
            .where("id", "=", input.interactionId)
            .where("state", "=", "pending")
            .executeTakeFirst();
          if (Number(expired.numUpdatedRows))
            await addEvent(trx, {
              interactionId: input.interactionId,
              eventType: "expired",
              actorPrincipalId: interaction.requester_principal_id,
            });
          return { kind: "expired" as const, state: "expired" as const };
        }
        if (
          !parseJson<string[]>(interaction.eligible_responder_principal_ids_json).includes(input.responderPrincipalId)
        )
          return { kind: "unauthorized" as const, state: interaction.state };
        const answer = webChatQuestionAnswerSchema.safeParse({
          questionId: input.questionId,
          ...(input.optionId ? { optionId: input.optionId } : {}),
          ...(input.customResponse !== undefined ? { customResponse: input.customResponse } : {}),
        });
        if (!answer.success) return { kind: "invalid" as const, state: interaction.state };
        const item = await trx
          .selectFrom("question_interaction_items")
          .selectAll()
          .where("interaction_id", "=", input.interactionId)
          .where("question_id", "=", input.questionId)
          .executeTakeFirst();
        if (!item || item.answered_at) return { kind: "stale" as const, state: interaction.state };
        const value = answer.data;
        if (
          "optionId" in value &&
          !parseJson<Array<{ id: string }>>(item.options_json).some((option) => option.id === value.optionId)
        )
          return { kind: "invalid" as const, state: interaction.state };
        if ("customResponse" in value && !item.allows_custom_response)
          return { kind: "invalid" as const, state: interaction.state };
        const itemUpdate = await trx
          .updateTable("question_interaction_items")
          .set({
            selected_option_id: "optionId" in value ? value.optionId : null,
            custom_response: "customResponse" in value ? value.customResponse : null,
            answered_by_principal_id: input.responderPrincipalId,
            answered_at: input.receivedAt,
          })
          .where("interaction_id", "=", input.interactionId)
          .where("question_id", "=", input.questionId)
          .where("answered_at", "is", null)
          .executeTakeFirst();
        if (!Number(itemUpdate.numUpdatedRows)) return { kind: "stale" as const, state: interaction.state };
        await addEvent(trx, {
          interactionId: input.interactionId,
          eventType: "answer_submitted",
          actorPrincipalId: input.responderPrincipalId,
          inboundEventId: input.inboundEventId,
          payload: { questionId: input.questionId, answerKind: "optionId" in value ? "option" : "custom" },
        });
        const remaining = await trx
          .selectFrom("question_interaction_items")
          .select("question_id")
          .where("interaction_id", "=", input.interactionId)
          .where("answered_at", "is", null)
          .execute();
        if (remaining.length) return { kind: "accepted_pending" as const, state: "pending" as const };
        const interactionUpdate = await trx
          .updateTable("question_interactions")
          .set({
            state: "answered",
            active_scope_key: null,
            active_task_key: null,
            answered_at: input.receivedAt,
            updated_at: isoNow(),
          })
          .where("id", "=", input.interactionId)
          .where("state", "=", "pending")
          .executeTakeFirst();
        if (!Number(interactionUpdate.numUpdatedRows))
          return { kind: "stale" as const, state: (await loadInteraction(trx, input.interactionId))?.state };
        return {
          kind: "answered" as const,
          state: "answered" as const,
          resumeWork: await resumeWork(trx, input.interactionId),
        };
      });
    },
    async submitQuestionInteractionBatchAnswer(input: {
      interactionId: string;
      answers: Array<{ questionId: string; optionId?: string; customResponse?: string }>;
      responderPrincipalId: string;
      inboundEventId: string;
      receivedAt: string;
    }) {
      return db.transaction().execute(async (trx) => {
        const duplicate = await trx
          .selectFrom("question_interaction_events")
          .select("id")
          .where("interaction_id", "=", input.interactionId)
          .where("event_key", "=", eventKey(input.inboundEventId))
          .executeTakeFirst();
        const interaction = await loadInteraction(trx, input.interactionId);
        if (duplicate)
          return {
            kind: "duplicate" as const,
            state: interaction?.state,
            resumeWork: await resumeWork(trx, input.interactionId),
          };
        if (!interaction || interaction.state !== "pending")
          return { kind: "not_pending" as const, state: interaction?.state };
        if (new Date(interaction.expires_at).getTime() <= new Date(input.receivedAt).getTime()) {
          await trx
            .updateTable("question_interactions")
            .set({
              state: "expired",
              active_scope_key: null,
              active_task_key: null,
              expired_at: input.receivedAt,
              updated_at: isoNow(),
            })
            .where("id", "=", input.interactionId)
            .where("state", "=", "pending")
            .execute();
          return { kind: "expired" as const, state: "expired" as const };
        }
        if (
          !parseJson<string[]>(interaction.eligible_responder_principal_ids_json).includes(input.responderPrincipalId)
        )
          return { kind: "unauthorized" as const, state: interaction.state };
        const items = await trx
          .selectFrom("question_interaction_items")
          .selectAll()
          .where("interaction_id", "=", input.interactionId)
          .execute();
        if (
          items.length !== input.answers.length ||
          new Set(input.answers.map((answer) => answer.questionId)).size !== input.answers.length
        )
          return { kind: "invalid" as const, state: interaction.state };
        const parsedAnswers = input.answers.map((answer) => webChatQuestionAnswerSchema.safeParse(answer));
        for (const [index, parsed] of parsedAnswers.entries()) {
          const item = items.find((candidate) => candidate.question_id === input.answers[index]?.questionId);
          if (
            !item ||
            !parsed.success ||
            item.answered_at ||
            ("optionId" in parsed.data &&
              !parseJson<Array<{ id: string }>>(item.options_json).some(
                (option) => option.id === parsed.data.optionId,
              )) ||
            ("customResponse" in parsed.data && !item.allows_custom_response)
          )
            return { kind: "invalid" as const, state: interaction.state };
        }
        for (const [index, parsed] of parsedAnswers.entries()) {
          if (!parsed.success) continue;
          const itemUpdate = await trx
            .updateTable("question_interaction_items")
            .set({
              selected_option_id: "optionId" in parsed.data ? parsed.data.optionId : null,
              custom_response: "customResponse" in parsed.data ? parsed.data.customResponse : null,
              answered_by_principal_id: input.responderPrincipalId,
              answered_at: input.receivedAt,
            })
            .where("interaction_id", "=", input.interactionId)
            .where("question_id", "=", input.answers[index]?.questionId)
            .where("answered_at", "is", null)
            .executeTakeFirst();
          if (!Number(itemUpdate.numUpdatedRows)) throw new Error("Question interaction batch item became stale");
        }
        await addEvent(trx, {
          interactionId: input.interactionId,
          eventType: "batch_answer_submitted",
          actorPrincipalId: input.responderPrincipalId,
          inboundEventId: input.inboundEventId,
          payload: { answerCount: input.answers.length },
        });
        const interactionUpdate = await trx
          .updateTable("question_interactions")
          .set({
            state: "answered",
            active_scope_key: null,
            active_task_key: null,
            answered_at: input.receivedAt,
            updated_at: isoNow(),
          })
          .where("id", "=", input.interactionId)
          .where("state", "=", "pending")
          .executeTakeFirst();
        if (!Number(interactionUpdate.numUpdatedRows)) throw new Error("Question interaction batch became stale");
        return {
          kind: "answered" as const,
          state: "answered" as const,
          resumeWork: await resumeWork(trx, input.interactionId),
        };
      });
    },
    async getQuestionInteractionForResume(interactionId: string) {
      return resumeWork(db, interactionId);
    },
    async claimQuestionInteractionResume(interactionId: string) {
      return db.transaction().execute(async (trx) => {
        const interaction = await loadInteraction(trx, interactionId);
        if (!interaction || interaction.state !== "answered") return { kind: "not_ready" as const };
        const work = await resumeWork(trx, interactionId);
        if (!work) return { kind: "not_ready" as const };
        try {
          await trx
            .insertInto("question_interaction_events")
            .values({
              id: randomUUID(),
              interaction_id: interactionId,
              event_type: "resume_claimed",
              inbound_event_id: null,
              event_key: "resume-claimed",
              actor_principal_id: interaction.requester_principal_id,
              payload_json: JSON.stringify({}),
              created_at: isoNow(),
            })
            .execute();
        } catch (error) {
          const claim = await trx
            .selectFrom("question_interaction_events")
            .select("id")
            .where("interaction_id", "=", interactionId)
            .where("event_key", "=", "resume-claimed")
            .executeTakeFirst();
          if (claim) return { kind: "already_claimed" as const };
          throw error;
        }
        return { kind: "claimed" as const, resumeWork: work };
      });
    },
    async recordQuestionInteractionResumeResult(input: { interactionId: string; status: "completed" | "failed" }) {
      const interaction = await loadInteraction(db, input.interactionId);
      if (!interaction || interaction.state !== "answered") return false;
      const eventKey = input.status === "completed" ? "resume-completed" : `resume-failed:${randomUUID()}`;
      try {
        await addEvent(db, {
          interactionId: input.interactionId,
          eventType: input.status === "completed" ? "resume_completed" : "resume_failed",
          actorPrincipalId: interaction.requester_principal_id,
          inboundEventId: eventKey,
        });
        if (input.status === "failed") {
          await db
            .deleteFrom("question_interaction_events")
            .where("interaction_id", "=", input.interactionId)
            .where("event_key", "=", "resume-claimed")
            .execute();
        }
        return true;
      } catch (error) {
        const event = await db
          .selectFrom("question_interaction_events")
          .select("id")
          .where("interaction_id", "=", input.interactionId)
          .where("event_key", "=", eventKey)
          .executeTakeFirst();
        if (event) return false;
        throw error;
      }
    },
    async getQuestionInteractionSnapshot(interactionId: string) {
      return interactionSnapshot(db, interactionId);
    },
    async getQuestionInteractionSnapshotByPublicCode(input: {
      platform: "slack" | "whatsapp";
      conversationId: string;
      threadId: string | null;
      publicCode: string;
    }) {
      const interaction = await this.findActiveQuestionInteractionByPublicCode(input);
      return interaction ? interactionSnapshot(db, interaction.id) : undefined;
    },
    async getQuestionInteractionForDelivery(interactionId: string) {
      return loadInteraction(db, interactionId);
    },
    async findActiveQuestionInteractionByPublicCode(input: {
      platform: "slack" | "whatsapp";
      conversationId: string;
      threadId: string | null;
      publicCode: string;
    }) {
      let query = db
        .selectFrom("question_interactions")
        .selectAll()
        .where("platform", "=", input.platform)
        .where("conversation_id", "=", input.conversationId)
        .where("public_code", "=", input.publicCode.trim().toUpperCase())
        .where("state", "=", "pending");
      query =
        input.threadId === null ? query.where("thread_id", "is", null) : query.where("thread_id", "=", input.threadId);
      return query.executeTakeFirst();
    },
    async findPendingQuestionInteractionForTarget(input: {
      platform: "slack" | "whatsapp";
      conversationId: string;
      threadId: string | null;
      responderPrincipalId: string;
    }): Promise<({ kind: "found" } & PendingQuestionInteractionStepSnapshot) | { kind: "not_found" }> {
      let query = db
        .selectFrom("question_interactions")
        .selectAll()
        .where("platform", "=", input.platform)
        .where("conversation_id", "=", input.conversationId)
        .where("state", "=", "pending")
        .orderBy("created_at", "desc");
      query =
        input.threadId === null ? query.where("thread_id", "is", null) : query.where("thread_id", "=", input.threadId);
      const candidates = (await query.execute()).filter((interaction) =>
        parseJson<string[]>(interaction.eligible_responder_principal_ids_json).includes(input.responderPrincipalId),
      );
      const interaction =
        candidates.find((candidate) => candidate.requester_principal_id === input.responderPrincipalId) ??
        candidates[0];
      if (!interaction) return { kind: "not_found" };
      const item = await db
        .selectFrom("question_interaction_items")
        .selectAll()
        .where("interaction_id", "=", interaction.id)
        .where("answered_at", "is", null)
        .orderBy("ordinal")
        .executeTakeFirst();
      if (!item) return { kind: "not_found" };
      const snapshot = await interactionSnapshot(db, interaction.id);
      if (!snapshot) return { kind: "not_found" };
      return {
        kind: "found",
        interaction: snapshot,
        question: {
          questionId: item.question_id,
          prompt: item.prompt,
          options: parseJson(item.options_json),
          allowsCustomResponse: Boolean(item.allows_custom_response),
        },
        questionNumber: item.ordinal + 1,
        questionCount: snapshot.questions.length,
      };
    },
    async cancelQuestionInteraction(interactionId: string, actorPrincipalId: string, inboundEventId?: string) {
      return db.transaction().execute(async (trx) => {
        const interaction = await loadInteraction(trx, interactionId);
        if (
          !interaction ||
          !parseJson<string[]>(interaction.eligible_responder_principal_ids_json).includes(actorPrincipalId)
        )
          return false;
        if (inboundEventId) {
          const replay = await trx
            .selectFrom("question_interaction_events")
            .select("id")
            .where("interaction_id", "=", interactionId)
            .where("event_key", "=", eventKey(inboundEventId))
            .executeTakeFirst();
          if (replay) return true;
        }
        if (interaction.state !== "pending") return false;
        const updated = await trx
          .updateTable("question_interactions")
          .set({
            state: "cancelled",
            active_scope_key: null,
            active_task_key: null,
            cancelled_at: isoNow(),
            updated_at: isoNow(),
          })
          .where("id", "=", interactionId)
          .where("state", "=", "pending")
          .executeTakeFirst();
        if (!Number(updated.numUpdatedRows)) return false;
        await addEvent(trx, { interactionId, eventType: "cancelled", actorPrincipalId, inboundEventId });
        return true;
      });
    },
    async cancelPendingQuestionInteractionsForTarget(input: {
      platform: "web" | "slack" | "whatsapp";
      conversationId: string;
      threadId: string | null;
      requesterPrincipalId: string;
    }) {
      return db.transaction().execute(async (trx) => {
        let query = trx
          .selectFrom("question_interactions")
          .select(["id", "requester_principal_id"])
          .where("state", "=", "pending")
          .where("platform", "=", input.platform)
          .where("conversation_id", "=", input.conversationId)
          .where("requester_principal_id", "=", input.requesterPrincipalId);
        query =
          input.threadId === null
            ? query.where("thread_id", "is", null)
            : query.where("thread_id", "=", input.threadId);
        const pending = await query.execute();
        const cancelledIds: string[] = [];
        const now = isoNow();
        for (const interaction of pending) {
          const updated = await trx
            .updateTable("question_interactions")
            .set({
              state: "cancelled",
              active_scope_key: null,
              active_task_key: null,
              cancelled_at: now,
              updated_at: now,
            })
            .where("id", "=", interaction.id)
            .where("state", "=", "pending")
            .executeTakeFirst();
          if (!Number(updated.numUpdatedRows)) continue;
          cancelledIds.push(interaction.id);
          await addEvent(trx, {
            interactionId: interaction.id,
            eventType: "cancelled_for_target",
            actorPrincipalId: interaction.requester_principal_id,
          });
        }
        return { cancelledIds, count: cancelledIds.length };
      });
    },
    async expireDue(now = isoNow()) {
      const rows = await db
        .selectFrom("question_interactions")
        .select(["id", "requester_principal_id"])
        .where("state", "=", "pending")
        .where("expires_at", "<=", now)
        .execute();
      let expired = 0;
      for (const row of rows) {
        const update = await db
          .updateTable("question_interactions")
          .set({ state: "expired", active_scope_key: null, active_task_key: null, expired_at: now, updated_at: now })
          .where("id", "=", row.id)
          .where("state", "=", "pending")
          .executeTakeFirst();
        if (Number(update.numUpdatedRows)) {
          expired += 1;
          await addEvent(db, {
            interactionId: row.id,
            eventType: "expired",
            actorPrincipalId: row.requester_principal_id,
          });
        }
      }
      return expired;
    },
    async markQuestionInteractionDeliveryFailed(interactionId: string) {
      await db
        .updateTable("question_interactions")
        .set({ state: "delivery_failed", active_scope_key: null, active_task_key: null, updated_at: isoNow() })
        .where("id", "=", interactionId)
        .where("state", "=", "pending")
        .execute();
    },
  };
}

export type QuestionInteractionsRepository = ReturnType<typeof createQuestionInteractionsRepository>;
