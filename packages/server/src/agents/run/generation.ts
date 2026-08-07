import { join } from "node:path";
import { AgentRunAdmissionCancelledError } from "../../agent/concurrency-limiter";
import { buildSketchContext } from "../../agent/prompt";
import type { RunAgentParams, RunAgentResult } from "../../agent/runner";
import {
  type AgentOutputWriter,
  type WriteAgentOutputPayload,
  assertAgentOutputPayloadSize,
} from "../../agent/tools/agent-output";
import { ensureWorkspace } from "../../agent/workspace";
import type {
  AgentDeliveryConfig,
  AgentMasthead,
  AgentOutputItemInput,
  AgentRoute,
  AgentRouteDestination,
  AgentSourceConfig,
  PersistedAgentOutputItemRef,
} from "../../db/repositories/agent-outputs";
import { requireAgentDefinition } from "../registry";
import type { AgentDefinition } from "../types";
import { AgentDeliveryTargetError } from "./contracts";
import {
  addDays,
  deliveryPlatformForRoute,
  firstRunLookbackHoursForSchedule,
  rawPayloadWithRunMetadata,
} from "./output-utils";
import { AgentRunOutputLayer } from "./outputs";
import type { ScheduledRunAdmission } from "./queue";
import { enabledSectionsForScope, maxItemsPerSectionForScope, sourceAsDelivery } from "./routing";

const INTERNAL_OUTPUT_SECTION_ITEM_LIMIT = 25;
const AGENT_OUTPUT_WRITER_ERROR_LIMIT = 500;

function sanitizeAgentOutputWriterError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const collapsed = message.replace(/\s+/g, " ").trim() || "WriteAgentOutput failed.";
  return collapsed.length > AGENT_OUTPUT_WRITER_ERROR_LIMIT
    ? `${collapsed.slice(0, AGENT_OUTPUT_WRITER_ERROR_LIMIT - 1)}…`
    : collapsed;
}

export function pairPersistedVisibleItems(
  items: AgentOutputItemInput[],
  refs: PersistedAgentOutputItemRef[],
): Array<{ id: string; item: AgentOutputItemInput }> {
  if (items.length !== refs.length) {
    throw new Error(`Agent output persisted item mismatch: expected ${items.length}, received ${refs.length}.`);
  }
  return refs.map((ref, index) => {
    const item = items[index];
    if (!item || item.sectionKey !== ref.sectionKey || item.sortOrder !== ref.sortOrder) {
      throw new Error(`Agent output persisted item mismatch at index ${index}.`);
    }
    return { id: ref.id, item };
  });
}

export function validateAgentOutputLimits(input: {
  items: AgentOutputItemInput[];
  visibleSectionKeys: Set<string>;
  internalSectionKeys: Set<string>;
  maxItemsPerSection: number;
}): void {
  const counts = new Map<string, number>();
  let internalItemCount = 0;
  for (const item of input.items) {
    if (!input.visibleSectionKeys.has(item.sectionKey) && !input.internalSectionKeys.has(item.sectionKey)) continue;
    if (input.internalSectionKeys.has(item.sectionKey)) {
      internalItemCount += 1;
      continue;
    }
    counts.set(item.sectionKey, (counts.get(item.sectionKey) ?? 0) + 1);
  }
  if (internalItemCount > INTERNAL_OUTPUT_SECTION_ITEM_LIMIT) {
    throw new Error(
      `Agent output internal task sections (${[...input.internalSectionKeys].join(", ")}) exceed their shared 25-item limit.`,
    );
  }
  for (const [sectionKey, count] of counts) {
    const limit = input.maxItemsPerSection;
    if (count > limit) {
      throw new Error(`Agent output section ${sectionKey} exceeds its ${limit}-item limit.`);
    }
  }
}

export class AgentRunGenerationLayer extends AgentRunOutputLayer {
  protected async generateExistingOutput(
    agentKey: string,
    outputId: string,
    userId: string,
    scheduledAdmission?: ScheduledRunAdmission,
  ): Promise<void> {
    if (scheduledAdmission?.state === "promoted" || scheduledAdmission?.controller.signal.aborted) return;
    const def = requireAgentDefinition(agentKey);
    const output = await this.repo.findById(def.key, outputId);
    const user = await this.deps.users.findById(userId);
    if (!output || !user) return;

    let writeAttempted = false;
    let lastWriteError: string | null = null;
    let lastWriteErrorAfterPersistence = false;
    let saved = false;
    const config = await this.resolveConfig(def, user.id);
    const scope = await this.resolveScopeForOutput(def, user, config, output);
    if (!scope) {
      await this.repo.markFailed(outputId, "Generation route was removed.");
      return;
    }
    const routeSections = enabledSectionsForScope(def, config, scope.route);
    const routeMaxItemsPerSection = maxItemsPerSectionForScope(def, config, scope.route);
    const routeFocus = scope.route ? scope.route.focus : config.focus;
    const firstRunLookbackHours = firstRunLookbackHoursForSchedule(scope.route?.schedule);
    const enabledSections = def.sections.filter((s) => routeSections[s.key]).map((s) => s.key);

    try {
      const now = new Date();
      const settings = await this.deps.settings.get();
      const adminCanReadAllFiles = settings?.admin_can_read_all_files === 1;
      const contentUserEmails =
        user.auth_role === "admin" && adminCanReadAllFiles
          ? undefined
          : await this.deps.users.getAllEmailsForUser(user.id);
      const [sameDayPrevious, previousDay, definitionContext] = await Promise.all([
        this.getPreviousOutputForContext(def, user, output.output_date, scope),
        this.getPreviousOutputForContext(def, user, addDays(output.output_date, -1), scope),
        def.buildRuntimeContext
          ? def.buildRuntimeContext({
              db: this.deps.db,
              user,
              outputDate: output.output_date,
              timezone: output.timezone,
              now,
              adminCanReadAllFiles,
              contentUserEmails,
              slackEntitySyncEnabled: this.deps.config.SLACK_ENTITY_SYNC,
              agentConfig: {
                enabledSections: routeSections,
                maxItemsPerSection: routeMaxItemsPerSection,
                focus: routeFocus,
                delivery: config.delivery,
                sources: scope.sources,
                sourceKey: scope.sourceKey,
                routeId: scope.route?.id ?? scope.sourceKey,
                firstRunLookbackHours,
                floorWindowToPeriod: output.trigger_type === "manual",
                deliveryPlatform: deliveryPlatformForRoute(scope.route, scope.sources),
                createTasks: config.createTasks,
              },
            })
          : Promise.resolve({}),
      ]);
      const runtimeContext: Record<string, unknown> = {
        agentKey: def.key,
        agentVersion: def.version,
        outputId,
        outputDate: output.output_date,
        timezone: output.timezone,
        user: { id: user.id, name: user.name, email: user.email },
        sections: enabledSections,
        maxItemsPerSection: routeMaxItemsPerSection,
        focus: routeFocus,
        sources: scope.sources,
        createTasks: config.createTasks,
        sameDayPreviousOutput: this.formatOutputForContext(sameDayPrevious),
        previousDayOutput: this.formatOutputForContext(previousDay),
        ...definitionContext,
      };
      if (def.augmentRuntimeContext) {
        Object.assign(
          runtimeContext,
          await def.augmentRuntimeContext({
            db: this.deps.db,
            config: this.deps.config,
            userId: user.id,
            users: this.deps.users,
            maxItemsPerSection: config.maxItemsPerSection,
            baseContext: runtimeContext,
          }),
        );
      }
      const writer = this.createWriter(def, {
        outputId,
        userId: user.id,
        enabledSections: new Set(enabledSections),
        maxItemsPerSection: routeMaxItemsPerSection,
        expectedOutputDate: output.output_date,
        expectedTimezone: output.timezone,
        runtimeContext,
        createTasks: config.createTasks,
        onAttempt: () => {
          writeAttempted = true;
        },
        onRejected: (error, afterPersistence) => {
          if (lastWriteErrorAfterPersistence && !afterPersistence) return;
          lastWriteError = sanitizeAgentOutputWriterError(error);
          lastWriteErrorAfterPersistence = afterPersistence;
        },
        onSaved: () => {
          saved = true;
        },
      });
      const userMessage = buildSketchContext({
        messages: [],
        currentUserName: user.name,
        currentUserEmail: user.email,
        currentMessage: [
          `Generate today's ${def.title} using the runtime context below.`,
          "Use tools to inspect the knowledge graph and then call WriteAgentOutput.",
          "",
          "Runtime context:",
          JSON.stringify(runtimeContext, null, 2),
        ].join("\n"),
        workspaceDir: await ensureWorkspace(this.deps.config, user.id),
        orgDir: this.deps.config.CLAUDE_CONFIG_DIR,
        timezone: output.timezone,
      });
      const integrationMcpServers = this.deps.buildMcpServers ? await this.deps.buildMcpServers(user.email) : {};
      const workspaceDir = join(this.deps.config.DATA_DIR, "workspaces", user.id);
      const agentParams: RunAgentParams = {
        db: this.deps.db,
        workspaceKey: user.id,
        userMessage,
        workspaceDir,
        claudeConfigDir: this.deps.config.CLAUDE_CONFIG_DIR,
        userName: user.name,
        userEmail: user.email,
        logger: this.deps.logger,
        platform: "slack",
        responseSurface: "web",
        onProgressEvent: async () => {},
        integrationMcpServers,
        loadIntegrationProvider: this.deps.loadIntegrationProvider,
        sessionMode: "fresh",
        persistSession: false,
        contextType: "scheduled_task",
        currentUserId: user.id,
        userRepo: this.deps.users,
        maxTurns: 35,
        agentInstructions: def.buildInstructions(),
        agentAllowedTools: def.allowedTools,
        agentOutputWriter: writer,
      };
      let result: RunAgentResult;
      if (output.trigger_type === "scheduled" && scheduledAdmission) {
        result = await this.deps.runScheduledAgent(agentParams, {
          signal: scheduledAdmission.controller.signal,
          onStart: () => {
            if (scheduledAdmission.state === "queued") scheduledAdmission.state = "active";
          },
        });
      } else {
        result = await this.deps.runAgent(agentParams);
      }
      if (!saved) {
        if (writeAttempted) {
          await this.repo.markWriteFailed(outputId, lastWriteError ?? "WriteAgentOutput failed.");
        } else {
          await this.repo.markFailed(outputId, "Agent did not call WriteAgentOutput.");
        }
      } else {
        await this.deps.db
          .updateTable("agent_outputs")
          .set({ agent_run_id: result.sessionId || null })
          .where("id", "=", outputId)
          .execute();
        await this.deliverCompletedOutput(def, outputId, user.id);
      }
    } catch (err) {
      if (err instanceof AgentRunAdmissionCancelledError) return;
      const message =
        !saved && writeAttempted && lastWriteError ? lastWriteError : err instanceof Error ? err.message : String(err);
      if (!saved && writeAttempted) {
        await this.repo.markWriteFailed(outputId, message);
      } else {
        await this.repo.markFailed(outputId, message);
      }
      this.deps.logger.error({ err, agentKey, outputId, userId }, "Agent: generation failed");
    }
  }

  private async deliverCompletedOutput(def: AgentDefinition, outputId: string, userId: string): Promise<void> {
    if (!this.deps.outputDelivery) return;
    let markFailedOnRouteTargetError = false;
    try {
      const output = await this.repo.findById(def.key, outputId);
      const user = await this.deps.users.findById(userId);
      if (!output || !user) return;
      const config = await this.resolveConfig(def, userId);
      const scope = await this.resolveScopeForOutput(def, user, config, output);
      if (!scope) return;
      let delivery: AgentDeliveryConfig | null;
      if (scope.route) {
        markFailedOnRouteTargetError = true;
        delivery = await this.deliveryForRoute(userId, scope.route, scope.sources);
      } else {
        delivery = await this.resolveDeliveryConfigForUser(userId, config.delivery);
      }
      if (!delivery) return;
      const completed = await this.getByIdForUser(def.key, outputId, userId);
      if (!completed) return;
      await this.deps.outputDelivery.deliver({ definition: def, output: completed, delivery });
    } catch (err) {
      if (markFailedOnRouteTargetError && err instanceof AgentDeliveryTargetError) {
        await this.repo.markDeliveryFailed(outputId, err.message);
      }
      this.deps.logger.warn({ err, agentKey: def.key, outputId, userId }, "Agent: output delivery failed");
    }
  }

  private async deliveryForRoute(
    userId: string,
    route: AgentRoute,
    resolvedSources: AgentSourceConfig[],
  ): Promise<AgentDeliveryConfig | null> {
    if (route.destination.kind === "off") return null;
    if (route.destination.kind === "member") {
      return this.resolveMemberRouteDelivery(route.destination, resolvedSources);
    }
    if (route.destination.kind === "channel") {
      return this.resolveChannelRouteDelivery(route.destination);
    }
    if (resolvedSources.length !== 1) {
      throw new AgentDeliveryTargetError("Combined routes cannot use self destination");
    }
    const [source] = resolvedSources;
    if (source.targetType !== "dm") {
      return this.resolveDeliveryConfigForUser(userId, sourceAsDelivery(source));
    }
    const user = await this.deps.users.findById(userId);
    if (!user) throw new AgentDeliveryTargetError("User not found");
    if (source.platform === "slack") {
      if (!user.slack_user_id) throw new AgentDeliveryTargetError("Slack delivery is not available for this user");
      return this.resolveDeliveryConfigForUser(userId, {
        enabled: true,
        platform: "slack",
        targetType: "dm",
        targetId: user.slack_user_id,
        label: user.name,
      });
    }
    if (!user.whatsapp_number) {
      throw new AgentDeliveryTargetError("WhatsApp delivery is not available for this user");
    }
    return {
      enabled: true,
      platform: "whatsapp",
      targetType: "dm",
      targetId: user.whatsapp_number,
      label: user.name,
      recipientUserId: user.id,
    };
  }

  private async resolveMemberRouteDelivery(
    destination: Extract<AgentRouteDestination, { kind: "member" }>,
    resolvedSources: AgentSourceConfig[],
  ): Promise<AgentDeliveryConfig> {
    const member = await this.deps.users.findById(destination.memberUserId);

    if (destination.platform === "whatsapp") {
      if (!member?.whatsapp_number) {
        throw new AgentDeliveryTargetError("Recipient has no WhatsApp number");
      }
      return {
        enabled: true,
        platform: "whatsapp",
        targetType: "dm",
        targetId: member.whatsapp_number,
        label: member.name,
        recipientUserId: member.id,
      };
    }

    if (!member?.slack_user_id) {
      throw new AgentDeliveryTargetError("Recipient is not available for Slack delivery");
    }

    const slack = this.deps.getSlack?.() ?? null;
    if (!slack) throw new AgentDeliveryTargetError("Slack is not connected");

    for (const source of resolvedSources) {
      if (
        source.platform !== "slack" ||
        source.targetType !== "channel" ||
        !(await slack.isUserInChannel(source.targetId, member.slack_user_id))
      ) {
        throw new AgentDeliveryTargetError("Recipient is not a member of every source");
      }
    }

    return {
      enabled: true,
      platform: "slack",
      targetType: "dm",
      targetId: member.slack_user_id,
      label: member.name,
    };
  }

  private async resolveChannelRouteDelivery(
    destination: Extract<AgentRouteDestination, { kind: "channel" }>,
  ): Promise<AgentDeliveryConfig> {
    if (destination.platform === "slack") {
      const slack = this.deps.getSlack?.() ?? null;
      if (!slack) throw new AgentDeliveryTargetError("Slack is not connected");

      const channel = (await slack.listChannels()).find((candidate) => candidate.id === destination.targetId);
      if (!channel?.isMember) {
        throw new AgentDeliveryTargetError("Slack channel is not available for delivery");
      }
      return {
        enabled: true,
        platform: "slack",
        targetType: "channel",
        targetId: channel.id,
        label: `#${channel.name}`,
      };
    }

    const group = await this.deps.db
      .selectFrom("whatsapp_groups")
      .select(["jid", "name"])
      .where("jid", "=", destination.targetId)
      .executeTakeFirst();
    if (!group) throw new AgentDeliveryTargetError("WhatsApp group is not available for delivery");

    const whatsapp = this.deps.getWhatsApp?.() ?? null;
    if (!whatsapp) throw new AgentDeliveryTargetError("WhatsApp is not connected");

    return {
      enabled: true,
      platform: "whatsapp",
      targetType: "group",
      targetId: group.jid,
      label: group.name ?? destination.label ?? null,
    };
  }

  private createWriter(
    def: AgentDefinition,
    params: {
      outputId: string;
      userId: string;
      enabledSections: Set<string>;
      maxItemsPerSection: number;
      expectedOutputDate: string;
      expectedTimezone: string;
      runtimeContext: Record<string, unknown>;
      createTasks: boolean;
      onAttempt: () => void;
      onRejected: (error: unknown, afterPersistence: boolean) => void;
      onSaved: () => void;
    },
  ): AgentOutputWriter {
    return {
      recordRejectedAttempt: (error) => {
        params.onAttempt();
        params.onRejected(error, false);
      },
      write: async (payload: {
        outputDate: string;
        timezone: string;
        masthead: AgentMasthead;
        rawPayload: WriteAgentOutputPayload;
        items: AgentOutputItemInput[];
      }) => {
        params.onAttempt();
        let outputPersisted = false;
        try {
          if (payload.outputDate !== params.expectedOutputDate) {
            throw new Error(`Output date mismatch: expected ${params.expectedOutputDate}, got ${payload.outputDate}`);
          }
          if (payload.timezone !== params.expectedTimezone) {
            throw new Error(`Timezone mismatch: expected ${params.expectedTimezone}, got ${payload.timezone}`);
          }
          const visibleSectionKeys = new Set(def.sections.map((s) => s.key));
          const internalSectionKeys = new Set(def.internalOutputSections ?? []);
          const filtered = payload.items.filter(
            (item) =>
              (visibleSectionKeys.has(item.sectionKey) && params.enabledSections.has(item.sectionKey)) ||
              internalSectionKeys.has(item.sectionKey),
          );
          validateAgentOutputLimits({
            items: filtered,
            visibleSectionKeys,
            internalSectionKeys,
            maxItemsPerSection: params.maxItemsPerSection,
          });
          const reconciled = def.reconcileItems
            ? await def.reconcileItems({ db: this.deps.db, items: filtered, runtimeContext: params.runtimeContext })
            : filtered;
          const itemsForHooks = await def.enrichItems(this.deps.db, reconciled);
          validateAgentOutputLimits({
            items: itemsForHooks,
            visibleSectionKeys,
            internalSectionKeys,
            maxItemsPerSection: params.maxItemsPerSection,
          });
          const visibleItems = itemsForHooks.filter(
            (item) => visibleSectionKeys.has(item.sectionKey) && params.enabledSections.has(item.sectionKey),
          );
          await this.validateItemRefs(def, itemsForHooks);
          const rawPayload = rawPayloadWithRunMetadata(payload.rawPayload, params.runtimeContext);
          assertAgentOutputPayloadSize(rawPayload);
          const persistedRefs = await this.repo.completeOutput({
            outputId: params.outputId,
            masthead: payload.masthead,
            rawPayload,
            items: visibleItems,
          });
          outputPersisted = true;
          const persistedItems = pairPersistedVisibleItems(visibleItems, persistedRefs);
          if (def.onOutputSaved) {
            await def.onOutputSaved({
              db: this.deps.db,
              config: this.deps.config,
              logger: this.deps.logger,
              userId: params.userId,
              outputId: params.outputId,
              items: itemsForHooks,
              persistedItems,
              createTasks: params.createTasks,
              runtimeContext: params.runtimeContext,
            });
          }
          params.onSaved();
        } catch (error) {
          params.onRejected(error, outputPersisted);
          throw error;
        }
      },
    };
  }

  private async validateItemRefs(def: AgentDefinition, items: AgentOutputItemInput[]): Promise<void> {
    const errors: string[] = [];
    for (const item of items) {
      const serverOwnedFollowup =
        item.structuredPayload?.serverOwnedFollowup === true &&
        (item.sectionKey === "looks_resolved" || item.sectionKey === "untracked_followups");
      if (
        def.requiresKnowledgeRefs &&
        !serverOwnedFollowup &&
        item.knowledgeRefs.entityIds.length + item.knowledgeRefs.fileIds.length === 0
      ) {
        errors.push(`${item.sectionKey}:${item.title} has no entityIds or fileIds`);
      }
      const entityCount = await this.repo.countKnownEntities(item.knowledgeRefs.entityIds);
      if (entityCount !== item.knowledgeRefs.entityIds.length) {
        errors.push(`${item.sectionKey}:${item.title} references unknown entityIds`);
      }
      const fileCount = await this.repo.countKnownFiles(item.knowledgeRefs.fileIds);
      if (fileCount !== item.knowledgeRefs.fileIds.length) {
        errors.push(`${item.sectionKey}:${item.title} references unknown fileIds`);
      }
    }
    if (errors.length > 0) throw new Error(`Agent output validation failed:\n${errors.join("\n")}`);
  }
}
