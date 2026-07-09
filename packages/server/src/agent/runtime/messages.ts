import { readFile } from "node:fs/promises";
import type { UserContent } from "ai";
import type { Attachment } from "../../files";
import { formatAttachmentsForPrompt, isImageAttachment } from "../../files";

/** Builds AI SDK user content while preserving the existing runner attachment prompt text. */
export async function buildAgentRuntimeUserContent(
  userMessage: string,
  attachments: readonly Attachment[],
): Promise<UserContent> {
  const images = attachments.filter(isImageAttachment);
  const nonImages = attachments.filter((attachment) => !isImageAttachment(attachment));
  const text = userMessage + formatAttachmentsForPrompt(nonImages);

  if (images.length === 0) return text;

  const parts: Exclude<UserContent, string> = [{ type: "text", text }];
  for (const image of images) {
    parts.push({
      type: "image",
      image: (await readFile(image.localPath)).toString("base64"),
      mediaType: image.mimeType,
    });
  }

  return parts;
}
