import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { ZodError, type ZodType } from "zod";
import type { Logger } from "../../logger";
import {
  type WhatsAppSocketFacade,
  whatsAppComposingRequestSchema,
  whatsAppFacadeHealthSchema,
  whatsAppGroupMetadataRequestSchema,
  whatsAppGroupMetadataResponseSchema,
  whatsAppGroupSyncOptionsSchema,
  whatsAppGroupSyncSummarySchema,
  whatsAppHistorySyncRequestSchema,
  whatsAppHistorySyncResponseSchema,
  whatsAppMediaDownloadRefSchema,
  whatsAppMediaDownloadResponseSchema,
  whatsAppOkResponseSchema,
  whatsAppPairingEventSchema,
  whatsAppPairingStatusSchema,
  whatsAppReactionRequestSchema,
  whatsAppReactionResponseSchema,
  whatsAppResolveLidRequestSchema,
  whatsAppResolveLidResponseSchema,
  whatsAppSendRequestSchema,
  whatsAppSendResponseSchema,
} from "../facade-contract";

export const WHATSAPP_GATEWAY_HOST = "127.0.0.1";
export const WHATSAPP_GATEWAY_DEFAULT_PORT = 3901;

function tokenMatches(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

async function parseBody<T>(request: Request, schema: ZodType<T>): Promise<T> {
  return schema.parse(await request.json());
}

export function createWhatsAppGatewayHttpApp(deps: {
  token: string;
  facade: WhatsAppSocketFacade;
  logger: Logger;
}) {
  const app = new Hono();

  app.use("*", async (context, next) => {
    if (!tokenMatches(context.req.header("authorization"), deps.token)) {
      context.header("WWW-Authenticate", "Bearer");
      return context.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  app.post("/messages", async (context) => {
    const input = await parseBody(context.req.raw, whatsAppSendRequestSchema);
    const result = await deps.facade.send(input.target, input.content, input.opts);
    return context.json(whatsAppSendResponseSchema.parse({ result }));
  });

  app.put("/presence", async (context) => {
    const input = await parseBody(context.req.raw, whatsAppComposingRequestSchema);
    await deps.facade.sendComposing(input.target, input.on);
    return context.json(whatsAppOkResponseSchema.parse({ ok: true }));
  });

  app.post("/reactions", async (context) => {
    const input = await parseBody(context.req.raw, whatsAppReactionRequestSchema);
    const result = await deps.facade.react(input.target, input.quotedRef, input.emoji);
    return context.json(whatsAppReactionResponseSchema.parse({ result }));
  });

  app.post("/media-downloads", async (context) => {
    const input = await parseBody(context.req.raw, whatsAppMediaDownloadRefSchema);
    const result = await deps.facade.downloadMedia(input);
    return context.json(whatsAppMediaDownloadResponseSchema.parse({ result }));
  });

  app.post("/group-metadata-queries", async (context) => {
    const input = await parseBody(context.req.raw, whatsAppGroupMetadataRequestSchema);
    const result = await deps.facade.groupMetadata(input.jid, input.opts);
    return context.json(whatsAppGroupMetadataResponseSchema.parse({ result }));
  });

  app.post("/group-syncs", async (context) => {
    const input = await parseBody(context.req.raw, whatsAppGroupSyncOptionsSchema);
    const result = await deps.facade.syncAllGroups(input);
    return context.json(whatsAppGroupSyncSummarySchema.parse(result));
  });

  app.post("/lid-resolutions", async (context) => {
    const input = await parseBody(context.req.raw, whatsAppResolveLidRequestSchema);
    const phoneJid = await deps.facade.resolveLid(input.jid);
    return context.json(whatsAppResolveLidResponseSchema.parse({ phoneJid }));
  });

  app.post("/history-sync-requests", async (context) => {
    const input = await parseBody(context.req.raw, whatsAppHistorySyncRequestSchema);
    const requestSessionId = await deps.facade.fetchMessageHistory(input);
    return context.json(whatsAppHistorySyncResponseSchema.parse({ requestSessionId }));
  });

  app.post("/pairing-sessions", (context) =>
    streamSSE(context, async (stream) => {
      try {
        await deps.facade.pairing.startQr(async (event) => {
          const parsed = whatsAppPairingEventSchema.parse(event);
          await stream.writeSSE({ event: parsed.type, data: JSON.stringify(parsed) });
        });
      } catch (error) {
        deps.logger.error({ error }, "WhatsApp gateway pairing stream failed");
        await stream.writeSSE({ event: "error", data: JSON.stringify({ type: "error", message: "Pairing failed" }) });
      }
    }),
  );

  app.get("/pairing-sessions/current", async (context) => {
    const result = await deps.facade.pairing.status();
    return context.json(whatsAppPairingStatusSchema.parse(result));
  });

  app.delete("/pairing-sessions/current", async (context) => {
    await deps.facade.pairing.cancel();
    return context.json(whatsAppOkResponseSchema.parse({ ok: true }));
  });

  app.delete("/authentication", async (context) => {
    await deps.facade.pairing.logout();
    return context.json(whatsAppOkResponseSchema.parse({ ok: true }));
  });

  app.delete("/process", (context) => {
    queueMicrotask(() => void deps.facade.shutdown());
    return context.json(whatsAppOkResponseSchema.parse({ ok: true }));
  });

  app.get("/health", async (context) => {
    const result = await deps.facade.health();
    return context.json(whatsAppFacadeHealthSchema.parse(result));
  });

  app.onError((error, context) => {
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return context.json({ error: "invalid_request" }, 400);
    }
    deps.logger.error({ error }, "WhatsApp gateway facade request failed");
    return context.json({ error: "internal_error" }, 500);
  });

  return app;
}
