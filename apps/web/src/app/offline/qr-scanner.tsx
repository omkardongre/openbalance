"use client";

import { BrowserQRCodeReader, type IScannerControls } from "@zxing/browser";
import { useEffect, useRef, useState } from "react";

/** Minimal shape of the Shape Detection API; it is not in TypeScript's DOM library yet. */
type NativeDetector = { detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>> };
type NativeDetectorClass = {
  new (options: { formats: string[] }): NativeDetector;
  getSupportedFormats(): Promise<string[]>;
};

/** Pause between native detection attempts; detection itself runs off the main thread. */
const NATIVE_SCAN_INTERVAL_MS = 120;

async function nativeQrDetector(): Promise<NativeDetector | undefined> {
  const Detector = (globalThis as { BarcodeDetector?: NativeDetectorClass }).BarcodeDetector;
  if (!Detector) return undefined;
  try {
    const formats = await Detector.getSupportedFormats();
    return formats.includes("qr_code") ? new Detector({ formats: ["qr_code"] }) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Rear camera at high resolution with continuous focus. Signed payment requests are dense QR
 * codes, and the browser's default 640x480 stream cannot resolve their modules.
 */
async function openCamera(): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
  });
  const [track] = stream.getVideoTracks();
  const capabilities = (track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & {
    focusMode?: string[];
    zoom?: { min: number; max: number };
  };
  const advanced: Record<string, unknown>[] = [];
  if (capabilities.focusMode?.includes("continuous")) advanced.push({ focusMode: "continuous" });
  // A little optical zoom lets the phone stay far enough away to focus on another phone's screen.
  if (capabilities.zoom && capabilities.zoom.max >= 1.5) advanced.push({ zoom: 1.5 });
  if (track && advanced.length > 0) {
    await track
      .applyConstraints({ advanced: advanced as MediaTrackConstraintSet[] })
      .catch(() => undefined);
  }
  return stream;
}

function cameraErrorMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError")
    return "Camera access is blocked. Allow the camera for this site in your browser settings, then try again.";
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return "No usable camera was found on this device.";
  if (name === "NotReadableError")
    return "The camera is in use by another app. Close it and try again.";
  return "The camera could not be started.";
}

export function QrScanner({
  title,
  hint,
  onResult,
  onCancel,
}: {
  title: string;
  hint: string;
  onResult: (text: string) => void;
  onCancel: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState<string>();
  const [ready, setReady] = useState(false);
  // Callbacks are read through refs so a parent re-render never restarts the camera.
  const handlers = useRef({ onResult, onCancel });
  handlers.current = { onResult, onCancel };

  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | undefined;
    let controls: IScannerControls | undefined;
    let timer: number | undefined;

    const finish = (text: string) => {
      if (stopped) return;
      stopped = true;
      navigator.vibrate?.(60);
      handlers.current.onResult(text);
    };

    (async () => {
      try {
        stream = await openCamera();
        const element = video.current;
        if (stopped || !element) return;
        const detector = await nativeQrDetector();
        if (stopped) return;
        if (detector) {
          element.srcObject = stream;
          await element.play();
          setReady(true);
          const tick = async () => {
            if (stopped) return;
            try {
              if (element.readyState >= element.HAVE_CURRENT_DATA) {
                const [code] = await detector.detect(element);
                if (code?.rawValue) return finish(code.rawValue);
              }
            } catch {
              // A frame that cannot be analysed is skipped; the next one is tried.
            }
            timer = window.setTimeout(tick, NATIVE_SCAN_INTERVAL_MS);
          };
          void tick();
        } else {
          controls = await new BrowserQRCodeReader(undefined, {
            delayBetweenScanAttempts: 100,
          }).decodeFromStream(stream, element, (result) => {
            if (result) finish(result.getText());
          });
          setReady(true);
        }
      } catch (cause) {
        if (!stopped) setError(cameraErrorMessage(cause));
      }
    })();

    return () => {
      stopped = true;
      window.clearTimeout(timer);
      controls?.stop();
      for (const track of stream?.getTracks() ?? []) track.stop();
    };
  }, []);

  // Modal behaviour: focus the close control, close on Escape, and keep the page behind still.
  useEffect(() => {
    closeButton.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") handlers.current.onCancel();
    };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div className="scanner" role="dialog" aria-modal="true" aria-labelledby="scanner-title">
      <video ref={video} className="scanner-video" muted playsInline aria-label="Camera preview" />
      <div className="scanner-top">
        <h2 id="scanner-title">{title}</h2>
        <button
          ref={closeButton}
          type="button"
          className="scanner-close"
          aria-label="Close scanner"
          onClick={onCancel}
        >
          ×
        </button>
      </div>
      {!error && (
        <div className="scanner-frame" aria-hidden="true">
          <span className="scanner-corner top-left" />
          <span className="scanner-corner top-right" />
          <span className="scanner-corner bottom-left" />
          <span className="scanner-corner bottom-right" />
          {ready && <span className="scanner-line" />}
        </div>
      )}
      <div className="scanner-bottom">
        <p role="status">{error ?? (ready ? hint : "Starting camera…")}</p>
        <button type="button" className="scanner-cancel" onClick={onCancel}>
          {error ? "Close" : "Cancel"}
        </button>
      </div>
    </div>
  );
}
