/**
 * WhatsApp API routes — SSE-based QR pairing, connection status, disconnect.
 * Mounted at /api/channels/whatsapp.
 *
 * GET    /           — connection status + phone number
 * GET    /pair       — SSE stream for QR pairing (events: qr, connected, error)
 * DELETE /pair       — cancel an in-progress pairing session
 * DELETE /           — disconnect and clear credentials
 */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { WhatsAppSocketFacade } from "../whatsapp/facade-contract";
import { denyIfNotAdmin } from "./auth-helpers";

export function whatsappRoutes(whatsapp: WhatsAppSocketFacade) {
  const routes = new Hono();
  let pairingInProgress = false;
  let pairingSettled: Promise<void> | null = null;

  routes.get("/", async (c) => {
    const status = await whatsapp.pairing.status();
    return c.json({
      connected: status.connected,
      phoneNumber: status.phoneNumber,
    });
  });

  routes.get("/pair", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;

    if ((await whatsapp.pairing.status()).connected) {
      return c.json({ error: { code: "ALREADY_CONNECTED", message: "WhatsApp is already connected" } }, 400);
    }
    if (pairingInProgress) {
      return c.json({ error: { code: "PAIRING_IN_PROGRESS", message: "A pairing attempt is already active" } }, 409);
    }
    pairingInProgress = true;

    return streamSSE(c, async (stream) => {
      try {
        pairingSettled = whatsapp.pairing.startQr(async (event) => {
          if (event.type === "qr") {
            await stream.writeSSE({ event: "qr", data: JSON.stringify({ qr: event.qr }) });
          } else if (event.type === "connected") {
            await stream.writeSSE({ event: "connected", data: JSON.stringify({ phoneNumber: event.phoneNumber }) });
          } else {
            await stream.writeSSE({ event: "error", data: JSON.stringify({ message: event.message }) });
          }
        });
        await pairingSettled;
      } finally {
        pairingInProgress = false;
        pairingSettled = null;
      }
    });
  });

  routes.delete("/pair", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;

    if (!pairingInProgress) {
      return c.json({ error: { code: "NO_PAIRING", message: "No pairing in progress" } }, 400);
    }
    await whatsapp.pairing.cancel();
    if (pairingSettled) await pairingSettled;
    return c.json({ success: true });
  });

  routes.delete("/", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;

    if (!(await whatsapp.pairing.status()).connected) {
      return c.json({ error: { code: "NOT_CONNECTED", message: "WhatsApp is not connected" } }, 400);
    }
    await whatsapp.pairing.logout();
    return c.json({ success: true });
  });

  return routes;
}
