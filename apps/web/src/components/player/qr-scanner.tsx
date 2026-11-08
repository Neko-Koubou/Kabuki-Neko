"use client";
/**
 * M02 QR scanner dialog (US-07/08/18; Design §4.9 M02; SA §8.3; TASK-131).
 *
 * - The camera opens only after the player presses "Allow camera access" (user gesture), and only
 *   in a secure context with getUserMedia; otherwise the dialog explains it and offers manual PIN
 *   entry. Denied permission, no camera and other failures always lead to "Enter the PIN instead".
 * - The QR decoder is loaded lazily when the camera starts (native BarcodeDetector or ZXing).
 * - A scanned value is reduced to a PIN by `parseScannedJoin`: only the configured origin, `/join`
 *   and six ASCII digits pass. QR codes for other sites or other content show guidance and scanning
 *   continues — the dialog never navigates to a scanned URL. A recognized PIN is reported once
 *   through `onPin`; the parent checks it.
 * - Every camera track is stopped on success, on "Stop camera", when switching camera, when the
 *   dialog closes or unmounts, and when a stream arrives after the dialog was closed.
 * - The dialog is the shared full-height ModalSheet (focus trap, Escape, focus return).
 */
import { CameraOff, ScanQrCode } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActionButton } from "@/components/ui/action-button";
import { ModalSheet } from "@/components/ui/modal-sheet";
import {
  cameraConstraints,
  cameraSupport,
  classifyCameraError,
  configuredAppOrigin,
  loadQrDecoder,
  parseScannedJoin,
  stopStream,
  type CameraFailure,
  type MediaDevicesLike,
  type QrFrameDecoder,
} from "@/lib/qr";
import { useLocale } from "@/providers/locale-provider";

/** Delay between decoded frames (ms). */
const DEFAULT_SCAN_INTERVAL_MS = 250;

/** Props of {@link QrScanner}. */
export interface QrScannerProps {
  open: boolean;
  onClose: () => void;
  /** Called once with the PIN of a recognized join QR code. */
  onPin: (pin: string) => void;
  /** Switches to manual PIN entry (offered in every state). */
  onManualEntry: () => void;
  /** Accepted join origin; defaults to the configured app origin. */
  allowedOrigin?: string;
  /** Media devices (tests); defaults to `navigator.mediaDevices`. */
  mediaDevices?: MediaDevicesLike;
  /** Secure-context flag (tests); defaults to `window.isSecureContext`. */
  secureContext?: boolean;
  /** Decoder loader (tests); defaults to the lazy native/ZXing loader. */
  loadDecoder?: () => Promise<QrFrameDecoder | null>;
  scanIntervalMs?: number;
}

/** Scanner state machine. */
type ScannerPhase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "scanning"; notice: "wrongOrigin" | "invalid" | null }
  | { kind: "recognized" }
  | { kind: "failed"; reason: CameraFailure | "insecure" | "unsupported" };

/** The QR scanner dialog. */
export function QrScanner({
  open,
  onClose,
  onPin,
  onManualEntry,
  allowedOrigin,
  mediaDevices,
  secureContext,
  loadDecoder = loadQrDecoder,
  scanIntervalMs = DEFAULT_SCAN_INTERVAL_MS,
}: QrScannerProps) {
  const { t } = useLocale();
  const [phase, setPhase] = useState<ScannerPhase>({ kind: "idle" });
  const [cameras, setCameras] = useState<string[]>([]);
  const [cameraIndex, setCameraIndex] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const allowRef = useRef<HTMLButtonElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Incremented on every stop; async steps of an older session bail out. */
  const sessionRef = useRef(0);
  const latest = useRef({ onPin, loadDecoder, allowedOrigin, mediaDevices, secureContext });
  latest.current = { onPin, loadDecoder, allowedOrigin, mediaDevices, secureContext };

  /** Stops scanning: cancels the loop and stops every camera track. */
  const stop = useCallback(() => {
    sessionRef.current += 1;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    stopStream(streamRef.current);
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  /** Starts the camera (optionally a given device) and the decode loop. */
  const start = useCallback(
    async (deviceId?: string) => {
      stop();
      const session = sessionRef.current;
      const current = latest.current;
      const devices =
        current.mediaDevices ??
        (typeof navigator === "undefined" ? undefined : navigator.mediaDevices);
      const secure =
        current.secureContext ?? (typeof window !== "undefined" && window.isSecureContext);
      const support = cameraSupport(devices, secure);
      if (support !== "ok" || !devices) {
        setPhase({ kind: "failed", reason: support === "insecure" ? "insecure" : "unsupported" });
        return;
      }
      const origin = current.allowedOrigin ?? configuredAppOrigin() ?? "";
      setPhase({ kind: "starting" });
      const decoderLoad = current.loadDecoder().catch(() => null);
      let stream: MediaStream;
      try {
        stream = await devices.getUserMedia(cameraConstraints(deviceId));
      } catch (error) {
        if (session === sessionRef.current)
          setPhase({ kind: "failed", reason: classifyCameraError(error) });
        return;
      }
      // Closed or restarted while the permission prompt was open: release the camera now.
      if (session !== sessionRef.current) {
        stopStream(stream);
        return;
      }
      streamRef.current = stream;
      for (const track of stream.getTracks())
        track.addEventListener?.("ended", () => {
          if (session !== sessionRef.current) return;
          stop();
          setPhase({ kind: "failed", reason: "unavailable" });
        });
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        video.play()?.catch(() => {});
      }
      const decoder = await decoderLoad;
      if (session !== sessionRef.current) return;
      if (!decoder) {
        stop();
        setPhase({ kind: "failed", reason: "unsupported" });
        return;
      }
      const list = await Promise.resolve(devices.enumerateDevices?.()).catch(() => undefined);
      const ids = (list ?? [])
        .filter((d) => d.kind === "videoinput" && d.deviceId)
        .map((d) => d.deviceId);
      if (session !== sessionRef.current) return;
      setCameras(ids);
      if (deviceId) setCameraIndex(Math.max(0, ids.indexOf(deviceId)));
      setPhase({ kind: "scanning", notice: null });

      /** One decode attempt; reschedules itself until a valid join QR is found. */
      const tick = async () => {
        const element = videoRef.current;
        if (session !== sessionRef.current || !element) return;
        const text = await decoder(element).catch(() => null);
        if (session !== sessionRef.current) return;
        if (text !== null) {
          const result = parseScannedJoin(text, origin);
          if (result.ok) {
            stop();
            setPhase({ kind: "recognized" });
            latest.current.onPin(result.pin);
            return;
          }
          setPhase({ kind: "scanning", notice: result.reason });
        }
        timerRef.current = setTimeout(() => void tick(), scanIntervalMs);
      };
      timerRef.current = setTimeout(() => void tick(), scanIntervalMs);
    },
    [stop, scanIntervalMs],
  );

  // Closing the dialog (or leaving the page) always releases the camera.
  useEffect(() => {
    if (!open) {
      stop();
      setPhase({ kind: "idle" });
    }
  }, [open, stop]);
  useEffect(() => stop, [stop]);

  /** Close request from the dialog chrome. */
  const close = () => {
    stop();
    setPhase({ kind: "idle" });
    onClose();
  };

  /** Manual PIN entry: stop the camera first. */
  const manual = () => {
    stop();
    onManualEntry();
  };

  /** Stop camera: back to the idle state (the player may start it again). */
  const stopCamera = () => {
    stop();
    setPhase({ kind: "idle" });
  };

  /** Switches to the next camera device. */
  const switchCamera = () => {
    const next = (cameraIndex + 1) % cameras.length;
    setCameraIndex(next);
    void start(cameras[next]);
  };

  const live = phase.kind === "starting" || phase.kind === "scanning";
  let status: string | null = null;
  if (phase.kind === "starting") status = t("player.inventory.m02.loading");
  else if (phase.kind === "scanning" && phase.notice === "wrongOrigin")
    status = t("player.scanner.wrongOrigin");
  else if (phase.kind === "scanning" && phase.notice === "invalid")
    status = t("player.scanner.invalidQr");
  else if (phase.kind === "recognized") status = t("player.inventory.m02.ideal");

  let failure: string | null = null;
  if (phase.kind === "failed") {
    if (phase.reason === "denied") failure = t("player.scanner.permissionDenied");
    else if (phase.reason === "noCamera") failure = t("player.inventory.m02.empty");
    else if (phase.reason === "unavailable") failure = t("player.inventory.m02.error");
    else failure = t("player.scanner.unsupported");
  }

  return (
    <ModalSheet
      open={open}
      title={t("player.scanner.title")}
      size="normal"
      fullHeight
      initialFocus={allowRef}
      onCloseRequest={close}
      footer={
        <div className="flex flex-wrap gap-2">
          {phase.kind === "scanning" && cameras.length > 1 && (
            <ActionButton
              variant="secondary"
              label={t("player.scanner.switchCamera")}
              onPress={switchCamera}
            />
          )}
          {live && (
            <ActionButton
              variant="secondary"
              label={t("player.scanner.stopCamera")}
              onPress={stopCamera}
            />
          )}
          <ActionButton
            variant={phase.kind === "failed" ? "primary" : "ghost"}
            label={t("player.scanner.manualPin")}
            onPress={manual}
          />
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <div
          className={`relative mx-auto aspect-square w-full max-w-[360px] overflow-hidden rounded-md ${live ? "bg-black" : "bg-subtle"}`}
        >
          <video
            ref={videoRef}
            muted
            playsInline
            autoPlay
            aria-hidden="true"
            className={`size-full object-cover ${live ? "" : "hidden"}`}
          />
          {/* Camera placeholder before/after scanning (same size as the preview). */}
          {!live && (
            <div
              aria-hidden="true"
              className="absolute inset-0 flex items-center justify-center text-muted-foreground"
            >
              {phase.kind === "failed" ? (
                <CameraOff className="size-16" />
              ) : (
                <ScanQrCode className="size-16" />
              )}
            </div>
          )}
          {/* Aiming frame. */}
          <div
            aria-hidden="true"
            className={`pointer-events-none absolute inset-[15%] rounded-md border-4 ${live ? "border-white/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" : "border-dashed border-border"}`}
          />
        </div>
        {(phase.kind === "idle" || (phase.kind === "failed" && phase.reason === "unavailable")) && (
          <ActionButton
            ref={allowRef}
            size="lg"
            label={t("player.scanner.allowCamera")}
            onPress={() => void start()}
          />
        )}
        {failure && (
          <p role="alert" className="text-small text-danger">
            {failure}
          </p>
        )}
        <p role="status" aria-live="polite" className="min-h-6 text-small">
          {status}
        </p>
      </div>
    </ModalSheet>
  );
}
