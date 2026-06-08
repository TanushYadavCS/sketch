import { type WebChatUploadedAttachment, api } from "@/lib/api";
import { MicrophoneIcon, PaperPlaneTiltIcon, PaperclipIcon, StopIcon, XIcon } from "@phosphor-icons/react";
import { cn } from "@sketch/ui/lib/utils";
import {
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

export interface ChatInputAttachment {
  file: File;
  uploaded?: WebChatUploadedAttachment;
  uploading?: boolean;
  error?: string;
}

export interface ChatInputProps {
  initialValue?: string;
  placeholder?: string;
  disabled?: boolean;
  disabledPlaceholder?: string;
  onSubmit?: (value: string, attachments: WebChatUploadedAttachment[]) => void;
}

const MIN_HEIGHT = 76;
const MAX_HEIGHT = 220;

function autosize(el: HTMLTextAreaElement) {
  el.style.height = "0px";
  const next = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, el.scrollHeight));
  el.style.height = `${next}px`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const RECORDING_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

function supportedRecordingMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return undefined;
  return RECORDING_MIME_TYPES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType));
}

function recordingFilename(mimeType: string): string {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase();
  if (normalized === "audio/mp4") return "recording.m4a";
  if (normalized === "audio/ogg") return "recording.ogg";
  if (normalized === "audio/wav") return "recording.wav";
  return "recording.webm";
}

export const ChatInput = forwardRef<HTMLTextAreaElement, ChatInputProps>(function ChatInput(
  {
    initialValue = "",
    placeholder = "Ask Sketch anything…",
    disabled = false,
    disabledPlaceholder = "Resolve account issue to continue",
    onSubmit,
  },
  ref,
) {
  const [value, setValue] = useState(initialValue);
  const [attachments, setAttachments] = useState<ChatInputAttachment[]>([]);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  useImperativeHandle(ref, () => taRef.current as HTMLTextAreaElement, []);

  useEffect(() => {
    if (taRef.current) autosize(taRef.current);
  }, []);

  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current?.state === "recording") {
        mediaRecorderRef.current.stop();
      }
      for (const track of streamRef.current?.getTracks() ?? []) {
        track.stop();
      }
    };
  }, []);

  const hasUploadedAttachments = attachments.some((a) => a.uploaded);
  const hasContent = value.trim().length > 0 || hasUploadedAttachments;
  const hasPendingUploads = attachments.some((a) => a.uploading);
  const inputBusy = disabled || transcribing;

  function submitNow() {
    if (inputBusy || hasPendingUploads) return;
    const trimmed = value.trim();
    const uploaded = attachments.flatMap((a) => (a.uploaded ? [a.uploaded] : []));
    if (!trimmed && uploaded.length === 0) return;
    onSubmit?.(trimmed || "(attached files)", uploaded);
    setValue("");
    setAttachments([]);
    requestAnimationFrame(() => taRef.current && autosize(taRef.current));
  }

  function handleChange(event: ChangeEvent<HTMLTextAreaElement>) {
    setValue(event.target.value);
    autosize(event.target);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submitNow();
    }
  }

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files || inputBusy) return;
      const newAttachments: ChatInputAttachment[] = Array.from(files).map((file) => ({
        file,
        uploading: true,
      }));
      setAttachments((prev) => [...prev, ...newAttachments]);

      for (const attachment of newAttachments) {
        api.webChat
          .uploadAttachment(attachment.file)
          .then((result) => {
            setAttachments((prev) =>
              prev.map((a) => (a.file === attachment.file ? { ...a, uploaded: result, uploading: false } : a)),
            );
          })
          .catch((err) => {
            setAttachments((prev) =>
              prev.map((a) =>
                a.file === attachment.file
                  ? { ...a, uploading: false, error: err instanceof Error ? err.message : "Upload failed" }
                  : a,
              ),
            );
          });
      }
    },
    [inputBusy],
  );

  function removeAttachment(file: File) {
    setAttachments((prev) => prev.filter((a) => a.file !== file));
  }

  async function startRecording() {
    if (inputBusy || recording) return;
    setVoiceError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setVoiceError("Voice recording is not available in this browser.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = supportedRecordingMimeType();
      const mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      chunksRef.current = [];
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mediaRecorder.onstop = async () => {
        setRecording(false);
        for (const track of stream.getTracks()) track.stop();
        streamRef.current = null;
        const recordingType = mediaRecorder.mimeType || mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type: recordingType });
        if (blob.size === 0) {
          setVoiceError("No audio was recorded.");
          return;
        }

        setTranscribing(true);
        setVoiceError(null);
        try {
          const { text } = await api.webChat.transcribe(blob, recordingFilename(recordingType));
          if (text.trim()) {
            setValue((prev) => {
              const separator = prev.trim() ? " " : "";
              return `${prev}${separator}${text}`;
            });
            requestAnimationFrame(() => {
              if (taRef.current) {
                autosize(taRef.current);
                taRef.current.focus();
              }
            });
          } else {
            setVoiceError("No speech was detected.");
          }
        } catch (err) {
          setVoiceError(err instanceof Error ? err.message : "Transcription failed.");
        } finally {
          setTranscribing(false);
        }
      };
      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start();
      setRecording(true);
    } catch (err) {
      for (const track of streamRef.current?.getTracks() ?? []) {
        track.stop();
      }
      streamRef.current = null;
      setVoiceError(err instanceof Error ? err.message : "Microphone access failed.");
    }
  }

  function stopRecording() {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }
    setRecording(false);
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submitNow();
      }}
      className={cn(
        "group/input relative w-full rounded-[16px] border bg-card",
        "transition-all duration-150 ease-out",
        disabled
          ? "border-border opacity-90"
          : "border-border hover:border-foreground/25 focus-within:border-foreground/30 focus-within:shadow-[0_6px_24px_-10px_rgba(0,0,0,0.08)]",
      )}
    >
      <textarea
        ref={taRef}
        rows={3}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={
          disabled
            ? disabledPlaceholder
            : transcribing
              ? "Transcribing audio..."
              : recording
                ? "Recording... click stop when done"
                : (voiceError ?? placeholder)
        }
        disabled={inputBusy}
        className={cn(
          "block w-full resize-none bg-transparent px-[18px] pt-[16px] pb-[6px]",
          "text-[15px] leading-[1.55] text-foreground placeholder:text-muted-foreground",
          "outline-none disabled:cursor-not-allowed",
        )}
        style={{ height: MIN_HEIGHT, maxHeight: MAX_HEIGHT }}
        aria-label="Message Sketch"
      />

      {attachments.length > 0 ? (
        <div className="flex flex-wrap gap-[6px] px-[14px] pb-[6px]">
          {attachments.map((attachment) => (
            <AttachmentChip
              key={attachment.file.name + attachment.file.lastModified}
              attachment={attachment}
              onRemove={() => removeAttachment(attachment.file)}
            />
          ))}
        </div>
      ) : null}

      <div className="flex items-center justify-between px-[10px] pb-[10px] pt-[2px]">
        <div className="flex items-center gap-[4px]">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              handleFiles(e.target.files);
              e.target.value = "";
            }}
            aria-hidden
          />
          <IconButton
            icon={<PaperclipIcon size={16} aria-hidden />}
            label="Attach a file"
            disabled={inputBusy}
            onClick={() => fileInputRef.current?.click()}
          />
          {recording ? (
            <IconButton
              icon={<StopIcon size={16} weight="fill" aria-hidden />}
              label="Stop recording"
              disabled={false}
              onClick={stopRecording}
              active
            />
          ) : (
            <IconButton
              icon={<MicrophoneIcon size={16} aria-hidden />}
              label="Record voice"
              disabled={inputBusy}
              onClick={startRecording}
              loading={transcribing}
            />
          )}
        </div>
        <div className="min-w-0 flex-1" />
        <SubmitButton disabled={inputBusy || hasPendingUploads} empty={!hasContent} onClick={submitNow} />
      </div>
    </form>
  );
});

function IconButton({
  icon,
  label,
  disabled,
  onClick,
  active,
  loading,
}: {
  icon: ReactNode;
  label: string;
  disabled: boolean;
  onClick: () => void;
  active?: boolean;
  loading?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-busy={loading ? true : undefined}
      className={cn(
        "relative flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full",
        "transition-all duration-200 ease-out cursor-pointer",
        active
          ? "bg-red-500 text-white shadow-[0_2px_8px_rgba(239,68,68,0.5),0_0_20px_rgba(239,68,68,0.25)] hover:scale-[1.04] active:scale-[0.97]"
          : loading
            ? "bg-muted text-brand-accent cursor-wait"
            : "bg-muted text-muted-foreground hover:text-foreground hover:bg-foreground/15 hover:scale-[1.04] active:scale-[0.97]",
        disabled && !loading && "cursor-not-allowed opacity-50",
      )}
    >
      {loading ? (
        <span
          className="pointer-events-none absolute inset-[-2px] rounded-full border-[1.5px] animate-spin"
          style={{
            borderColor: "color-mix(in oklch, var(--brand-accent) 20%, transparent)",
            borderTopColor: "var(--brand-accent)",
          }}
          aria-hidden
        />
      ) : null}
      {icon}
    </button>
  );
}

function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: ChatInputAttachment;
  onRemove: () => void;
}) {
  const isImage = attachment.file.type.startsWith("image/");
  const previewUrl = useMemo(() => (isImage ? URL.createObjectURL(attachment.file) : null), [attachment.file, isImage]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  return (
    <div
      className={cn(
        "inline-flex max-w-[200px] items-center gap-[6px] rounded-[8px] border px-[8px] py-[5px] text-[12px]",
        attachment.error
          ? "border-red-500/40 bg-red-500/10 text-red-400"
          : attachment.uploading
            ? "border-border/60 bg-muted/40 text-muted-foreground animate-pulse"
            : "border-border bg-muted/50 text-foreground/80",
      )}
    >
      {previewUrl ? (
        <img src={previewUrl} alt="" className="h-[18px] w-[18px] shrink-0 rounded-[3px] object-cover" />
      ) : (
        <PaperclipIcon size={13} className="shrink-0" aria-hidden />
      )}
      <span className="truncate">{attachment.file.name}</span>
      {attachment.uploaded ? (
        <span className="shrink-0 text-muted-foreground/60">{formatFileSize(attachment.uploaded.sizeBytes)}</span>
      ) : null}
      <button
        type="button"
        onClick={onRemove}
        className="shrink-0 text-muted-foreground/60 transition-colors hover:text-foreground cursor-pointer"
        aria-label={`Remove ${attachment.file.name}`}
      >
        <XIcon size={12} aria-hidden />
      </button>
    </div>
  );
}

function SubmitButton({ disabled, empty, onClick }: { disabled: boolean; empty: boolean; onClick: () => void }) {
  const ready = !disabled && !empty;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || empty}
      aria-label="Send message"
      className={cn(
        "flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full",
        "transition-all duration-200 ease-out cursor-pointer",
        ready
          ? "bg-brand-yellow text-brand-brown shadow-[0_2px_8px_rgba(254,237,1,0.5),0_0_20px_rgba(254,237,1,0.25)] hover:shadow-[0_2px_12px_rgba(254,237,1,0.6),0_0_28px_rgba(254,237,1,0.3)] hover:scale-[1.04] active:scale-[0.97]"
          : "bg-muted text-muted-foreground/70 cursor-not-allowed",
      )}
    >
      <PaperPlaneTiltIcon size={14} weight="fill" aria-hidden />
    </button>
  );
}
