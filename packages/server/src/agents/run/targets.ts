import { areJidsSameUser } from "@whiskeysockets/baileys";
import type {
  AgentDeliveryConfig,
  AgentDeliveryMention,
  AgentDeliveryModel,
  AgentRoute,
  AgentRouteDestination,
  AgentSourceConfig,
  AgentSourceKey,
} from "../../db/repositories/agent-outputs";
import type { NormalizedGroupMetadata } from "../../whatsapp/facade-contract";
import { getAgentDefinition, requireAgentDefinition } from "../registry";
import type { AgentDefinition, AgentSourceConfigDef } from "../types";
import { AgentRunConfigLayer } from "./config";
import {
  AgentDeliveryTargetError,
  type AgentRouteMember,
  AgentSourceTargetError,
  type AgentViewerRole,
  type AgentWhatsAppDmMember,
  type ResolvedRoute,
} from "./contracts";
import {
  decodeOrgRouteId,
  deliveryKeyForTarget,
  isDmDelivery,
  normalizeRouteDestination,
  normalizeRouteSchedule,
  parseSourceKey,
  reconcileDeliveryModel,
  routeIdForSources,
  routeScopeKeyForSources,
  scopeKeyForRoute,
  sourceKeyForTarget,
} from "./routing";

function whatsappNumberToJid(whatsappNumber: string): string {
  return `${normalizeWhatsappNumber(whatsappNumber)}@s.whatsapp.net`;
}

function normalizeWhatsappNumber(whatsappNumber: string): string {
  return whatsappNumber.replace(/^\+/, "");
}

function normalizeWhatsappMentionTarget(targetId: string): string {
  if (targetId.startsWith("dm:+")) return targetId.slice("dm:".length);
  if (targetId.startsWith("+")) return targetId;
  if (targetId.endsWith("@s.whatsapp.net")) {
    return `+${normalizeWhatsappNumber(targetId.replace("@s.whatsapp.net", ""))}`;
  }
  if (/^\d+$/.test(targetId)) return `+${targetId}`;
  return targetId;
}

async function whatsappGroupHasParticipant(
  group: NormalizedGroupMetadata | null,
  whatsappNumber: string,
  resolveLid?: (jid: string) => Promise<string | null>,
): Promise<boolean> {
  const userJid = whatsappNumberToJid(whatsappNumber);
  const userNumber = normalizeWhatsappNumber(whatsappNumber);

  for (const participant of group?.participants ?? []) {
    if (areJidsSameUser(participant.jid, userJid)) return true;
    if (participant.phoneE164 && normalizeWhatsappNumber(participant.phoneE164) === userNumber) return true;

    const participantPhoneJid = await resolveLid?.(participant.jid);
    if (participantPhoneJid && areJidsSameUser(participantPhoneJid, userJid)) return true;
  }

  return false;
}

function withMentions(mentions: AgentDeliveryMention[]): Pick<AgentDeliveryConfig, "mentions"> {
  return mentions.length > 0 ? { mentions } : {};
}

export class AgentRunTargetLayer extends AgentRunConfigLayer {
  protected resolveDeliveryModelForUser(
    sources: AgentSourceConfig[],
    deliveryModel: AgentDeliveryModel,
  ): AgentDeliveryModel {
    const reconciled = reconcileDeliveryModel(deliveryModel, sources);
    if (reconciled.mode === "per_source") return reconciled;

    const deliveryKey = deliveryKeyForTarget(reconciled.combined);
    if (sources.some((source) => sourceKeyForTarget(source) === deliveryKey)) {
      throw new AgentDeliveryTargetError("Combined delivery cannot target one of the selected sources");
    }
    if (!isDmDelivery(reconciled.combined) && reconciled.combined.ackNonDm !== true) {
      throw new AgentDeliveryTargetError("Non-DM combined delivery requires acknowledgement");
    }

    return reconciled;
  }

  protected resolveRoutesForUser(
    def: AgentDefinition,
    sources: AgentSourceConfig[],
    routes: AgentRoute[],
  ): AgentRoute[] {
    const sourceKeys = new Set(sources.map(sourceKeyForTarget));
    const sectionKeys = new Set(def.sections.map((section) => section.key));
    const range = def.itemsPerSectionRange;
    const seenScopeKeys = new Set<string>();

    return routes.map((route) => {
      const sources = [...new Set(route.sources)];
      if (sources.length === 0) {
        throw new AgentSourceTargetError("Route must include at least one source");
      }
      if (sources.length > 1 && route.destination.kind === "self") {
        throw new AgentDeliveryTargetError("Combined routes cannot use self destination");
      }
      let destination = route.destination;
      if (route.destination.kind === "member") {
        const raw = route.destination as Record<string, unknown>;
        const memberUserId = typeof raw.memberUserId === "string" ? raw.memberUserId.trim() : "";
        if ((raw.platform !== "slack" && raw.platform !== "whatsapp") || !memberUserId) {
          throw new AgentDeliveryTargetError("Member route destination must include a Slack or WhatsApp member");
        }
        destination = { kind: "member", platform: raw.platform, memberUserId };
      }
      if (route.destination.kind === "channel") {
        const normalized = normalizeRouteDestination(route.destination);
        if (!normalized || normalized.kind !== "channel") {
          throw new AgentDeliveryTargetError(
            "Channel route destination must include a valid Slack channel or WhatsApp group",
          );
        }
        if (sources.length > 1 && sources.includes(deliveryKeyForTarget(normalized) as AgentSourceKey)) {
          throw new AgentDeliveryTargetError("Combined routes cannot deliver to one of the selected sources");
        }
        destination = normalized;
      }
      for (const sourceKey of sources) {
        if (!sourceKeys.has(sourceKey)) {
          throw new AgentSourceTargetError("Route source must be one of the selected sources");
        }
      }
      for (const sectionKey of Object.keys(route.sections ?? {})) {
        if (!sectionKeys.has(sectionKey)) throw new AgentSourceTargetError(`Unknown route section: ${sectionKey}`);
      }
      const schedule = normalizeRouteSchedule(route.schedule);
      if (route.schedule && !schedule) throw new AgentSourceTargetError("Route schedule must be valid");
      const scopeKey = routeScopeKeyForSources(sources);
      if (seenScopeKeys.has(scopeKey)) {
        throw new AgentSourceTargetError("Routes must not duplicate the same output scope");
      }
      seenScopeKeys.add(scopeKey);

      return {
        ...route,
        id: route.id.trim() || routeIdForSources(sources),
        sources,
        focus: route.focus?.trim() ? route.focus.trim() : null,
        sections: route.sections ? { ...route.sections } : null,
        maxItemsPerSection:
          route.maxItemsPerSection === null ? null : Math.min(range.max, Math.max(range.min, route.maxItemsPerSection)),
        schedule,
        destination,
        enabled: route.enabled !== false,
      };
    });
  }

  async resolveDeliveryConfigForUser(
    userId: string,
    delivery: AgentDeliveryConfig | null,
  ): Promise<AgentDeliveryConfig | null> {
    if (!delivery) return null;

    const user = await this.deps.users.findById(userId);
    if (!user) throw new AgentDeliveryTargetError("User not found");

    if (delivery.platform === "slack") {
      if (!user.slack_user_id) {
        throw new AgentDeliveryTargetError("Slack delivery is not available for this user");
      }

      const slack = this.deps.getSlack?.() ?? null;
      if (!slack) throw new AgentDeliveryTargetError("Slack is not connected");

      if (delivery.targetType === "dm") {
        if (delivery.targetId !== user.slack_user_id) {
          throw new AgentDeliveryTargetError("Slack DM delivery must target the current user");
        }
        const normalized = {
          ...delivery,
          targetId: user.slack_user_id,
          label: user.email ? `${user.name} <${user.email}>` : user.name,
        };
        return {
          ...normalized,
          ...withMentions(await this.resolveDeliveryMentions(normalized)),
        };
      }

      const channel = (await slack.listChannels()).find((candidate) => candidate.id === delivery.targetId);
      if (!channel?.isMember) {
        throw new AgentDeliveryTargetError("Slack channel is not available for delivery");
      }
      if (!(await slack.isUserInChannel(delivery.targetId, user.slack_user_id))) {
        throw new AgentDeliveryTargetError("Slack channel is not available for this user");
      }
      const normalized = {
        ...delivery,
        targetId: channel.id,
        label: `#${channel.name}`,
      };
      return {
        ...normalized,
        ...withMentions(await this.resolveDeliveryMentions(normalized)),
      };
    }

    const group = await this.deps.db
      .selectFrom("whatsapp_groups")
      .select(["jid", "name"])
      .where("jid", "=", delivery.targetId)
      .executeTakeFirst();
    if (!group) throw new AgentDeliveryTargetError("WhatsApp group is not available for delivery");
    if (!user.whatsapp_number) {
      throw new AgentDeliveryTargetError("WhatsApp group delivery is not available for this user");
    }

    const whatsapp = this.deps.getWhatsApp?.() ?? null;
    if (!whatsapp) throw new AgentDeliveryTargetError("WhatsApp is not connected");
    const groupMetadata = await whatsapp.groupMetadata(group.jid, { refresh: false });
    if (
      !(await whatsappGroupHasParticipant(
        groupMetadata,
        user.whatsapp_number,
        async (jid) => (await whatsapp.resolveLid?.(jid)) ?? null,
      ))
    ) {
      throw new AgentDeliveryTargetError("WhatsApp group is not available for this user");
    }

    const normalized = {
      ...delivery,
      targetId: group.jid,
      label: group.name,
    };
    return {
      ...normalized,
      ...withMentions(await this.resolveDeliveryMentions(normalized, { whatsappGroup: groupMetadata })),
    };
  }

  async listEligibleRouteMembers(userId: string, sourceKeys: string[]): Promise<AgentRouteMember[]> {
    const sources = [...new Set(sourceKeys)].map((sourceKey) => parseSourceKey(sourceKey as AgentSourceKey));
    if (sources.length === 0 || sources.some((source) => source.platform !== "slack")) return [];
    const slack = this.deps.getSlack?.() ?? null;
    if (!slack) return [];
    const requester = await this.deps.users.findById(userId);
    if (!requester?.slack_user_id) return [];
    for (const source of sources) {
      if (source.targetType !== "channel" || !(await slack.isUserInChannel(source.targetId, requester.slack_user_id))) {
        return [];
      }
    }

    const members: AgentRouteMember[] = [];
    for (const user of await this.deps.users.list()) {
      if (!user.slack_user_id) continue;
      let eligible = true;
      for (const source of sources) {
        if (source.targetType !== "channel" || !(await slack.isUserInChannel(source.targetId, user.slack_user_id))) {
          eligible = false;
          break;
        }
      }
      if (eligible) members.push({ userId: user.id, name: user.name, slackUserId: user.slack_user_id });
    }

    return members;
  }

  async listEligibleRouteMembersForViewer(
    agentKey: string,
    userId: string,
    role: AgentViewerRole,
    sourceKeys: string[],
    routeId?: string | null,
  ): Promise<AgentRouteMember[]> {
    if (!this.usesOrgWideSummarizerView(agentKey, role)) {
      const configUserId = await this.resolveConfigControlUserId(agentKey, userId, role);
      return this.listEligibleRouteMembers(configUserId, sourceKeys);
    }
    const decoded = routeId ? decodeOrgRouteId(routeId) : null;
    if (decoded) return this.listEligibleRouteMembers(decoded.ownerUserId, sourceKeys);

    const normalizedSourceKeys = [...new Set(sourceKeys)].sort();
    const owners = await this.repo.listHumanConfigs(agentKey);
    for (const owner of owners) {
      const config = await this.resolveConfig(requireAgentDefinition(agentKey), owner.userId);
      const match = config.configuredRoutes.find((route) => {
        const routeSources = [...new Set(route.sources)].sort();
        return (
          routeSources.length === normalizedSourceKeys.length &&
          routeSources.every((source, index) => source === normalizedSourceKeys[index])
        );
      });
      if (match) return this.listEligibleRouteMembers(owner.userId, sourceKeys);
    }
    return this.listEligibleRouteMembers(userId, sourceKeys);
  }

  async listWhatsAppDmMembers(): Promise<AgentWhatsAppDmMember[]> {
    const members: AgentWhatsAppDmMember[] = [];
    for (const user of await this.deps.users.list()) {
      if (user.type === "agent" || !user.whatsapp_number) continue;
      members.push({ userId: user.id, name: user.name });
    }
    return members;
  }

  private async resolveDeliveryMentions(
    delivery: AgentDeliveryConfig,
    context: { whatsappGroup?: NormalizedGroupMetadata | null } = {},
  ): Promise<AgentDeliveryMention[]> {
    const mentions = delivery.mentions ?? [];
    if (mentions.length === 0) return [];

    const resolved: AgentDeliveryMention[] = [];
    const seen = new Set<string>();

    for (const mention of mentions) {
      if (mention.platform !== delivery.platform) {
        throw new AgentDeliveryTargetError("Delivery mention platform must match the delivery platform");
      }

      if (mention.platform === "slack") {
        const user = await this.deps.users.findBySlackId(mention.targetId);
        if (!user || user.type === "agent" || !user.slack_user_id) {
          throw new AgentDeliveryTargetError("Slack mention target is not available");
        }
        if (delivery.targetType === "channel") {
          const slack = this.deps.getSlack?.() ?? null;
          if (!slack) throw new AgentDeliveryTargetError("Slack is not connected");
          if (!(await slack.isUserInChannel(delivery.targetId, user.slack_user_id))) {
            throw new AgentDeliveryTargetError("Slack mention target is not in the delivery channel");
          }
        }
        const key = `${mention.platform}:${user.slack_user_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        resolved.push({
          platform: "slack",
          targetId: user.slack_user_id,
          label: user.email ? `${user.name} <${user.email}>` : user.name,
        });
        continue;
      }

      const whatsappNumber = normalizeWhatsappMentionTarget(mention.targetId);
      const user = await this.deps.users.findByWhatsappNumber(whatsappNumber);
      if (!user || user.type === "agent" || !user.whatsapp_number) {
        throw new AgentDeliveryTargetError("WhatsApp mention target is not available");
      }
      if (delivery.targetType === "group") {
        const whatsapp = this.deps.getWhatsApp?.() ?? null;
        if (!whatsapp) throw new AgentDeliveryTargetError("WhatsApp is not connected");
        const group = context.whatsappGroup ?? (await whatsapp.groupMetadata(delivery.targetId, { refresh: false }));
        if (
          !(await whatsappGroupHasParticipant(
            group,
            user.whatsapp_number,
            async (jid) => (await whatsapp.resolveLid?.(jid)) ?? null,
          ))
        ) {
          throw new AgentDeliveryTargetError("WhatsApp mention target is not in the delivery group");
        }
      }
      const key = `${mention.platform}:${user.whatsapp_number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      resolved.push({ platform: "whatsapp", targetId: user.whatsapp_number, label: user.name });
    }

    return resolved;
  }

  async resolveSourceConfigsForUser(
    agentKeyOrDef: string | AgentDefinition,
    userId: string,
    sources: AgentSourceConfig[],
  ): Promise<AgentSourceConfig[]> {
    const def = typeof agentKeyOrDef === "string" ? getAgentDefinition(agentKeyOrDef) : agentKeyOrDef;
    if (!def?.sourceConfig) {
      if (sources.length > 0) throw new AgentSourceTargetError("This agent does not support conversation sources");
      return [];
    }
    if (sources.length > def.sourceConfig.maxSources) {
      throw new AgentSourceTargetError(`Select at most ${def.sourceConfig.maxSources} sources`);
    }

    const resolved: AgentSourceConfig[] = [];
    const seen = new Set<string>();
    for (const source of sources) {
      const normalized = await this.resolveSourceConfigForUser(userId, source, def.sourceConfig);
      const key = `${normalized.platform}:${normalized.targetType}:${normalized.targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      resolved.push(normalized);
    }
    return resolved;
  }

  private async resolveSourceConfigForUser(
    userId: string,
    source: AgentSourceConfig,
    config: AgentSourceConfigDef,
  ): Promise<AgentSourceConfig> {
    const user = await this.deps.users.findById(userId);
    if (!user) throw new AgentSourceTargetError("User not found");

    if (source.platform === "slack") {
      if (source.targetType === "dm") {
        if (!config.supportsSlackDms) throw new AgentSourceTargetError("Slack DM sources are not supported");
        const resolved = await this.repo.findDmSourceForUser(userId, "slack", source.targetId);
        if (!resolved) throw new AgentSourceTargetError("DM source is not available for this user");
        return resolved;
      }
      if (!config.supportsSlackChannels || source.targetType !== "channel") {
        throw new AgentSourceTargetError("Slack sources must be channels");
      }
      if (!user.slack_user_id) throw new AgentSourceTargetError("Slack sources are not available for this user");
      const slack = this.deps.getSlack?.() ?? null;
      if (!slack) throw new AgentSourceTargetError("Slack is not connected");
      const channel = (await slack.listChannels()).find((candidate) => candidate.id === source.targetId);
      if (!channel?.isMember) throw new AgentSourceTargetError("Slack channel is not available as a source");
      if (!(await slack.isUserInChannel(source.targetId, user.slack_user_id))) {
        throw new AgentSourceTargetError("Slack channel is not available for this user");
      }
      return {
        platform: "slack",
        targetType: "channel",
        targetId: channel.id,
        label: `#${channel.name}`,
      };
    }

    if (source.targetType === "dm") {
      if (!config.supportsWhatsAppDms) throw new AgentSourceTargetError("WhatsApp DM sources are not supported");
      const resolved = await this.repo.findDmSourceForUser(userId, "whatsapp", source.targetId);
      if (!resolved) throw new AgentSourceTargetError("DM source is not available for this user");
      return resolved;
    }
    if (!config.supportsWhatsAppGroups || source.targetType !== "group") {
      throw new AgentSourceTargetError("WhatsApp sources must be groups");
    }
    const group = await this.deps.db
      .selectFrom("whatsapp_groups")
      .select(["jid", "name"])
      .where("jid", "=", source.targetId)
      .executeTakeFirst();
    if (!group) throw new AgentSourceTargetError("WhatsApp group is not available as a source");
    if (!this.deps.getWhatsApp?.()) throw new AgentSourceTargetError("WhatsApp is not connected");
    return {
      platform: "whatsapp",
      targetType: "group",
      targetId: group.jid,
      label: group.name,
    };
  }

  protected async listAvailableSourcesForUser(def: AgentDefinition, userId: string): Promise<AgentSourceConfig[]> {
    if (!def.sourceConfig || (!def.sourceConfig.supportsSlackDms && !def.sourceConfig.supportsWhatsAppDms)) return [];
    const sources = await this.repo.listDmSourceOptionsForUser(userId);
    return sources.filter(
      (source) =>
        (source.platform === "slack" && def.sourceConfig?.supportsSlackDms) ||
        (source.platform === "whatsapp" && def.sourceConfig?.supportsWhatsAppDms),
    );
  }

  private async resolveSourcesForRun(
    def: AgentDefinition,
    userId: string,
    sources: AgentSourceConfig[],
  ): Promise<AgentSourceConfig[]> {
    if (!def.sourceConfig) return [];

    const resolved: AgentSourceConfig[] = [];
    const seen = new Set<string>();
    for (const source of sources) {
      try {
        const normalized = await this.resolveSourceConfigForUser(userId, source, def.sourceConfig);
        const key = `${normalized.platform}:${normalized.targetType}:${normalized.targetId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        resolved.push(normalized);
      } catch (err) {
        this.deps.logger.warn(
          { err, agentKey: def.key, userId, platform: source.platform, targetType: source.targetType },
          "Agent: dropping inaccessible source for generation",
        );
      }
    }

    return resolved;
  }

  protected async resolveRoutesForRun(
    def: AgentDefinition,
    userId: string,
    routes: AgentRoute[],
    sources: AgentSourceConfig[],
  ): Promise<ResolvedRoute[]> {
    if (!def.sourceConfig) return routes.map((route) => ({ ...route, resolvedSources: [] }));
    const resolvedSources = await this.resolveSourcesForRun(def, userId, sources);
    const byKey = new Map(resolvedSources.map((source) => [sourceKeyForTarget(source), source]));
    const resolvedRoutes: ResolvedRoute[] = [];

    for (const route of routes) {
      const routeSources = route.sources
        .map((sourceKey) => byKey.get(sourceKey))
        .filter((source) => source !== undefined);
      if (routeSources.length !== route.sources.length) continue;
      resolvedRoutes.push({ ...route, resolvedSources: routeSources });
    }

    return resolvedRoutes;
  }
}
