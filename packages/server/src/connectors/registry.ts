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
import { createGoogleCalendarConnector } from "./google-calendar";
import { createGoogleDriveConnector } from "./google-drive";
import { createLinearConnector } from "./linear";
import { createNotionConnector } from "./notion";
import { createOtterConnector } from "./otter";
import { createOutlookConnector } from "./outlook";
import { createSlackIndexingConnector } from "./slack-indexing";
import { createTeamsConnector } from "./teams";
import { createWhatsAppConnector } from "./whatsapp";
import { createZohoCrmConnector } from "./zoho-crm";

export const connectorFactories: Record<ConnectorType, () => Connector> = {
  google_drive: createGoogleDriveConnector,
  google_calendar: createGoogleCalendarConnector,
  gmail: createGmailConnector,
  outlook: createOutlookConnector,
  teams: createTeamsConnector,
  clickup: createClickUpConnector,
  notion: createNotionConnector,
  linear: createLinearConnector,
  fireflies: createFirefliesConnector,
  otter: createOtterConnector,
  zoho_crm: createZohoCrmConnector,
  whatsapp: createWhatsAppConnector,
  slack: createSlackIndexingConnector,
};

export const VALID_CONNECTOR_TYPES: ConnectorType[] = Object.keys(connectorFactories) as ConnectorType[];

export function getConnector(type: ConnectorType): Connector {
  const factory = connectorFactories[type];
  if (!factory) throw new Error(`Unknown connector type: ${type}`);
  return factory();
}
