import { readFile } from "node:fs/promises";
import { extname } from "node:path";

const OPENROUTER_VISION_URL = "https://openrouter.ai/api/v1/chat/completions";

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export interface OpenRouterVisionConfig {
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

export interface OpenRouterVisionResult {
  text: string;
  usage?: {
    total_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
  };
}

interface OpenRouterVisionResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
  usage?: OpenRouterVisionResult["usage"];
  error?: {
    message?: string;
  };
}

function imageMimeFromHeader(data: Buffer): string | null {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (data.length > 2 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (data.subarray(0, 6).toString("ascii") === "GIF87a" || data.subarray(0, 6).toString("ascii") === "GIF89a") {
    return "image/gif";
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function imageMimeFromPath(path: string): string | null {
  return IMAGE_MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? null;
}

function extractTextContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const part of content) {
    if (part && typeof part === "object" && "type" in part && part.type === "text" && typeof part.text === "string") {
      parts.push(part.text);
    }
  }
  const text = parts.join("\n").trim();
  return text.length > 0 ? text : null;
}

export async function analyzeImageWithOpenRouter(
  imagePath: string,
  question: string,
  config: OpenRouterVisionConfig,
): Promise<OpenRouterVisionResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 55_000);

  try {
    const data = await readFile(imagePath);
    const mimeType = imageMimeFromHeader(data) ?? imageMimeFromPath(imagePath);
    if (!mimeType) {
      throw new Error("Unsupported image type.");
    }

    const response = await fetch(OPENROUTER_VISION_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        usage: { include: true },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: question },
              {
                type: "image_url",
                image_url: {
                  url: `data:${mimeType};base64,${data.toString("base64")}`,
                },
              },
            ],
          },
        ],
      }),
    });

    const body = (await response.json().catch(() => ({}))) as OpenRouterVisionResponse;
    if (!response.ok) {
      const message = body.error?.message ?? `OpenRouter vision analysis failed with HTTP ${response.status}`;
      throw new Error(message);
    }

    const text = extractTextContent(body.choices?.[0]?.message?.content);
    if (!text) {
      throw new Error("OpenRouter vision response did not include text");
    }

    return { text, usage: body.usage };
  } finally {
    clearTimeout(timeout);
  }
}
