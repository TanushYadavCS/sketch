import { DisconnectReason } from "@whiskeysockets/baileys";

export function whatsappGatewayReconnectDelayMs(
  statusCode: number | undefined,
  random: () => number = Math.random,
): number {
  return statusCode === DisconnectReason.restartRequired ? 1_000 : 3_000 + Math.floor(random() * 751);
}
