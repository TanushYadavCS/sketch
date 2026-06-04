import type { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import type { Connector, ConnectorType, SyncedItem } from "./types";

type IndexedFileFactRepository = ReturnType<typeof createIndexedFileFactRepository>;

export interface SyncFactContext {
  connectorConfigId: string;
  createdByUserId: string;
  lastSeenSyncRunId: string;
}

interface EmitFactsForSyncedItemParams {
  factRepo: IndexedFileFactRepository;
  connector: Connector;
  connectorType: ConnectorType;
  factContext: SyncFactContext;
  item: SyncedItem;
  indexedFileId: string;
}

export async function emitFactsForSyncedItem({
  factRepo,
  connector,
  connectorType,
  factContext,
  item,
  indexedFileId,
}: EmitFactsForSyncedItemParams): Promise<void> {
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

  if (item.attendees) {
    for (const attendee of item.attendees) {
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

  if (item.authorEmail || item.authorName) {
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
  if (!attendee.name) return;
  await factRepo.upsertFact({
    ...factContext,
    indexedFileId,
    contentHash,
    source: connectorType,
    factType: "attendee",
    relation: "attended",
    subjectName: attendee.name,
    subjectEmail: attendee.email ?? null,
    subjectSource: connectorType,
    subjectSourceId: `${providerFileId}:${attendee.email ?? attendee.name}`,
    contextSnippet: `Attended ${providerFileId}`,
    raw: { providerFileId, attendee },
  });
}

interface SeedAssigneePersonParams {
  factRepo: IndexedFileFactRepository;
  connector: Connector;
  factContext: SyncFactContext;
  connectorType: ConnectorType;
  assignee: { name: string; email?: string };
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
  const sourceRefKey = connector.assigneeSourceRefKey
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
