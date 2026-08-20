import { normalizeName } from "./name-normalize";
import type { GroupDisposition } from "./weekly-mint";

/**
 * Scoring core for the weekly-pass eval. Pure functions over the evidence one
 * run recorded — disposition trace payloads and the verdict JSON those
 * dispositions point to. Deliberately blind to current graph and queue state:
 * a row that acceptance already resolved, or an entity that exists today,
 * cannot count for or against the judge. The CLI script gathers evidence from
 * the DB and reports graph context separately.
 */

export type WeeklyPassGoldens = {
  company: string;
  projects: Array<{ name: string; aliases?: string[]; parent?: string | null }>;
  junk?: Array<{ name: string; why?: string }>;
  aliases?: Array<{ candidate: string; of: string }>;
};

export type ContainerEvidence = {
  containerKey: string;
  companyName: string | null;
  dispositions: GroupDisposition[];
  verdictId: string | null;
  verdictProjects: Array<{ name: string; parentName: string | null }>;
  toolCalls: number;
  rounds: number | null;
};

export type RunEvidence = {
  runId: string;
  judgeMode: string | null;
  model: string | null;
  promptVersion: string | null;
  containers: ContainerEvidence[];
};

export type MetricResult = {
  hit: number;
  total: number;
  failing: string[];
};

export type WeeklyPassScores = {
  recall: MetricResult;
  junk: MetricResult;
  nesting: MetricResult;
  aliasJudgment: MetricResult;
  toolUsage: {
    containersWithTools: number;
    totalToolCalls: number;
    dispositionsCitingLookup: number;
  };
};

function matchesAny(target: string, names: string[]): boolean {
  const normalized = normalizeName(target);
  return names.some((name) => normalizeName(name) === normalized);
}

function allVerdictProjects(evidence: RunEvidence): Array<{ name: string; parentName: string | null }> {
  return evidence.containers.flatMap((container) => container.verdictProjects);
}

function allDispositions(evidence: RunEvidence): GroupDisposition[] {
  return evidence.containers.flatMap((container) => container.dispositions);
}

export function scoreRun(evidence: RunEvidence, goldens: WeeklyPassGoldens): WeeklyPassScores {
  const verdictProjects = allVerdictProjects(evidence);
  const dispositions = allDispositions(evidence);

  const recallFailing: string[] = [];
  for (const golden of goldens.projects) {
    const wanted = [golden.name, ...(golden.aliases ?? [])];
    const inVerdict = verdictProjects.some((project) => matchesAny(project.name, wanted));
    const inDispositions = dispositions.some(
      (disposition) =>
        (disposition.projectName != null && matchesAny(disposition.projectName, wanted)) ||
        (disposition.action === "alias" && disposition.names.some((name) => matchesAny(name, wanted))),
    );
    if (!inVerdict && !inDispositions) recallFailing.push(golden.name);
  }

  const junkEntries = goldens.junk ?? [];
  const junkFailing: string[] = [];
  for (const junk of junkEntries) {
    const survived = verdictProjects.some((project) => matchesAny(project.name, [junk.name]));
    if (survived) junkFailing.push(junk.name);
  }

  const nested = goldens.projects.filter((golden) => golden.parent != null);
  const nestingFailing: string[] = [];
  for (const golden of nested) {
    const wanted = [golden.name, ...(golden.aliases ?? [])];
    const project = verdictProjects.find((candidate) => matchesAny(candidate.name, wanted));
    const parentMatches =
      project?.parentName != null && golden.parent != null && matchesAny(project.parentName, [golden.parent]);
    if (!parentMatches) nestingFailing.push(golden.name);
  }

  const aliasEntries = goldens.aliases ?? [];
  const aliasFailing: string[] = [];
  for (const alias of aliasEntries) {
    const aliased = dispositions.some(
      (disposition) =>
        disposition.action === "alias" && disposition.names.some((name) => matchesAny(name, [alias.candidate])),
    );
    if (!aliased) aliasFailing.push(alias.candidate);
  }

  return {
    recall: {
      hit: goldens.projects.length - recallFailing.length,
      total: goldens.projects.length,
      failing: recallFailing,
    },
    junk: { hit: junkEntries.length - junkFailing.length, total: junkEntries.length, failing: junkFailing },
    nesting: { hit: nested.length - nestingFailing.length, total: nested.length, failing: nestingFailing },
    aliasJudgment: {
      hit: aliasEntries.length - aliasFailing.length,
      total: aliasEntries.length,
      failing: aliasFailing,
    },
    toolUsage: {
      containersWithTools: evidence.containers.filter((container) => container.toolCalls > 0).length,
      totalToolCalls: evidence.containers.reduce((sum, container) => sum + container.toolCalls, 0),
      dispositionsCitingLookup: dispositions.filter((disposition) => disposition.reason?.includes("via_lookup")).length,
    },
  };
}

export type MetricDelta = { metric: string; current: string; baseline: string; delta: number };

export function diffScores(current: WeeklyPassScores, baseline: WeeklyPassScores): MetricDelta[] {
  const metrics: Array<[string, MetricResult, MetricResult]> = [
    ["recall", current.recall, baseline.recall],
    ["junk", current.junk, baseline.junk],
    ["nesting", current.nesting, baseline.nesting],
    ["aliasJudgment", current.aliasJudgment, baseline.aliasJudgment],
  ];
  return metrics.map(([metric, cur, base]) => ({
    metric,
    current: `${cur.hit}/${cur.total}`,
    baseline: `${base.hit}/${base.total}`,
    delta: cur.hit - base.hit,
  }));
}
