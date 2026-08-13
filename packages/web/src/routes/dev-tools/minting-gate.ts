/**
 * A read-only mirror of the accept gate, so the sheet can say what accepting
 * will cause before you click.
 *
 * The server is authoritative — `acceptProjectMintingVerdict` enforces all of
 * this and refuses on its own terms, and its error text is what the reviewer
 * finally sees. This exists because the consequence of correcting an axis is
 * otherwise invisible until after the write: dropping a stage from `active` to
 * `prospect` discards the account container and strands anything that was to be
 * merged into it.
 *
 * Being a second implementation, it can drift. It is deliberately narrow —
 * shape only, no file counts, since which files anchor to which project is
 * resolved server-side against the graph. When this surface leaves dev-tools,
 * replace it with a dry-run accept endpoint rather than growing it.
 */
import type { ClientStage, CounterpartyKind, ProjectMintingVerdict } from "@/lib/api";

export type GateLineTone = "add" | "drop" | "warn" | "declare";

export interface GateLine {
  tone: GateLineTone;
  text: string;
}

export interface GatePreview {
  /** Non-null when the server would refuse, with the reason to show in place of the plan. */
  blocked: string | null;
  lines: GateLine[];
}

const STAGE_KINDS: ReadonlySet<CounterpartyKind> = new Set(["client", "partner"]);

export function kindCarriesStage(kind: CounterpartyKind): boolean {
  return STAGE_KINDS.has(kind);
}

function writesNothing(kind: CounterpartyKind, stage: ClientStage | null): boolean {
  if (!kindCarriesStage(kind)) return true;
  return stage === "dormant" || stage === "ended";
}

function axisLabel(kind: CounterpartyKind, stage: ClientStage | null): string {
  return kindCarriesStage(kind) && stage ? `${kind} · ${stage}` : kind;
}

/**
 * @param struck project names the reviewer has unticked
 */
export function previewGate(
  verdict: ProjectMintingVerdict,
  kind: CounterpartyKind,
  stage: ClientStage | null,
  struck: ReadonlySet<string>,
): GatePreview {
  const proposal = verdict.verdict;
  const engagementName = proposal.engagement?.name ?? null;
  const surviving = proposal.projects.filter((project) => !struck.has(project.name));
  const declare: GateLine = {
    tone: "declare",
    text: `Declare ${verdict.companyName} as ${axisLabel(kind, stage)}`,
  };

  const cascade = proposal.existingEntities.find(
    (entity) => entity.disposition === "merge_into" && entity.mergeInto && struck.has(entity.mergeInto),
  );
  if (cascade) {
    return {
      blocked: `“${cascade.mergeInto}” is struck, but “${cascade.name}” was to be merged into it. Untick the strike, or reject and re-run.`,
      lines: [],
    };
  }

  if (writesNothing(kind, stage)) {
    const lines: GateLine[] = [{ tone: "drop", text: "Nothing will be created, and nothing existing is touched" }];
    if (engagementName || proposal.projects.length > 0) {
      const dropped = [
        ...(engagementName ? [`the container “${engagementName}”`] : []),
        ...(proposal.projects.length > 0 ? [`${proposal.projects.length} proposed project(s)`] : []),
      ].join(" and ");
      lines.push({ tone: "drop", text: `The model proposed ${dropped}. All of it is discarded.` });
    }
    lines.push(declare);
    return { blocked: null, lines };
  }

  if (stage === "active" && !engagementName) {
    return {
      blocked:
        "An active client needs an account container, and this verdict proposes none. Choose pilot, or reject and re-run the cluster.",
      lines: [],
    };
  }
  if (stage === "pilot" && surviving.length === 0) {
    return {
      blocked: "A pilot needs at least one project to hold the work. Untick a strike, or choose prospect.",
      lines: [],
    };
  }

  const keepsEngagement = stage === "active" && engagementName !== null;
  const lines: GateLine[] = [];

  if (keepsEngagement) {
    lines.push({ tone: "add", text: `Create “${engagementName}” as the account container` });
  } else if (engagementName) {
    const why =
      stage === "prospect" ? "a prospect carries no account container" : "a pilot carries no account container";
    lines.push({ tone: "drop", text: `“${engagementName}” will not be created — ${why}` });
  }

  if (surviving.length > 0) {
    lines.push({
      tone: "add",
      text: `Create ${surviving.length} project${surviving.length === 1 ? "" : "s"}: ${surviving.map((p) => p.name).join(", ")}`,
    });
  } else {
    lines.push({ tone: "drop", text: "No projects — every one proposed is struck" });
  }

  const willExist = new Set(surviving.map((project) => project.name));
  const merges = proposal.existingEntities.filter((entity) => entity.disposition === "merge_into" && entity.mergeInto);
  const resolved = merges.filter(
    (entity) => willExist.has(entity.mergeInto ?? "") || (keepsEngagement && entity.mergeInto === engagementName),
  );
  const stranded = merges.filter((entity) => !resolved.includes(entity));

  if (resolved.length > 0) {
    lines.push({
      tone: "add",
      text: `Merge ${resolved.length} existing fragment${resolved.length === 1 ? "" : "s"} into them`,
    });
  }
  for (const entity of stranded) {
    lines.push({
      tone: "warn",
      text: `“${entity.name}” was to be merged into “${entity.mergeInto}”, which will not exist. It stays a loose fragment.`,
    });
  }

  const residual = residualTarget(keepsEngagement ? engagementName : null, surviving, stage);
  lines.push(
    residual
      ? { tone: "add", text: `Files matching no project attach to “${residual}”` }
      : { tone: "warn", text: "Files matching no project will attach to nothing" },
  );

  lines.push(declare);
  return { blocked: null, lines };
}

/**
 * Mirrors the residual target in `computeAcceptance`: the container, else a
 * lone project, else a pilot's first project, else nothing.
 */
function residualTarget(
  engagementName: string | null,
  surviving: { name: string }[],
  stage: ClientStage | null,
): string | null {
  if (engagementName) return engagementName;
  if (surviving.length === 1) return surviving[0].name;
  if (stage === "pilot" && surviving.length > 0) return surviving[0].name;
  return null;
}
