import type { OperationalAlertRow, createOperationalAlertsRepository } from "../db/repositories/operational-alerts";
import { operationalAlertDestinationFingerprint } from "../db/repositories/operational-alerts";
import type { createSettingsRepository } from "../db/repositories/settings";
import type { UserRepository } from "../db/repositories/users";
import type { Logger } from "../logger";
import { isWhatsAppDmPhoneE164 } from "../whatsapp/provider";
import type { OperationalAlertChannelTransport, OperationalAlertDefinition } from "./types";

export const OPERATIONAL_ALERT_WORKER_INTERVAL_MS = 15_000;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "providerCode" in error) {
    const code = (error as { providerCode?: unknown }).providerCode;
    if (typeof code === "string") return code;
  }
  return error instanceof Error ? error.name : "unknown_error";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown delivery error";
}

function shouldRetryIndefinitely(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("retryIndefinitely" in error)) return false;
  return (error as { retryIndefinitely?: unknown }).retryIndefinitely === true;
}

function destinationForAdmin(
  channel: "whatsapp" | "slack",
  admin: { whatsapp_number: string | null; slack_user_id: string | null },
): string | null {
  const destination = channel === "whatsapp" ? admin.whatsapp_number?.trim() : admin.slack_user_id?.trim();
  if (!destination) return null;
  if (channel === "whatsapp" && !isWhatsAppDmPhoneE164(destination)) return null;
  return destination;
}

export class OperationalAlertWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private active: Promise<void> | null = null;
  private requested = false;
  private started = false;

  constructor(
    private readonly params: {
      alerts: ReturnType<typeof createOperationalAlertsRepository>;
      users: Pick<UserRepository, "findById" | "listAdmins">;
      settings: Pick<ReturnType<typeof createSettingsRepository>, "get">;
      definitions: ReadonlyMap<string, OperationalAlertDefinition>;
      transports: Partial<Record<"whatsapp" | "slack", OperationalAlertChannelTransport>>;
      logger: Pick<Logger, "error" | "info" | "warn">;
      now?: () => Date;
    },
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => this.wake(), OPERATIONAL_ALERT_WORKER_INTERVAL_MS);
    this.timer.unref?.();
    this.wake();
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.active;
  }

  wake(): void {
    if (!this.started) return;
    this.requested = true;
    if (this.active) return;
    this.active = this.runRequestedCycles()
      .catch((error) => this.params.logger.error({ error }, "Operational alert worker cycle failed"))
      .finally(() => {
        this.active = null;
        if (this.requested) this.wake();
      });
  }

  async drain(): Promise<void> {
    if (!this.started) this.started = true;
    this.wake();
    await this.active;
  }

  private async runRequestedCycles(): Promise<void> {
    while (this.requested) {
      this.requested = false;
      await this.runCycle();
    }
  }

  private async runCycle(): Promise<void> {
    const now = this.params.now?.() ?? new Date();
    const nowIso = now.toISOString();
    await this.params.alerts.recoverStaleClaims(now);

    for (const alert of await this.params.alerts.listEligibleObserving(nowIso)) {
      const definition = this.params.definitions.get(alert.type);
      if (!definition || !(await definition.isStillActive(alert))) {
        await this.params.alerts.resolveById(alert.id, nowIso);
        continue;
      }
      await this.params.alerts.promote(alert.id, nowIso);
    }

    const openAlerts: Array<{
      alert: OperationalAlertRow;
      definition: OperationalAlertDefinition;
    }> = [];
    for (const alert of await this.params.alerts.listOpen()) {
      const definition = this.params.definitions.get(alert.type);
      if (!definition || !(await definition.isStillActive(alert))) {
        await this.params.alerts.resolveById(alert.id, nowIso);
        continue;
      }
      openAlerts.push({ alert, definition });
    }

    const admins = await this.params.users.listAdmins();
    for (const { alert, definition } of openAlerts) {
      for (const channel of definition.channels) {
        const seenDestinations = new Set<string>();
        for (const admin of admins) {
          const destination = destinationForAdmin(channel, admin);
          if (!destination || seenDestinations.has(destination)) continue;
          seenDestinations.add(destination);
          await this.params.alerts.ensureDelivery({
            alertId: alert.id,
            recipientUserId: admin.id,
            channel,
            destinationFingerprint: operationalAlertDestinationFingerprint(channel, destination),
            now: nowIso,
          });
        }
      }
    }

    for (;;) {
      const delivery = await this.params.alerts.claimNext(nowIso);
      if (!delivery) break;
      const alert = await this.params.alerts.getAlert(delivery.alert_id);
      if (!alert || (alert.state !== "open" && !(alert.state === "resolved" && alert.opened_at))) {
        await this.params.alerts.markSkipped(delivery.id, "alert_resolved", "Alert is no longer open", nowIso);
        continue;
      }
      const definition = this.params.definitions.get(alert.type);
      const channel = delivery.channel === "whatsapp" || delivery.channel === "slack" ? delivery.channel : null;
      const transport = channel ? this.params.transports[channel] : undefined;
      const recipient = await this.params.users.findById(delivery.recipient_user_id);
      const destination = channel && recipient ? destinationForAdmin(channel, recipient) : null;
      const destinationMatches =
        channel && destination
          ? operationalAlertDestinationFingerprint(channel, destination) === delivery.destination_fingerprint
          : false;
      if (
        !definition ||
        !transport ||
        !recipient ||
        recipient.auth_role !== "admin" ||
        !destination ||
        !destinationMatches
      ) {
        await this.params.alerts.markSkipped(
          delivery.id,
          "delivery_unavailable",
          "Alert definition, transport, or recipient is unavailable",
          nowIso,
        );
        continue;
      }

      try {
        const settings = await this.params.settings.get();
        const orgName = settings?.org_name?.trim() || "your organisation";
        const botName = settings?.bot_name?.trim() || "Sketch";
        const rendered = await definition.render(alert, { orgName, botName, recipientName: recipient.name });
        const sent = await transport.send({
          alert,
          recipient: { id: recipient.id, name: recipient.name, destination },
          ...rendered,
          orgName,
          botName,
          now,
        });
        await this.params.alerts.markSent(delivery.id, sent.providerMessageId, nowIso);
        this.params.logger.info(
          { alertId: alert.id, alertType: alert.type, deliveryId: delivery.id, channel: delivery.channel },
          "Operational alert delivered",
        );
      } catch (error) {
        const attempts = delivery.attempts + 1;
        const delayMs = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)] ?? 60 * 60_000;
        await this.params.alerts.markFailed({
          id: delivery.id,
          attempts,
          code: errorCode(error),
          message: errorMessage(error),
          nextAttemptAt: new Date(now.getTime() + delayMs).toISOString(),
          now: nowIso,
          retryIndefinitely: shouldRetryIndefinitely(error),
        });
        this.params.logger.warn(
          { alertId: alert.id, alertType: alert.type, deliveryId: delivery.id, attempts, error },
          "Operational alert delivery failed",
        );
      }
    }
  }
}
