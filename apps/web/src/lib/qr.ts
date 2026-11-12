/**
 * Join QR codes: generation, safe scan parsing and camera helpers (US-07/08/18; SA §8.3; TASK-131).
 *
 * - The join link is always the configured app origin plus `/join?pin=<6 ASCII digits>`. PINs are
 *   strings, so leading zeros survive (`012345` never becomes `12345`).
 * - The QR is built from the `qrcode` module matrix (loaded lazily) and drawn as a plain SVG path with
 *   a 4-module quiet zone, black on white whatever the theme — no generated markup is injected.
 * - A scanned value is only ever reduced to a PIN: it must be an `http(s)` URL with exactly the
 *   configured origin, the `/join` path and a single `pin` parameter of six ASCII digits. Other
 *   sites, `javascript:`/`data:` URLs, credentials, extra parameters and fragments are rejected and
 *   the caller never navigates to the scanned text.
 * - The decoder is loaded only when the scanner opens: the native `BarcodeDetector` when it supports
 *   QR codes, otherwise ZXing (`@zxing/browser`). Camera access needs a secure context (HTTPS, or
 *   localhost in development) and a user gesture; every helper here stops all tracks it is given.
 */
import { pinCodeSchema } from "@kabuki-neko/shared/schemas/game.schema";

/** Path of the player join screen. */
export const JOIN_PATH = "/join";
/** Quiet zone around the QR symbol, in modules (the QR specification minimum is 4). */
export const QR_QUIET_ZONE = 4;
/** Longest scanned text that is parsed at all. */
const MAX_SCANNED_LENGTH = 2048;

/** Exact `http(s)` origin of a URL, or null for anything else (credentials, other schemes). */
export function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Configured public origin of the web app: `NEXT_PUBLIC_APP_URL` when valid, else the current page
 * origin in the browser, else null (server without configuration).
 */
export function configuredAppOrigin(): string | null {
  const configured = normalizeOrigin(process.env.NEXT_PUBLIC_APP_URL ?? "");
  if (configured) return configured;
  if (typeof window !== "undefined") return normalizeOrigin(window.location.origin);
  return null;
}

/** True for a six-ASCII-digit PIN string (fullwidth or other Unicode digits are rejected). */
export function isValidPin(pin: string): boolean {
  return pinCodeSchema.safeParse(pin).success;
}

/** Same-origin join link for a PIN; throws on an invalid origin or PIN. */
export function buildJoinUrl(origin: string, pin: string): string {
  const base = normalizeOrigin(origin);
  if (!base) throw new Error("Invalid app origin");
  if (!isValidPin(pin)) throw new Error("Invalid PIN");
  return `${base}${JOIN_PATH}?pin=${pin}`;
}

/** Result of parsing a scanned QR value. */
export type ScannedJoin =
  { ok: true; pin: string } | { ok: false; reason: "wrongOrigin" | "invalid" };

/**
 * Reduces a scanned QR text to a PIN, accepting only `${allowedOrigin}/join?pin=NNNNNN`.
 * `wrongOrigin` marks a well-formed web link for another site; everything else is `invalid`.
 */
export function parseScannedJoin(text: string, allowedOrigin: string): ScannedJoin {
  const origin = normalizeOrigin(allowedOrigin);
  const value = text.trim();
  if (!origin || value === "" || value.length > MAX_SCANNED_LENGTH)
    return { ok: false, reason: "invalid" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return { ok: false, reason: "invalid" };
  if (url.username || url.password) return { ok: false, reason: "invalid" };
  if (url.origin !== origin) return { ok: false, reason: "wrongOrigin" };
  if (url.pathname !== JOIN_PATH || url.hash !== "") return { ok: false, reason: "invalid" };
  const keys = [...url.searchParams.keys()];
  const pins = url.searchParams.getAll("pin");
  const pin = pins[0] ?? "";
  if (keys.length !== 1 || pins.length !== 1 || !isValidPin(pin))
    return { ok: false, reason: "invalid" };
  return { ok: true, pin };
}

/** Square module matrix of a QR symbol (true = dark). */
export interface QrMatrix {
  size: number;
  isDark: (row: number, col: number) => boolean;
}

/** Builds the QR module matrix for a text (lazy `qrcode` import, error correction M). */
export async function createQrMatrix(text: string): Promise<QrMatrix> {
  const { create } = await import("qrcode");
  const symbol = create(text, { errorCorrectionLevel: "M" });
  const { size, data } = symbol.modules;
  return { size, isDark: (row, col) => data[row * size + col] === 1 };
}

/** SVG drawing of a matrix: viewBox side (symbol + quiet zone) and one path of 1×1 dark squares. */
export interface QrSvgPath {
  viewBox: number;
  path: string;
}

/** Converts a matrix to an SVG path with the quiet zone included in the coordinates. */
export function qrSvgPath(matrix: QrMatrix, quietZone = QR_QUIET_ZONE): QrSvgPath {
  const parts: string[] = [];
  for (let row = 0; row < matrix.size; row += 1)
    for (let col = 0; col < matrix.size; col += 1)
      if (matrix.isDark(row, col)) parts.push(`M${col + quietZone} ${row + quietZone}h1v1h-1z`);
  return { viewBox: matrix.size + quietZone * 2, path: parts.join("") };
}

/** Why the camera cannot be used before asking for it. */
export type CameraSupport = "ok" | "insecure" | "unsupported";

/** Minimal media-devices surface used by the scanner (injectable in tests). */
export interface MediaDevicesLike {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  enumerateDevices?: () => Promise<MediaDeviceInfo[]>;
}

/** Whether camera capture is possible here (secure context + getUserMedia). */
export function cameraSupport(
  devices: MediaDevicesLike | undefined,
  secureContext: boolean,
): CameraSupport {
  if (!secureContext) return "insecure";
  if (!devices || typeof devices.getUserMedia !== "function") return "unsupported";
  return "ok";
}

/** Camera constraints: a specific device, else the rear camera when there is one. */
export function cameraConstraints(deviceId?: string): MediaStreamConstraints {
  return {
    audio: false,
    video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: "environment" } },
  };
}

/** Camera failure categories shown to the player. */
export type CameraFailure = "denied" | "noCamera" | "unavailable";

/** Maps a getUserMedia rejection to a failure category. */
export function classifyCameraError(error: unknown): CameraFailure {
  const name = error instanceof Error || error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError")
    return "denied";
  if (
    name === "NotFoundError" ||
    name === "OverconstrainedError" ||
    name === "DevicesNotFoundError"
  )
    return "noCamera";
  return "unavailable";
}

/** Stops every track of a stream (camera light off); safe with null. */
export function stopStream(stream: MediaStream | null | undefined): void {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
}

/** Decodes one video frame; resolves to the QR text or null when none is visible. */
export type QrFrameDecoder = (video: HTMLVideoElement) => Promise<string | null>;

/** Native `BarcodeDetector` surface (not yet in the TypeScript DOM library). */
interface BarcodeDetectorLike {
  detect: (source: HTMLVideoElement) => Promise<{ rawValue: string }[]>;
}
/** Native `BarcodeDetector` constructor. */
interface BarcodeDetectorConstructor {
  new (options: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
}

/** True once the video has a frame to read (HAVE_CURRENT_DATA). */
function hasFrame(video: HTMLVideoElement): boolean {
  return video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;
}

/**
 * Loads a frame decoder: native `BarcodeDetector` for `qr_code` when available, else ZXing
 * (imported only now). Resolves to null when neither can load.
 */
export async function loadQrDecoder(): Promise<QrFrameDecoder | null> {
  const Native = (globalThis as { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;
  if (Native) {
    try {
      const formats = (await Native.getSupportedFormats?.()) ?? [];
      if (formats.includes("qr_code")) {
        const detector = new Native({ formats: ["qr_code"] });
        return async (video) => {
          if (!hasFrame(video)) return null;
          const [first] = await detector.detect(video);
          return first?.rawValue ?? null;
        };
      }
    } catch {
      // Fall through to ZXing.
    }
  }
  try {
    const { BrowserQRCodeReader } = await import("@zxing/browser");
    const reader = new BrowserQRCodeReader();
    const canvas = document.createElement("canvas");
    return async (video) => {
      if (!hasFrame(video)) return null;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
      try {
        return reader.decodeFromCanvas(canvas).getText();
      } catch {
        return null; // No QR code in this frame.
      }
    };
  } catch {
    return null;
  }
}
