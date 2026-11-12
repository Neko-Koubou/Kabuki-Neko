/**
 * TASK-131 coverage for join QR codes: same-origin join links that keep leading-zero PINs; the scan
 * parser that rejects other origins, script/data URLs, credentials, extra parameters and non-ASCII
 * digits; a visual roundtrip (generated SVG path → rasterized pixels → ZXing decode → PIN) with the
 * quiet zone intact; camera helpers; the M02 scanner (camera only after a gesture, wrong-origin
 * guidance without navigation, a single PIN report, track teardown on success, stop, close, switch
 * and late streams, denied/no-camera/insecure manual fallbacks); and the M07 dialog (QR + link +
 * PIN, copy success, copy failure with manual selection, no clipboard, generation error, empty).
 */
import { BinaryBitmap, HybridBinarizer, QRCodeReader, RGBLuminanceSource } from "@zxing/library";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QrDialog } from "@/components/host/qr-dialog";
import { QrScanner, type QrScannerProps } from "@/components/player/qr-scanner";
import { renderWithLocale } from "@/test/locale";
import {
  buildJoinUrl,
  cameraConstraints,
  cameraSupport,
  classifyCameraError,
  createQrMatrix,
  normalizeOrigin,
  parseScannedJoin,
  QR_QUIET_ZONE,
  qrSvgPath,
  stopStream,
  type MediaDevicesLike,
  type QrFrameDecoder,
} from "./qr";

const ORIGIN = "https://kabuki.example";
const NAMESPACES = ["common", "accessibility", "player", "host"] as const;

/** Rasterizes the SVG path drawn by the app (1×1 squares) into a luminance buffer. */
function rasterize(svg: { viewBox: number; path: string }, scale: number) {
  const side = svg.viewBox * scale;
  const pixels = new Uint8ClampedArray(side * side).fill(255);
  const squares = [...svg.path.matchAll(/M(\d+) (\d+)h1v1h-1z/gu)];
  expect(squares.length).toBeGreaterThan(0);
  expect(squares.map((m) => m[0]).join("")).toBe(svg.path);
  for (const square of squares) {
    const x = Number(square[1]);
    const y = Number(square[2]);
    for (let dy = 0; dy < scale; dy += 1)
      for (let dx = 0; dx < scale; dx += 1) pixels[(y * scale + dy) * side + x * scale + dx] = 0;
  }
  return { pixels, side, squares };
}

/** Decodes a luminance buffer with ZXing's QR reader. */
function decode(pixels: Uint8ClampedArray, side: number): string {
  const source = new RGBLuminanceSource(pixels, side, side);
  return new QRCodeReader().decode(new BinaryBitmap(new HybridBinarizer(source))).getText();
}

describe("join links and scan parsing", () => {
  it("builds same-origin join links and keeps leading-zero PINs", () => {
    expect(buildJoinUrl(ORIGIN, "012345")).toBe(`${ORIGIN}/join?pin=012345`);
    expect(buildJoinUrl(`${ORIGIN}/some/page?x=1`, "000000")).toBe(`${ORIGIN}/join?pin=000000`);
    for (const pin of ["12345", "1234567", "12345a", " 123456", "１２３４５６", "١٢٣٤٥٦"])
      expect(() => buildJoinUrl(ORIGIN, pin)).toThrow("Invalid PIN");
    expect(() => buildJoinUrl("javascript:alert(1)", "123456")).toThrow("Invalid app origin");
    expect(normalizeOrigin("https://user:pw@kabuki.example")).toBeNull();
    expect(normalizeOrigin("ftp://kabuki.example")).toBeNull();
  });

  it("accepts only the configured origin, /join and six ASCII digits", () => {
    expect(parseScannedJoin(`${ORIGIN}/join?pin=012345`, ORIGIN)).toEqual({
      ok: true,
      pin: "012345",
    });
    expect(parseScannedJoin(`  ${ORIGIN}/join?pin=000001\n`, `${ORIGIN}/`)).toEqual({
      ok: true,
      pin: "000001",
    });
    const foreign = [
      "https://evil.example/join?pin=123456",
      "http://kabuki.example/join?pin=123456",
      "https://kabuki.example:8443/join?pin=123456",
      "https://kabuki.example.evil.example/join?pin=123456",
    ];
    for (const text of foreign)
      expect(parseScannedJoin(text, ORIGIN)).toEqual({ ok: false, reason: "wrongOrigin" });
    const invalid = [
      "javascript:alert(1)//https://kabuki.example/join?pin=123456",
      "JaVaScRiPt:fetch('https://kabuki.example/join?pin=123456')",
      "data:text/html,<script>alert(1)</script>",
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      "vbscript:msgbox(1)",
      "https://user:pw@kabuki.example/join?pin=123456",
      "https://kabuki.example@evil.example/join?pin=123456",
      "https://kabuki.example/admin?pin=123456",
      "https://kabuki.example/join/../admin?pin=123456",
      "https://kabuki.example/joinx?pin=123456",
      "https://kabuki.example/join?pin=123456&next=https://evil.example",
      "https://kabuki.example/join?pin=123456&pin=654321",
      "https://kabuki.example/join?pin=123456#https://evil.example",
      "https://kabuki.example/join?pin=１２３４５６",
      "https://kabuki.example/join?pin=1234567",
      "https://kabuki.example/join",
      "123456",
      "not a url",
      "",
      `${ORIGIN}/join?pin=123456&x=${"a".repeat(3000)}`,
    ];
    for (const text of invalid)
      expect(parseScannedJoin(text, ORIGIN)).toEqual({ ok: false, reason: "invalid" });
    expect(parseScannedJoin(`${ORIGIN}/join?pin=123456`, "not an origin")).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("roundtrips the drawn QR code through a decoder with the quiet zone intact", async () => {
    const url = buildJoinUrl(ORIGIN, "012345");
    const matrix = await createQrMatrix(url);
    const svg = qrSvgPath(matrix);
    expect(svg.viewBox).toBe(matrix.size + QR_QUIET_ZONE * 2);
    const { pixels, side, squares } = rasterize(svg, 4);
    // Quiet zone: no dark module within four modules of any edge.
    for (const square of squares) {
      const x = Number(square[1]);
      const y = Number(square[2]);
      expect(x).toBeGreaterThanOrEqual(QR_QUIET_ZONE);
      expect(y).toBeGreaterThanOrEqual(QR_QUIET_ZONE);
      expect(x).toBeLessThan(svg.viewBox - QR_QUIET_ZONE);
      expect(y).toBeLessThan(svg.viewBox - QR_QUIET_ZONE);
    }
    const text = decode(pixels, side);
    expect(text).toBe(`${ORIGIN}/join?pin=012345`);
    expect(parseScannedJoin(text, ORIGIN)).toEqual({ ok: true, pin: "012345" });
  });
});

describe("camera helpers", () => {
  it("classifies support and errors, builds constraints and stops every track", () => {
    const devices: MediaDevicesLike = { getUserMedia: vi.fn() };
    expect(cameraSupport(devices, false)).toBe("insecure");
    expect(cameraSupport(undefined, true)).toBe("unsupported");
    expect(cameraSupport(devices, true)).toBe("ok");
    expect(classifyCameraError(new DOMException("no", "NotAllowedError"))).toBe("denied");
    expect(classifyCameraError(new DOMException("no", "SecurityError"))).toBe("denied");
    expect(classifyCameraError(new DOMException("none", "NotFoundError"))).toBe("noCamera");
    expect(classifyCameraError(new DOMException("busy", "NotReadableError"))).toBe("unavailable");
    expect(classifyCameraError("weird")).toBe("unavailable");
    expect(cameraConstraints()).toEqual({
      audio: false,
      video: { facingMode: { ideal: "environment" } },
    });
    expect(cameraConstraints("cam-2")).toEqual({
      audio: false,
      video: { deviceId: { exact: "cam-2" } },
    });
    const { stream, tracks } = fakeStream("cam-1", 2);
    stopStream(stream);
    stopStream(null);
    for (const track of tracks) expect(track.stop).toHaveBeenCalledTimes(1);
  });
});

/** Fake camera stream with spy tracks. */
function fakeStream(deviceId: string, count = 1) {
  const tracks = Array.from({ length: count }, () => ({
    kind: "video",
    stop: vi.fn(),
    addEventListener: vi.fn(),
    getSettings: () => ({ deviceId }),
  }));
  const stream = {
    getTracks: () => tracks,
    getVideoTracks: () => tracks,
  } as unknown as MediaStream;
  return { stream, tracks };
}

/** Fake media devices: one stream per getUserMedia call, with the given cameras. */
function fakeDevices(cameraIds: string[] = ["cam-1"]) {
  const streams: ReturnType<typeof fakeStream>[] = [];
  const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
    const video = constraints.video as { deviceId?: { exact: string } };
    const next = fakeStream(video.deviceId?.exact ?? cameraIds[0] ?? "cam-1");
    streams.push(next);
    return next.stream;
  });
  const enumerateDevices = vi.fn(
    async () =>
      cameraIds.map((deviceId) => ({ kind: "videoinput", deviceId })) as MediaDeviceInfo[],
  );
  return { devices: { getUserMedia, enumerateDevices }, streams, getUserMedia };
}

/** Decoder returning queued texts, then null. */
function queuedDecoder(texts: (string | null)[]) {
  const queue = [...texts];
  const decoder: QrFrameDecoder = vi.fn(async () =>
    queue.length > 0 ? (queue.shift() ?? null) : null,
  );
  return decoder;
}

/** Renders the scanner with test doubles. */
function renderScanner(props: Partial<QrScannerProps> = {}) {
  const onClose = vi.fn();
  const onPin = vi.fn();
  const onManualEntry = vi.fn();
  const view = renderWithLocale(
    createElement(QrScanner, {
      open: true,
      onClose,
      onPin,
      onManualEntry,
      allowedOrigin: ORIGIN,
      secureContext: true,
      scanIntervalMs: 5,
      loadDecoder: async () => queuedDecoder([]),
      ...props,
    }),
    { namespaces: [...NAMESPACES] },
  );
  return { ...view, onClose, onPin, onManualEntry };
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
});

describe("QrScanner (M02)", () => {
  it("opens the camera only after a gesture, ignores foreign QR codes and reports the PIN once", async () => {
    const user = userEvent.setup();
    const { devices, streams, getUserMedia } = fakeDevices();
    const decoder = queuedDecoder([
      "https://evil.example/join?pin=123456",
      "javascript:alert(1)",
      `${ORIGIN}/join?pin=012345`,
      `${ORIGIN}/join?pin=999999`,
    ]);
    const href = window.location.href;
    const { onPin } = renderScanner({ mediaDevices: devices, loadDecoder: async () => decoder });
    const dialog = await screen.findByRole("dialog", { name: "Scan QR code" });
    expect(getUserMedia).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Allow camera access" }));
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: { facingMode: { ideal: "environment" } },
    });
    await waitFor(() => expect(onPin).toHaveBeenCalledTimes(1));
    expect(onPin).toHaveBeenCalledWith("012345");
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "QR code recognized. Checking the game…",
    );
    // Success releases the camera and stops decoding (the later valid code is never reported).
    expect(streams[0]?.tracks[0]?.stop).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(onPin).toHaveBeenCalledTimes(1);
    expect(window.location.href).toBe(href);
  });

  it("shows wrong-origin and invalid-QR guidance while scanning continues", async () => {
    const user = userEvent.setup();
    const { devices, streams } = fakeDevices();
    let next: string | null = "https://evil.example/join?pin=123456";
    const decoder: QrFrameDecoder = async () => next;
    const { onPin } = renderScanner({ mediaDevices: devices, loadDecoder: async () => decoder });
    await user.click(await screen.findByRole("button", { name: "Allow camera access" }));
    expect(
      await screen.findByText("This QR code is for a different site and won't be opened."),
    ).toBeInTheDocument();
    next = "data:text/html,<script>alert(1)</script>";
    expect(await screen.findByText("This isn't a game QR code.")).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
    expect(onPin).not.toHaveBeenCalled();
    expect(streams[0]?.tracks[0]?.stop).not.toHaveBeenCalled();
    // Stop camera releases the stream and returns to the start button.
    await user.click(screen.getByRole("button", { name: "Stop camera" }));
    expect(streams[0]?.tracks[0]?.stop).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Allow camera access" })).toBeInTheDocument();
  });

  it("stops the tracks when the dialog closes or unmounts", async () => {
    const user = userEvent.setup();
    const { devices, streams } = fakeDevices();
    const { onClose, rerender, unmount } = renderScanner({ mediaDevices: devices });
    await user.click(await screen.findByRole("button", { name: "Allow camera access" }));
    await screen.findByRole("button", { name: "Stop camera" });
    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(streams[0]?.tracks[0]?.stop).toHaveBeenCalledTimes(1);

    // Parent closes the dialog: the second stream is released as well.
    await user.click(screen.getByRole("button", { name: "Allow camera access" }));
    await screen.findByRole("button", { name: "Stop camera" });
    rerender(
      createElement(QrScanner, {
        open: false,
        onClose,
        onPin: vi.fn(),
        onManualEntry: vi.fn(),
        allowedOrigin: ORIGIN,
        secureContext: true,
        mediaDevices: devices,
      }),
    );
    expect(streams[1]?.tracks[0]?.stop).toHaveBeenCalledTimes(1);
    unmount();
    expect(streams[1]?.tracks[0]?.stop).toHaveBeenCalledTimes(1);
  });

  it("releases a stream that arrives after the dialog was closed", async () => {
    const user = userEvent.setup();
    const late = fakeStream("cam-1");
    let grant: (stream: MediaStream) => void = () => {};
    const devices: MediaDevicesLike = {
      getUserMedia: () =>
        new Promise<MediaStream>((resolve) => {
          grant = resolve;
        }),
    };
    const { onClose } = renderScanner({ mediaDevices: devices });
    await user.click(await screen.findByRole("button", { name: "Allow camera access" }));
    expect(screen.getByRole("status")).toHaveTextContent("Opening the camera…");
    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(onClose).toHaveBeenCalled();
    await act(async () => grant(late.stream));
    expect(late.tracks[0]?.stop).toHaveBeenCalledTimes(1);
  });

  it("switches cameras, stopping the previous stream", async () => {
    const user = userEvent.setup();
    const { devices, streams, getUserMedia } = fakeDevices(["cam-1", "cam-2"]);
    renderScanner({ mediaDevices: devices });
    await user.click(await screen.findByRole("button", { name: "Allow camera access" }));
    await user.click(await screen.findByRole("button", { name: "Switch camera" }));
    expect(streams[0]?.tracks[0]?.stop).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenLastCalledWith({
      audio: false,
      video: { deviceId: { exact: "cam-2" } },
    });
    await screen.findByRole("button", { name: "Stop camera" });
    expect(streams[1]?.tracks[0]?.stop).not.toHaveBeenCalled();
  });

  it("falls back to manual PIN entry when denied, without a camera or in an insecure context", async () => {
    const user = userEvent.setup();
    const denied: MediaDevicesLike = {
      getUserMedia: vi.fn().mockRejectedValue(new DOMException("no", "NotAllowedError")),
    };
    const first = renderScanner({ mediaDevices: denied });
    await user.click(await screen.findByRole("button", { name: "Allow camera access" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Camera access was denied.");
    await user.click(screen.getByRole("button", { name: "Enter the PIN instead" }));
    expect(first.onManualEntry).toHaveBeenCalledTimes(1);
    first.unmount();

    const none: MediaDevicesLike = {
      getUserMedia: vi.fn().mockRejectedValue(new DOMException("none", "NotFoundError")),
    };
    const second = renderScanner({ mediaDevices: none });
    await user.click(await screen.findByRole("button", { name: "Allow camera access" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No camera found. Enter the PIN instead.",
    );
    second.unmount();

    const insecure: MediaDevicesLike = { getUserMedia: vi.fn() };
    renderScanner({ mediaDevices: insecure, secureContext: false });
    await user.click(await screen.findByRole("button", { name: "Allow camera access" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Scanning isn't supported on this device.",
    );
    expect(insecure.getUserMedia).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Enter the PIN instead" })).toBeInTheDocument();
  });
});

describe("QrDialog (M07)", () => {
  it("shows the QR, link and PIN and copies the link", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    renderWithLocale(
      createElement(QrDialog, {
        open: true,
        onClose: () => {},
        pin: "012345",
        origin: ORIGIN,
        clipboard: { writeText },
      }),
      { namespaces: [...NAMESPACES] },
    );
    const dialog = await screen.findByRole("dialog", { name: "Join with a QR code" });
    const image = await within(dialog).findByRole("img", { name: "Join with a QR code" });
    expect(image.getAttribute("viewBox")).toMatch(/^0 0 \d+ \d+$/u);
    expect(image.querySelector("rect")).toHaveAttribute("fill", "#ffffff");
    expect(image.querySelector("path")).toHaveAttribute("fill", "#000000");
    expect(within(dialog).getByText(`${ORIGIN}/join?pin=012345`)).toBeInTheDocument();
    expect(within(dialog).getByText("012345")).toBeInTheDocument();
    // The drawn image decodes back to the join link.
    const viewBox = Number(image.getAttribute("viewBox")?.split(" ")[2]);
    const drawn = rasterize(
      { viewBox, path: image.querySelector("path")?.getAttribute("d") ?? "" },
      3,
    );
    expect(decode(drawn.pixels, drawn.side)).toBe(`${ORIGIN}/join?pin=012345`);
    await user.click(within(dialog).getByRole("button", { name: "Copy link" }));
    expect(writeText).toHaveBeenCalledWith(`${ORIGIN}/join?pin=012345`);
    expect(within(dialog).getByRole("status")).toHaveTextContent("Link copied");
  });

  it("selects the link for manual copy when copying fails or is unavailable", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    const { rerender } = renderWithLocale(
      createElement(QrDialog, {
        open: true,
        onClose: () => {},
        pin: "000777",
        origin: ORIGIN,
        clipboard: { writeText },
      }),
      { namespaces: [...NAMESPACES] },
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Copy link" }));
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "The link couldn't be copied. Select the link and copy it manually.",
    );
    expect(window.getSelection()?.toString()).toBe(`${ORIGIN}/join?pin=000777`);
    rerender(
      createElement(QrDialog, {
        open: true,
        onClose: () => {},
        pin: "000777",
        origin: ORIGIN,
        clipboard: null,
      }),
    );
    expect(within(dialog).queryByRole("button", { name: "Copy link" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("note")).toHaveTextContent(
      "Copying isn't available here. Select the link and copy it manually.",
    );
  });

  it("keeps the link and PIN when the QR fails, and waits for a room PIN", async () => {
    const { rerender } = renderWithLocale(
      createElement(QrDialog, {
        open: true,
        onClose: () => {},
        pin: "123456",
        origin: ORIGIN,
        clipboard: null,
        generate: async () => {
          throw new Error("boom");
        },
      }),
      { namespaces: [...NAMESPACES] },
    );
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "The QR code couldn't be created. Players can still join with the link or PIN.",
    );
    expect(within(dialog).getByText(`${ORIGIN}/join?pin=123456`)).toBeInTheDocument();
    expect(within(dialog).getByText("123456")).toBeInTheDocument();
    rerender(createElement(QrDialog, { open: true, onClose: () => {}, pin: null, origin: ORIGIN }));
    expect(
      within(dialog).getByText("The join link will appear once the room is ready."),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole("img")).not.toBeInTheDocument();
  });
});
