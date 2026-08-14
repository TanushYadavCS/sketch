import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { DB } from "../db/schema";
import type { GeminiGenerator } from "./gemini-generate";
import type { ContainerTarget } from "./types";

export type ContainerClassificationConfidence = "high" | "medium" | "low";
export type ContainerClassificationStatus = "proposed" | "accepted" | "edited";

export interface ContainerTicketSample {
  title: string;
  date: string | null;
}

export interface ContainerDigestInput {
  id: string;
  level: string;
  name: string;
  parentChain: string[];
  taskCount: number;
  tickets: ContainerTicketSample[];
}

export interface ContainerDigestEntry {
  id: string;
  level: string;
  name: string;
  parentChain: string[];
  taskCount: number;
  firstTicketDate: string | null;
  lastTicketDate: string | null;
  sampledTicketTitles: string[];
  burstStats: { ticketsPerDayP95: number; distinctTicketDays: number };
  deterministicSignals: string[];
}

export interface ContainerDigest {
  hash: string;
  containers: ContainerDigestEntry[];
}

export interface ContainerClassificationProposal {
  containerId: string;
  containerName: string;
  level: string;
  proposedTarget: ContainerTarget;
  confidence: ContainerClassificationConfidence;
  reasoning: string;
  digestHash: string;
  status: ContainerClassificationStatus;
  createdAt?: string;
  updatedAt?: string;
}

const CONTAINER_TARGETS = [
  "team",
  "project",
  "program",
  "cycle",
  "register",
  "person_queue",
  "status",
  "archive",
  "ignore",
] as const satisfies readonly ContainerTarget[];

const classificationResponseSchema = z.object({
  containers: z.record(
    z.string(),
    z.object({
      target: z.enum(CONTAINER_TARGETS),
      confidence: z.enum(["high", "medium", "low"]),
      reasoning: z.string().trim().min(1).max(500),
    }),
  ),
});

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function percentile95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function sampleTitles(tickets: ContainerTicketSample[], limit = 10): string[] {
  const sorted = [...tickets].sort((left, right) => {
    const leftKey = left.date ?? "";
    const rightKey = right.date ?? "";
    if (leftKey !== rightKey) return leftKey.localeCompare(rightKey);
    return left.title.localeCompare(right.title);
  });
  if (sorted.length <= limit) return sorted.map((ticket) => ticket.title);
  const indexes = new Set<number>([0, sorted.length - 1]);
  const remaining = limit - indexes.size;
  for (let i = 1; i <= remaining; i++) {
    indexes.add(Math.floor((i * (sorted.length - 1)) / (remaining + 1)));
  }
  return [...indexes]
    .sort((left, right) => left - right)
    .map((index) => sorted[index]?.title)
    .filter((title): title is string => typeof title === "string" && title.length > 0);
}

function deterministicSignals(
  input: ContainerDigestInput,
  distinctTicketDays: number,
  memberNames: Set<string>,
): string[] {
  const signals: string[] = [];
  const normalized = normalizeName(input.name);
  if (/\bsprint\s*#?\s*\d+\b/i.test(input.name)) signals.push("sprint_numbered_name");
  if (/\[(dummy|demo|test)\]|\b(dummy|demo|test)\b/i.test(input.name)) signals.push("dummy_demo_test_name");
  if (input.taskCount >= 100 && distinctTicketDays <= 2) signals.push("bulk_import_register_shape");
  if (memberNames.has(normalized)) signals.push("person_named_container");
  return signals;
}

export function buildContainerDigest(
  inputs: ContainerDigestInput[],
  opts: { memberNames?: string[] } = {},
): ContainerDigest {
  const memberNames = new Set((opts.memberNames ?? []).map(normalizeName).filter(Boolean));
  const containers = [...inputs]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((input): ContainerDigestEntry => {
      const datedTickets = input.tickets.filter((ticket) => ticket.date);
      const dates = datedTickets.map((ticket) => ticket.date as string).sort();
      const countsByDay = new Map<string, number>();
      for (const ticket of datedTickets) {
        const day = (ticket.date as string).slice(0, 10);
        countsByDay.set(day, (countsByDay.get(day) ?? 0) + 1);
      }
      const distinctTicketDays = countsByDay.size;
      return {
        id: input.id,
        level: input.level,
        name: input.name,
        parentChain: input.parentChain,
        taskCount: input.taskCount,
        firstTicketDate: dates[0] ?? null,
        lastTicketDate: dates[dates.length - 1] ?? null,
        sampledTicketTitles: sampleTitles(input.tickets),
        burstStats: {
          ticketsPerDayP95: percentile95([...countsByDay.values()]),
          distinctTicketDays,
        },
        deterministicSignals: deterministicSignals(input, distinctTicketDays, memberNames),
      };
    });
  const hash = createHash("sha256").update(stableJson(containers)).digest("hex");
  return { hash, containers };
}

export async function classifyContainerDigest(params: {
  digest: ContainerDigest;
  generator: GeminiGenerator;
  model?: string | null;
}): Promise<ContainerClassificationProposal[]> {
  const response = await params.generator.generateJSON<unknown>(
    [
      "Classify each external tracker container for Sketch sync.",
      'Return only JSON shaped as {"containers":{"container-id":{"target":"team|project|program|cycle|register|person_queue|status|archive|ignore","confidence":"high|medium|low","reasoning":"one concise sentence"}}}.',
      "Shape outranks name. If shape and name conflict, explain the conflict in reasoning.",
      "Low confidence must use target ignore rather than a guess.",
      "Digest:",
      JSON.stringify(params.digest, null, 2),
    ].join("\n\n"),
    {
      model: params.model ?? null,
      reasoningEffort: "medium",
      label: "container-classification",
      maxTokens: 8192,
    },
  );
  const parsed = classificationResponseSchema.parse(response);
  return params.digest.containers.map((container) => {
    const classified = parsed.containers[container.id] ?? {
      target: "ignore" as const,
      confidence: "low" as const,
      reasoning: "No classifier output was returned for this container.",
    };
    return {
      containerId: container.id,
      containerName: container.name,
      level: container.level,
      proposedTarget: classified.confidence === "low" ? "ignore" : classified.target,
      confidence: classified.confidence,
      reasoning: classified.reasoning,
      digestHash: params.digest.hash,
      status: "proposed",
    };
  });
}

export async function upsertContainerClassifications(
  db: Kysely<DB>,
  connectorConfigId: string,
  proposals: ContainerClassificationProposal[],
): Promise<void> {
  for (const proposal of proposals) {
    await db
      .insertInto("container_classifications")
      .values({
        connector_config_id: connectorConfigId,
        container_id: proposal.containerId,
        container_name: proposal.containerName,
        level: proposal.level,
        proposed_target: proposal.proposedTarget,
        confidence: proposal.confidence,
        reasoning: proposal.reasoning,
        digest_hash: proposal.digestHash,
        status: proposal.status,
      })
      .onConflict((oc) =>
        oc.columns(["connector_config_id", "container_id"]).doUpdateSet({
          container_name: proposal.containerName,
          level: proposal.level,
          proposed_target: proposal.proposedTarget,
          confidence: proposal.confidence,
          reasoning: proposal.reasoning,
          digest_hash: proposal.digestHash,
          status: proposal.status,
          updated_at: new Date().toISOString(),
        }),
      )
      .execute();
  }
}

export async function listContainerClassifications(
  db: Kysely<DB>,
  connectorConfigId: string,
): Promise<ContainerClassificationProposal[]> {
  const rows = await db
    .selectFrom("container_classifications")
    .selectAll()
    .where("connector_config_id", "=", connectorConfigId)
    .orderBy("level", "asc")
    .orderBy("container_name", "asc")
    .execute();
  return rows.map((row) => ({
    containerId: row.container_id,
    containerName: row.container_name,
    level: row.level,
    proposedTarget: row.proposed_target as ContainerTarget,
    confidence: row.confidence as ContainerClassificationConfidence,
    reasoning: row.reasoning,
    digestHash: row.digest_hash,
    status: row.status as ContainerClassificationStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function markAcceptedContainerOverrides(
  db: Kysely<DB>,
  connectorConfigId: string,
  containers: Record<string, unknown>,
): Promise<void> {
  for (const [containerId, target] of Object.entries(containers)) {
    if (!CONTAINER_TARGETS.includes(target as ContainerTarget)) continue;
    const row = await db
      .selectFrom("container_classifications")
      .select("proposed_target")
      .where("connector_config_id", "=", connectorConfigId)
      .where("container_id", "=", containerId)
      .executeTakeFirst();
    if (!row) continue;
    await db
      .updateTable("container_classifications")
      .set({
        proposed_target: target as ContainerTarget,
        status: row.proposed_target === target ? "accepted" : "edited",
        updated_at: new Date().toISOString(),
      })
      .where("connector_config_id", "=", connectorConfigId)
      .where("container_id", "=", containerId)
      .execute();
  }
}
