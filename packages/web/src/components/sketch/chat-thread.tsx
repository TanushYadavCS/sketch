import { FileTextIcon } from "@phosphor-icons/react";
import { cn } from "@sketch/ui/lib/utils";
import { SketchMessage, UserMessage } from "./chat-message";

export interface ChatThreadFile {
  name: string;
  url: string;
  mediaType?: string;
  sizeBytes?: number;
}

export interface ChatThreadMessage {
  id: string;
  role: "user" | "assistant";
  text?: string;
  createdAt?: string;
  files?: ChatThreadFile[];
  progressLines?: string[];
}

export interface ChatThreadProps {
  messages?: ChatThreadMessage[];
  busy?: boolean;
  error?: string | null;
  className?: string;
}

export function ChatThread({ messages = [], busy = false, error, className }: ChatThreadProps) {
  if (messages.length === 0 && !busy && !error) return null;
  const showBusy = busy && messages.at(-1)?.role !== "assistant";

  return (
    <section aria-label="Chat thread" className={cn("flex flex-col gap-[24px]", className)}>
      {messages.map((message) => (
        <MessageRow key={message.id} message={message} />
      ))}

      {showBusy ? (
        <SketchMessage streaming>
          <span className="text-muted-foreground italic">Thinking…</span>
        </SketchMessage>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="rounded-[14px] border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          {error}
        </div>
      ) : null}
    </section>
  );
}

function MessageRow({ message }: { message: ChatThreadMessage }) {
  if (message.role === "user") {
    return (
      <UserMessage footer={<MessageTimestamp createdAt={message.createdAt} align="right" />}>
        <MessageContent message={message} />
      </UserMessage>
    );
  }

  if (message.progressLines?.length) {
    return (
      <SketchMessage streaming footer={<MessageTimestamp createdAt={message.createdAt} align="left" />}>
        <div className="sketch-text-thinking space-y-[2px] text-muted-foreground italic">
          {message.progressLines.map((line) => (
            <p key={line} className="whitespace-pre-wrap">
              {line}
            </p>
          ))}
        </div>
      </SketchMessage>
    );
  }

  return (
    <SketchMessage footer={<MessageTimestamp createdAt={message.createdAt} align="left" />}>
      <MessageContent message={message} />
    </SketchMessage>
  );
}

function formatMessageTime(createdAt: string): string | null {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function MessageTimestamp({ createdAt, align }: { createdAt?: string; align: "left" | "right" }) {
  if (!createdAt) return null;
  const label = formatMessageTime(createdAt);
  if (!label) return null;

  return (
    <time
      dateTime={createdAt}
      className={cn(
        "mt-[5px] block text-[11px] leading-none text-muted-foreground/65",
        align === "right" ? "text-right" : "text-left",
      )}
    >
      {label}
    </time>
  );
}

function MessageContent({ message }: { message: ChatThreadMessage }) {
  if (!message.files?.length) {
    return message.text ? <p className="whitespace-pre-wrap">{message.text}</p> : null;
  }

  return (
    <div className="min-w-0 space-y-[10px]">
      {message.text ? <p className="whitespace-pre-wrap">{message.text}</p> : null}
      <div className="flex flex-wrap gap-[8px]">
        {message.files.map((file) => (
          <a
            key={`${file.url}:${file.name}`}
            href={file.url}
            download={file.name}
            className={cn(
              "inline-flex max-w-full items-center gap-[8px] rounded-[8px] border border-border",
              "bg-background/70 px-[10px] py-[8px] text-[13px] text-foreground/90 transition-colors",
              "hover:border-foreground/25 hover:bg-muted/70",
            )}
          >
            <FileTextIcon size={16} className="shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate">{file.name}</span>
          </a>
        ))}
      </div>
    </div>
  );
}
