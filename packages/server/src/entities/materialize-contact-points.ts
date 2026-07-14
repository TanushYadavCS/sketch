import type { EntityContactPointKind } from "../db/repositories/entities";
import { registerEntity } from "./materialize-deps";
import { readJsonObject } from "./materialize-json";
import type { EntityRow, IndexedFileFactRow, MaterializeDeps, MaterializeResult } from "./materialize-types";

const CONTACT_POINT_KINDS = new Set(["email", "phone", "linkedin", "whatsapp"]);

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readKind(value: string | null): EntityContactPointKind | null {
  if (!value || !CONTACT_POINT_KINDS.has(value)) return null;
  return value as EntityContactPointKind;
}

export async function materializeContactPointFact(
  deps: MaterializeDeps,
  fact: IndexedFileFactRow,
): Promise<MaterializeResult> {
  const raw = readJsonObject(fact.raw);
  const contactPoint = raw.contactPoint;
  if (!contactPoint || typeof contactPoint !== "object" || Array.isArray(contactPoint)) {
    return { kind: "skipped", reason: "missing_contact_point_raw" };
  }

  const contact = contactPoint as Record<string, unknown>;
  const kind = readKind(readString(contact, "kind"));
  const value = readString(contact, "value");
  const subjectSource = readString(contact, "subjectSource") ?? fact.subject_source;
  const subjectSourceId = readString(contact, "subjectSourceId") ?? fact.subject_source_id;
  const subjectName = readString(contact, "subjectName") ?? fact.subject_name;
  if (!kind || !value || !subjectSource || !subjectSourceId || !subjectName) {
    return { kind: "skipped", reason: "missing_contact_point_subject" };
  }

  let entity = deps.index.bySourceRef.get(`${subjectSource}:${subjectSourceId}`);
  if (!entity) {
    const found = await deps.entityRepo.getEntityBySourceRef(subjectSource, subjectSourceId);
    if (found) entity = found;
  }
  if (!entity && fact.subject_email) {
    const matches = await deps.entityRepo.getPersonEntitiesByEmail(fact.subject_email);
    if (matches.length === 1) entity = matches[0];
  }
  if (!entity) {
    return { kind: "skipped", reason: "missing_contact_point_subject_entity" };
  }

  deps.index.bySourceRef.set(`${subjectSource}:${subjectSourceId}`, entity);
  registerEntity(deps.index, entity);

  try {
    await deps.entityRepo.upsertContactPoint({
      entityId: entity.id,
      kind,
      value,
      displayValue: readString(contact, "displayValue"),
      label: readString(contact, "label"),
      source: readString(contact, "source") ?? fact.source,
      connectorConfigId: fact.connector_config_id,
      createdByUserId: fact.created_by_user_id,
      verifiedAt: readString(contact, "verifiedAt"),
      lastContactedAt: readString(contact, "lastContactedAt"),
    });
  } catch (err) {
    deps.logger?.warn(
      { err, factId: fact.id, contactPointKind: kind, subjectSource, subjectSourceId },
      "Skipped invalid contact point fact",
    );
  }

  return { kind: "structural", entity };
}
