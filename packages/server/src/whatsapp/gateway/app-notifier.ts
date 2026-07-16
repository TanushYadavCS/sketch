import type { WhatsAppSocketStateChange } from "../facade-contract";

export interface WhatsAppGatewayAppNotifierOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}

export class WhatsAppGatewayAppNotifier {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: WhatsAppGatewayAppNotifierOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async wake(): Promise<void> {
    await this.post("/internal/whatsapp/wake").catch(() => undefined);
  }

  socketStateChanged(change: WhatsAppSocketStateChange): void {
    void this.post("/internal/whatsapp/socket-state", change).catch(() => undefined);
  }

  private async post(path: string, body?: unknown): Promise<void> {
    const response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(2_000),
    });
    await response.body?.cancel();
  }
}
