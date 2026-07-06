import type { Kysely } from "kysely";
import { upsertCommitmentFact } from "../db/repositories/commitments";
import { upsertDecisionFactsForFile } from "../db/repositories/decisions";
import type { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { normalizeRelationType } from "../entities/graph";
import { emitDocumentDerivedFacts, sortDocumentParentRefs } from "./document-facts";
import type { GeminiGenerator } from "./gemini-generate";
import type { Connector, ConnectorType, SyncedItem } from "./types";

type IndexedFileFactRepository = ReturnType<typeof createIndexedFileFactRepository>;

export interface SyncFactContext {
  connectorConfigId: string;
  createdByUserId: string;
  lastSeenSyncRunId: string;
}

interface EmitFactsForSyncedItemParams {
  factRepo: IndexedFileFactRepository;
  db?: Kysely<DB>;
  connector: Connector;
  connectorType: ConnectorType;
  factContext: SyncFactContext;
  item: SyncedItem;
  indexedFileId: string;
  emitCorrespondentFacts?: boolean;
  experimentalFlag?: boolean;
  contentChanged?: boolean;
  generator?: GeminiGenerator;
}

export async function emitFactsForSyncedItem({
  db,
  factRepo,
  connector,
  connectorType,
  factContext,
  item,
  indexedFileId,
  emitCorrespondentFacts = false,
  experimentalFlag = false,
  contentChanged = false,
  generator,
}: EmitFactsForSyncedItemParams): Promise<void> {
  if (item.entitySeeds && item.entitySeeds.length > 0) {
    for (const seed of item.entitySeeds) {
      await factRepo.upsertFact({
        ...factContext,
        indexedFileId,
        contentHash: item.contentHash,
        source: seed.source,
        factType: "structural_seed",
        relation: "seeded",
        subjectName: seed.name,
        subjectSource: seed.source,
        subjectSourceId: seed.sourceId,
        contextSnippet: item.sourcePath,
        raw: seed,
      });
    }
  }

  if (item.personSeeds && item.personSeeds.length > 0) {
    for (const seed of item.personSeeds) {
      await factRepo.upsertFact({
        ...factContext,
        indexedFileId,
        contentHash: item.contentHash,
        source: seed.source,
        factType: "person_seed",
        relation: "seeded",
        subjectName: seed.name,
        subjectEmail: seed.email ?? null,
        subjectSource: seed.source,
        subjectSourceId: seed.sourceId,
        contextSnippet: item.sourcePath,
        raw: seed,
      });
    }
  }

  const promotable = connector.promotableFileTypes ?? [];
  if (item.fileType && promotable.includes(item.fileType)) {
    await factRepo.upsertFact({
      ...factContext,
      indexedFileId,
      contentHash: item.contentHash,
      source: connectorType,
      factType: "structural_seed",
      relation: "seeded",
      subjectName: item.fileName,
      subjectSource: connectorType,
      subjectSourceId: item.providerFileId,
      contextSnippet: item.sourcePath,
      raw: {
        providerFileId: item.providerFileId,
        providerUrl: item.providerUrl,
        fileType: item.fileType,
        sourcePath: item.sourcePath,
      },
    });
  }

  if (item.parentEntities && item.parentEntities.length > 0) {
    for (const parent of item.parentEntities) {
      await factRepo.upsertFact({
        ...factContext,
        indexedFileId,
        contentHash: item.contentHash,
        source: connectorType,
        factType: "parent_entity",
        relation: "mentioned",
        subjectSource: parent.source,
        subjectSourceId: parent.sourceId,
        contextSnippet: parent.contextSnippet ?? null,
        raw: { providerFileId: item.providerFileId, parent },
      });
    }
  }

  if (item.contactPoints && item.contactPoints.length > 0) {
    for (const contactPoint of item.contactPoints) {
      await factRepo.upsertFact({
        ...factContext,
        indexedFileId,
        contentHash: item.contentHash,
        source: connectorType,
        factType: "contact_point",
        relation: "contactable",
        subjectName: contactPoint.subjectName,
        subjectEmail: contactPoint.subjectEmail ?? null,
        subjectSource: contactPoint.subjectSource,
        subjectSourceId: contactPoint.subjectSourceId,
        contextSnippet: item.sourcePath,
        raw: { providerFileId: item.providerFileId, contactPoint },
      });
    }
  }

  if (item.relationships && item.relationships.length > 0) {
    for (const relationship of item.relationships) {
      const relationType = normalizeRelationType(relationship.relationType);
      if (!relationType) continue;
      await factRepo.upsertFact({
        ...factContext,
        indexedFileId,
        contentHash: item.contentHash,
        source: connectorType,
        factType: "crm_relation",
        relation: relationType,
        subjectName: relationship.target.name,
        subjectSource: relationship.target.source,
        subjectSourceId: relationship.target.sourceId,
        contextSnippet: relationship.contextSnippet ?? null,
        raw: {
          providerFileId: item.providerFileId,
          relationType,
          source: relationship.source,
          target: relationship.target,
        },
      });
    }
  }

  if (item.attendees) {
    for (const attendee of item.attendees) {
      if (emitCorrespondentFacts) {
        await seedCorrespondentPerson({
          factRepo,
          factContext,
          connectorType,
          correspondent: attendee,
          providerFileId: item.providerFileId,
          indexedFileId,
          contentHash: item.contentHash,
        });
      } else {
        await seedAttendeePerson({
          factRepo,
          factContext,
          connectorType,
          attendee,
          providerFileId: item.providerFileId,
          indexedFileId,
          contentHash: item.contentHash,
        });
      }
    }
  }

  if (item.assignees && item.assignees.length > 0) {
    for (const assignee of item.assignees) {
      await seedAssigneePerson({
        factRepo,
        connector,
        factContext,
        connectorType,
        assignee,
        providerFileId: item.providerFileId,
        indexedFileId,
        contentHash: item.contentHash,
      });
    }
  }

  if (experimentalFlag && item.task) {
    await factRepo.upsertFact({
      ...factContext,
      indexedFileId,
      contentHash: item.contentHash,
      source: connectorType,
      factType: "structural_task",
      relation: "mentioned",
      subjectName: item.task.title,
      subjectSource: connectorType,
      subjectSourceId: item.task.sourceTaskId,
      contextSnippet: item.sourcePath,
      raw: { indexedFileId, task: item.task },
    });
  }

  if (item.commitments && item.commitments.length > 0 && db) {
    for (const commitment of item.commitments) {
      await upsertCommitmentFact(db, {
        experimentalFlag,
        indexedFileId,
        connectorConfigId: factContext.connectorConfigId,
        createdByUserId: factContext.createdByUserId,
        lastSeenSyncRunId: factContext.lastSeenSyncRunId,
        contentHash: item.contentHash,
        source: connectorType,
        commitmentId: commitment.commitmentId,
        parentRef: commitment.parentRef,
        parentEntityId: commitment.parentEntityId,
        title: commitment.title,
        status: commitment.status,
        dueAt: commitment.dueAt,
        evidence: commitment.evidence,
        contextSnippet: item.sourcePath,
      });
    }
  }

  if (item.decisions && db) {
    await upsertDecisionFactsForFile(db, {
      experimentalFlag,
      indexedFileId,
      connectorConfigId: factContext.connectorConfigId,
      createdByUserId: factContext.createdByUserId,
      lastSeenSyncRunId: factContext.lastSeenSyncRunId,
      contentHash: item.contentHash,
      source: connectorType,
      decisions: item.decisions,
      contextSnippet: item.sourcePath,
    });
  }

  if (db) {
    await emitDocumentDerivedFacts(
      db,
      {
        indexedFileId,
        source: connectorType,
        content: item.content ?? "",
        sourceDate: item.sourceCreatedAt ?? item.sourceUpdatedAt,
        contentCategory: item.contentCategory,
        fileType: item.fileType,
        contentHash: item.contentHash,
        connectorConfigId: factContext.connectorConfigId,
        createdByUserId: factContext.createdByUserId,
        lastSeenSyncRunId: factContext.lastSeenSyncRunId,
        attendees: item.attendees ?? [],
        parentRefs: sortDocumentParentRefs(
          item.parentEntities?.map((parent) => ({ source: parent.source, sourceId: parent.sourceId })) ?? [],
        ),
      },
      { experimentalFlag, contentChanged, generator },
    );
  }

  if (item.authorEmail || item.authorName) {
    if (emitCorrespondentFacts) {
      await seedCorrespondentPerson({
        factRepo,
        factContext,
        connectorType,
        correspondent: { name: item.authorName, email: item.authorEmail, sourceId: item.authorSourceId },
        providerFileId: item.providerFileId,
        indexedFileId,
        contentHash: item.contentHash,
      });
    } else {
      await seedAuthorPerson({
        factRepo,
        factContext,
        connectorType,
        author: { name: item.authorName, email: item.authorEmail, sourceId: item.authorSourceId },
        providerFileId: item.providerFileId,
        indexedFileId,
        contentHash: item.contentHash,
      });
    }
  }
}

interface SeedAttendeePersonParams {
  factRepo: IndexedFileFactRepository;
  factContext: SyncFactContext;
  connectorType: ConnectorType;
  attendee: { name?: string; email?: string };
  providerFileId: string;
  indexedFileId: string;
  contentHash: string | null;
}

async function seedAttendeePerson({
  factRepo,
  factContext,
  connectorType,
  attendee,
  providerFileId,
  indexedFileId,
  contentHash,
}: SeedAttendeePersonParams): Promise<void> {
  const subjectName = attendee.name ?? displayNameFromEmail(attendee.email);
  if (!subjectName) return;
  await factRepo.upsertFact({
    ...factContext,
    indexedFileId,
    contentHash,
    source: connectorType,
    factType: "attendee",
    relation: "attended",
    subjectName,
    subjectEmail: attendee.email ?? null,
    subjectSource: connectorType,
    subjectSourceId: `${providerFileId}:${attendee.email ?? subjectName}`,
    contextSnippet: `Attended ${providerFileId}`,
    raw: { providerFileId, attendee },
  });
}

interface SeedCorrespondentPersonParams {
  factRepo: IndexedFileFactRepository;
  factContext: SyncFactContext;
  connectorType: ConnectorType;
  correspondent: { name?: string; email?: string; sourceId?: string };
  providerFileId: string;
  indexedFileId: string;
  contentHash: string | null;
}

function displayNameFromEmail(email: string | undefined): string | null {
  const localPart = email?.split("@")[0]?.trim();
  if (!localPart) return null;
  const words = localPart
    .replace(/[._+-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return null;
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(" ");
}

async function seedCorrespondentPerson({
  factRepo,
  factContext,
  connectorType,
  correspondent,
  providerFileId,
  indexedFileId,
  contentHash,
}: SeedCorrespondentPersonParams): Promise<void> {
  const subjectName = correspondent.name ?? displayNameFromEmail(correspondent.email);
  if (!subjectName) return;
  await factRepo.upsertFact({
    ...factContext,
    indexedFileId,
    contentHash,
    source: connectorType,
    factType: "correspondent",
    relation: "corresponded",
    subjectName,
    subjectEmail: correspondent.email ?? null,
    subjectSource: connectorType,
    subjectSourceId: correspondent.sourceId ?? `${providerFileId}:${correspondent.email ?? subjectName}`,
    contextSnippet: `Corresponded ${providerFileId}`,
    raw: { providerFileId, correspondent },
  });
}

interface SeedAssigneePersonParams {
  factRepo: IndexedFileFactRepository;
  connector: Connector;
  factContext: SyncFactContext;
  connectorType: ConnectorType;
  assignee: { name: string; email?: string; source?: string; sourceId?: string };
  providerFileId: string;
  indexedFileId: string;
  contentHash: string | null;
}

async function seedAssigneePerson({
  factRepo,
  connector,
  factContext,
  connectorType,
  assignee,
  providerFileId,
  indexedFileId,
  contentHash,
}: SeedAssigneePersonParams): Promise<void> {
  const sourceRefKey =
    assignee.source && assignee.sourceId
      ? `${assignee.source}:${assignee.sourceId}`
      : connector.assigneeSourceRefKey
        ? connector.assigneeSourceRefKey(assignee.name)
        : `${connectorType}:user:${assignee.name}`;
  const [subjectSource, ...subjectSourceParts] = sourceRefKey.split(":");
  await factRepo.upsertFact({
    ...factContext,
    indexedFileId,
    contentHash,
    source: connectorType,
    factType: "assignee",
    relation: "assigned",
    subjectName: assignee.name,
    subjectEmail: assignee.email ?? null,
    subjectSource: subjectSource || connectorType,
    subjectSourceId: subjectSourceParts.join(":") || assignee.name,
    contextSnippet: `Assigned to ${assignee.name}`,
    raw: { providerFileId, assignee, sourceRefKey },
  });
}

interface SeedAuthorPersonParams {
  factRepo: IndexedFileFactRepository;
  factContext: SyncFactContext;
  connectorType: ConnectorType;
  author: { name?: string; email?: string; sourceId?: string };
  providerFileId: string;
  indexedFileId: string;
  contentHash: string | null;
}

async function seedAuthorPerson({
  factRepo,
  factContext,
  connectorType,
  author,
  providerFileId,
  indexedFileId,
  contentHash,
}: SeedAuthorPersonParams): Promise<void> {
  if (!author.email && !author.name) return;
  await factRepo.upsertFact({
    ...factContext,
    indexedFileId,
    contentHash,
    source: connectorType,
    factType: "author",
    relation: "authored",
    subjectName: author.name ?? null,
    subjectEmail: author.email ?? null,
    subjectSource: connectorType,
    subjectSourceId: author.sourceId ?? author.email ?? `${providerFileId}:${author.name}`,
    contextSnippet: `Authored ${providerFileId}`,
    raw: { providerFileId, author },
  });
}
