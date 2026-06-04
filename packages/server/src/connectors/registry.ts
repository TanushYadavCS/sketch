/**
 * Connector registry — single source of truth for connector factories and validation.
 *
 * ConnectorType lives in types.ts (to avoid circular deps with the Connector interface).
 * This file is the single source of truth for:
 * - Factory map (which function creates which connector)
 * - Valid connector type list (for API validation)
 * - getConnector() lookup
 *
 * Adding a new connector: add the type to ConnectorType in types.ts,
 * then add the factory here. That's it — no other files need updating.
 */
import type { Connector, ConnectorType } from "./types";

import { createClickUpConnector } from "./clickup";
import { createFirefliesConnector } from "./fireflies";
import { createGmailConnector } from "./gmail";
import { createGoogleDriveConnector } from "./google-drive";
import { createLinearConnector } from "./linear";
import { createNotionConnector } from "./notion";

export const connectorFactories: Record<ConnectorType, () => Connector> = {
  google_drive: createGoogleDriveConnector,
  gmail: createGmailConnector,
  clickup: createClickUpConnector,
  notion: createNotionConnector,
  linear: createLinearConnector,
  fireflies: createFirefliesConnector,
};

export const VALID_CONNECTOR_TYPES: ConnectorType[] = Object.keys(connectorFactories) as ConnectorType[];

export function getConnector(type: ConnectorType): Connector {
  const factory = connectorFactories[type];
  if (!factory) throw new Error(`Unknown connector type: ${type}`);
  return factory();
}
