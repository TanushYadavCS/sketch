type CliArgs = {
  baseUrl: string;
  secret: string;
  limit: number;
  cursor: string | null;
};

type HotnessRecomputationResult = {
  processed: number;
  nextCursor: string | null;
  done: boolean;
};

const endpointPath = "/api/system/entities/graph/hotness-recomputations";

function usage() {
  return [
    "Usage:",
    "  pnpm recompute:entity-hotness -- --base-url https://tenant.example.com --secret $SYSTEM_SECRET",
    "  SYSTEM_SECRET=... pnpm recompute:entity-hotness -- --base-url http://127.0.0.1:3000",
    "",
    "Options:",
    "  --base-url <url>   Sketch tenant base URL. Defaults to SKETCH_BASE_URL, BASE_URL, MANAGED_URL, or localhost.",
    "  --secret <secret>   System API bearer secret. Defaults to SYSTEM_SECRET.",
    "  --limit <n>         Batch size, 1-1000. Defaults to 500.",
    "  --cursor <id>       Resume from an entity id cursor.",
  ].join("\n");
}

function readOption(args: string[], name: string) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function parseArgs(argv: string[]): CliArgs {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    process.exit(0);
  }

  const baseUrl =
    readOption(argv, "--base-url") ??
    process.env.SKETCH_BASE_URL ??
    process.env.BASE_URL ??
    process.env.MANAGED_URL ??
    `http://127.0.0.1:${process.env.PORT ?? "3000"}`;
  const secret = readOption(argv, "--secret") ?? process.env.SYSTEM_SECRET;
  const limitValue = readOption(argv, "--limit") ?? "500";
  const limit = Number(limitValue);
  const cursor = readOption(argv, "--cursor") ?? null;

  if (!secret) {
    throw new Error(`Missing system secret. Pass --secret or set SYSTEM_SECRET.\n\n${usage()}`);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("--limit must be an integer between 1 and 1000.");
  }

  return { baseUrl, secret, limit, cursor };
}

function parseResult(value: unknown): HotnessRecomputationResult {
  if (!value || typeof value !== "object") {
    throw new Error("Unexpected response body: expected an object.");
  }
  const result = value as Partial<HotnessRecomputationResult>;
  if (
    typeof result.processed !== "number" ||
    (typeof result.nextCursor !== "string" && result.nextCursor !== null) ||
    typeof result.done !== "boolean"
  ) {
    throw new Error(`Unexpected response body: ${JSON.stringify(value)}`);
  }
  return {
    processed: result.processed,
    nextCursor: result.nextCursor,
    done: result.done,
  };
}

function recomputationUrl(baseUrl: string) {
  return new URL(endpointPath, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
}

async function postBatch(args: CliArgs, cursor: string | null) {
  const response = await fetch(recomputationUrl(args.baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(cursor ? { cursor, limit: args.limit } : { limit: args.limit }),
  });
  const text = await response.text();
  let body: unknown = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    throw new Error(
      `Request failed with HTTP ${response.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`,
    );
  }
  return parseResult(body);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let cursor = args.cursor;
  let batches = 0;
  let totalProcessed = 0;

  while (true) {
    const result = await postBatch(args, cursor);
    batches += 1;
    totalProcessed += result.processed;
    console.log(
      JSON.stringify({
        batch: batches,
        processed: result.processed,
        nextCursor: result.nextCursor,
        done: result.done,
      }),
    );

    if (result.done) break;
    if (!result.nextCursor) {
      throw new Error("Server returned done=false without a next cursor.");
    }
    cursor = result.nextCursor;
  }

  console.log(`Done. Recomputed hotness for ${totalProcessed} entities in ${batches} batches.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
