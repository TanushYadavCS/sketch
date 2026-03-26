interface ResolvedSlackTokens {
  botToken: string;
  appToken?: string;
}

type TokenSource = { botToken?: string | null; appToken?: string | null };

export async function resolveSlackTokens(
  mode: "socket" | "http",
  getTokens: () => Promise<TokenSource | null>,
): Promise<ResolvedSlackTokens | null> {
  const tokens = await getTokens();
  const botToken = tokens?.botToken;
  if (!botToken) return null;

  if (mode === "socket") {
    const appToken = tokens?.appToken;
    if (!appToken) return null;
    return { botToken, appToken };
  }

  return { botToken };
}
