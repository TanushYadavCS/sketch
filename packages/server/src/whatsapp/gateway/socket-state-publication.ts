import type { WhatsAppSocketStateChange } from "../facade-contract";

export type WhatsAppSocketStatePublication = Pick<
  WhatsAppSocketStateChange,
  "socketState" | "socketGeneration" | "statusCode" | "reason"
>;

export function isSameWhatsAppSocketStatePublication(
  left: WhatsAppSocketStatePublication | null,
  right: WhatsAppSocketStatePublication,
): boolean {
  return (
    left?.socketState === right.socketState &&
    left.socketGeneration === right.socketGeneration &&
    left.statusCode === right.statusCode &&
    left.reason === right.reason
  );
}
