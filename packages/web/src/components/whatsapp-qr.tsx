/**
 * Shared WhatsApp QR pairing component — used by both onboarding and channels page.
 * Opens an SSE connection to GET /api/channels/whatsapp/pair, renders QR codes as they arrive,
 * and detects scan completion in real-time.
 *
 * Dismissal is handled by the parent dialog's × button. On unmount, the component
 * automatically cleans up the SSE connection and cancels the server-side session.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { ArrowClockwiseIcon, CheckCircleIcon, SpinnerGapIcon, WarningIcon } from "@phosphor-icons/react";
import QRCode from "qrcode";

import { api } from "@/lib/api";
import { Button } from "@sketch/ui/components/button";

type QrState = "idle" | "generating" | "ready" | "connected" | "expired" | "error";

interface WhatsAppQRProps {
  onConnected: (phoneNumber: string) => void;
  onError?: (message: string) => void;
  autoStart?: boolean;
}

export function WhatsAppQR({ onConnected, onError, autoStart = true }: WhatsAppQRProps) {
  const [state, setState] = useState<QrState>("idle");
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [phoneNumber, setPhoneNumber] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const onConnectedRef = useRef(onConnected);
  const onErrorRef = useRef(onError);
  onConnectedRef.current = onConnected;
  onErrorRef.current = onError;

  const cleanup = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  const startPairing = useCallback(() => {
    cleanup();
    setState("generating");
    setQrDataUrl(null);
    setErrorMessage(null);

    const es = new EventSource("/api/channels/whatsapp/pair");
    eventSourceRef.current = es;

    es.addEventListener("qr", async (e) => {
      const { qr } = JSON.parse(e.data);
      const dataUrl = await QRCode.toDataURL(qr, { width: 256, margin: 2 });
      setQrDataUrl(dataUrl);
      setState("ready");
    });

    es.addEventListener("connected", (e) => {
      const { phoneNumber: phone } = JSON.parse(e.data);
      setPhoneNumber(phone);
      setState("connected");
      cleanup();
      onConnectedRef.current(phone);
    });

    es.addEventListener("error", (e) => {
      if (e instanceof MessageEvent) {
        const { message } = JSON.parse(e.data);
        if (message === "QR code expired") {
          setState("expired");
        } else {
          setErrorMessage(message);
          setState("error");
          onErrorRef.current?.(message);
        }
      } else {
        setErrorMessage("Connection lost");
        setState("error");
      }
      cleanup();
    });
  }, [cleanup]);

  useEffect(() => {
    if (autoStart) {
      startPairing();
    }
    return () => {
      cleanup();
      api.whatsapp.cancelPairing().catch(() => {});
    };
  }, [autoStart, startPairing, cleanup]);

  if (state === "idle") {
    return (
      <div className="flex flex-col items-center gap-3 py-4">
        <Button variant="outline" size="sm" onClick={startPairing}>
          Generate QR Code
        </Button>
      </div>
    );
  }

  if (state === "generating") {
    return (
      <div className="flex flex-col items-center gap-3 py-4">
        <div className="flex size-48 items-center justify-center rounded-lg border bg-muted">
          <SpinnerGapIcon className="size-6 animate-spin text-muted-foreground" />
        </div>
        <p className="text-xs text-muted-foreground">Generating QR code...</p>
      </div>
    );
  }

  if (state === "ready" && qrDataUrl) {
    return (
      <div className="flex flex-col items-center gap-3 py-4">
        <div className="rounded-lg border bg-white p-2">
          <img src={qrDataUrl} alt="WhatsApp QR Code" className="size-48" />
        </div>
        <p className="text-xs text-muted-foreground">Scan this code with WhatsApp</p>
        <p className="max-w-xs text-center text-xs text-muted-foreground/70">
          Open WhatsApp &rarr; Settings &rarr; Linked Devices &rarr; Link a Device
        </p>
      </div>
    );
  }

  if (state === "connected") {
    return (
      <div className="flex flex-col items-center gap-3 py-4">
        <CheckCircleIcon weight="fill" className="size-10 text-success" />
        <p className="text-sm font-medium text-success">Connected</p>
        {phoneNumber && <p className="text-xs text-muted-foreground">{phoneNumber}</p>}
      </div>
    );
  }

  if (state === "expired") {
    return (
      <div className="flex flex-col items-center gap-3 py-4">
        <div className="flex size-48 items-center justify-center rounded-lg border bg-muted">
          <p className="text-sm text-muted-foreground">QR code expired</p>
        </div>
        <Button variant="outline" size="sm" onClick={startPairing}>
          <ArrowClockwiseIcon className="size-3.5" />
          Refresh QR Code
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3 py-4">
      <WarningIcon className="size-8 text-destructive" />
      <p className="text-sm text-destructive">{errorMessage ?? "Something went wrong"}</p>
      <Button variant="outline" size="sm" onClick={startPairing}>
        <ArrowClockwiseIcon className="size-3.5" />
        Try Again
      </Button>
    </div>
  );
}
