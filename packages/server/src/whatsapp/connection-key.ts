const CONNECTION_GENERATION_WIDTH = 12;
const MAX_CONNECTION_GENERATION = 10 ** CONNECTION_GENERATION_WIDTH - 1;

function encodeGeneration(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_CONNECTION_GENERATION) {
    throw new Error("WhatsApp connection generation is outside the supported range");
  }
  return String(value).padStart(CONNECTION_GENERATION_WIDTH, "0");
}

export function createWhatsAppConnectionKey(leaseGeneration: number, socketGeneration: number): string {
  return `${encodeGeneration(leaseGeneration)}:${encodeGeneration(socketGeneration)}`;
}
