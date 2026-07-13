import {
  type OtterSpeechSource,
  type OtterSpeechSummary,
  createOtterClient,
  extractOtterSpeech,
  extractOtterTranscriptSegments,
  getOtterSpeechId,
  getOtterSpeechTitle,
  otterSpeechToSyncedItem,
} from "../packages/server/src/connectors/otter";

type CheckArgs = {
  email: string;
  password: string;
  source: OtterSpeechSource;
  pageSize: number;
  otid: string | null;
  printContent: boolean;
};

function usage() {
  return [
    "Usage:",
    "  OTTER_EMAIL=you@example.com OTTER_PASSWORD=... pnpm otter:check",
    "  pnpm otter:check -- --email you@example.com --password ... --source all --page-size 10",
    "",
    "Options:",
    "  --email <email>        Defaults to OTTER_EMAIL.",
    "  --password <password>  Defaults to OTTER_PASSWORD.",
    "  --source <source>      owned, shared, or all. Defaults to OTTER_SOURCE or owned.",
    "  --page-size <n>        Number of recent speeches to request. Defaults to OTTER_PAGE_SIZE or 10.",
    "  --otid <id>            Fetch this Otter transcript instead of the first listed speech.",
    "  --print-content        Print mapped transcript content after the metadata summary.",
  ].join("\n");
}

function readOption(args: string[], name: string) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function parseSource(value: string | undefined): OtterSpeechSource {
  if (value === "owned" || value === "shared" || value === "all") return value;
  throw new Error("--source must be one of: owned, shared, all");
}

function parsePageSize(value: string | undefined) {
  const parsed = Number(value ?? "10");
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
    throw new Error("--page-size must be an integer between 1 and 200");
  }
  return parsed;
}

function parseArgs(argv: string[]): CheckArgs {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    process.exit(0);
  }

  const email = readOption(argv, "--email") ?? process.env.OTTER_EMAIL;
  const password = readOption(argv, "--password") ?? process.env.OTTER_PASSWORD;
  if (!email || !password) {
    throw new Error(`Missing Otter credentials.\n\n${usage()}`);
  }

  return {
    email,
    password,
    source: parseSource(readOption(argv, "--source") ?? process.env.OTTER_SOURCE ?? "owned"),
    pageSize: parsePageSize(readOption(argv, "--page-size") ?? process.env.OTTER_PAGE_SIZE),
    otid: readOption(argv, "--otid") ?? process.env.OTTER_OTID ?? null,
    printContent: argv.includes("--print-content") || process.env.OTTER_CHECK_PRINT_CONTENT === "1",
  };
}

function unixTimestampToIso(value: unknown) {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : null;
  if (!numeric || !Number.isFinite(numeric)) return null;
  return new Date((numeric > 100_000_000_000 ? numeric : numeric * 1000) as number).toISOString();
}

function speechPreview(speech: OtterSpeechSummary) {
  return {
    otid: getOtterSpeechId(speech),
    title: getOtterSpeechTitle(speech),
    createdAt: unixTimestampToIso(speech.created_at),
    startTime: unixTimestampToIso(speech.start_time),
    durationSeconds: speech.duration ?? null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = createOtterClient({
    credentials: { email: args.email, password: args.password },
  });

  await client.login();
  const user = await client.getUser();
  const speeches = await client.listSpeeches({ source: args.source, pageSize: args.pageSize });
  const selectedOtid = args.otid ?? getOtterSpeechId(speeches[0] ?? {});

  if (!selectedOtid) {
    console.log(
      JSON.stringify(
        {
          authenticated: true,
          userId: client.getUserId(),
          userEmailHint: maskEmail(user.email),
          speechCount: speeches.length,
          speechSamples: speeches.slice(0, 5).map(speechPreview),
        },
        null,
        2,
      ),
    );
    throw new Error("No speech otid found to fetch. Try --source all or --otid <id>.");
  }

  const speechResponse = await client.getSpeech(selectedOtid);
  const speech = extractOtterSpeech(speechResponse);
  const segments = extractOtterTranscriptSegments(speechResponse);
  const item = otterSpeechToSyncedItem(speechResponse, { ownerEmail: args.email });

  console.log(
    JSON.stringify(
      {
        authenticated: true,
        userId: client.getUserId(),
        userEmailHint: maskEmail(user.email),
        speechCount: speeches.length,
        speechSamples: speeches.slice(0, 5).map(speechPreview),
        selectedSpeech: {
          ...speechPreview(speech),
          transcriptSegments: segments.length,
        },
        syncedItem: {
          providerFileId: item.providerFileId,
          providerUrl: item.providerUrl,
          fileName: item.fileName,
          sourceCreatedAt: item.sourceCreatedAt,
          sourceUpdatedAt: item.sourceUpdatedAt,
          contentLength: item.content?.length ?? 0,
          contentHash: item.contentHash,
          attendeeCount: item.attendees?.length ?? 0,
          accessEmailCount: item.accessEmails?.length ?? 0,
        },
      },
      null,
      2,
    ),
  );

  if (args.printContent) {
    console.log("\n--- mapped content ---\n");
    console.log(item.content ?? "");
  }
}

function maskEmail(value: unknown) {
  if (typeof value !== "string" || !value.includes("@")) return null;
  const [local, domain] = value.split("@");
  if (!local || !domain) return null;
  return `${local.slice(0, 2)}***@${domain}`;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
