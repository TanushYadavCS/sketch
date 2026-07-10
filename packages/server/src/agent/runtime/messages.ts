import { readFile } from "node:fs/promises";
import type { UserContent } from "ai";
import type { Attachment } from "../../files";
import {
  DEFAULT_MAX_ATTACHMENT_TOTAL_BYTES,
  formatAttachmentsForPrompt,
  isImageAttachment,
  selectImagesWithinBudget,
} from "../../files";

/**
 * Builds AI SDK user content while preserving the existing runner attachment prompt text.
 * Image attachments are embedded inline only within the aggregate byte budget; images
 * beyond it stay saved to the workspace and are listed in the text with a note so the
 * agent can Read them, matching the Claude SDK path (see buildMultimodalContent).
 */
export async function buildAgentRuntimeUserContent(
  userMessage: string,
  attachments: readonly Attachment[],
  maxImageTotalBytes: number = DEFAULT_MAX_ATTACHMENT_TOTAL_BYTES,
): Promise<UserContent> {
  const images = attachments.filter(isImageAttachment);
  const nonImages = attachments.filter((attachment) => !isImageAttachment(attachment));
  const { embed, skipped } = selectImagesWithinBudget(images, maxImageTotalBytes);
  const text =
    userMessage +
    formatAttachmentsForPrompt([...nonImages, ...skipped], {
      oversizedInlineImagePaths: new Set(skipped.map((a) => a.localPath)),
    });

  if (embed.length === 0) return text;

  const parts: Exclude<UserContent, string> = [{ type: "text", text }];
  for (const image of embed) {
    parts.push({
      type: "image",
      image: (await readFile(image.localPath)).toString("base64"),
      mediaType: image.mimeType,
    });
  }

  return parts;
}
