/**
 * Browser security headers for every page (SA §10.1; Design §7.2; US-01/06/18/20; TASK-164).
 *
 * Next.js 16 runs this proxy before each page request. It creates a fresh nonce and sends a strict
 * Content-Security-Policy. Next reads the nonce from the request's CSP header and stamps it on its
 * own scripts. Every page is dynamic (the root layout reads cookies and headers), so each response
 * carries its own nonce.
 *
 * Policy:
 * - `script-src 'self' 'nonce-…' 'strict-dynamic'`. No `unsafe-eval` and no `unsafe-inline` in
 *   production. Development adds `unsafe-eval` only for React's dev tooling.
 * - `style-src 'self' 'unsafe-inline'`: React renders `style` attributes, and CSS cannot run
 *   scripts.
 * - `img-src` / `media-src`: self, `blob:` and `data:` (avatars, local previews), plus the API
 *   origin that serves `/uploads` and any public media origins in `CSP_MEDIA_ORIGINS`
 *   (comma-separated, e.g. an S3 public bucket URL, read at runtime).
 * - `connect-src`: self, the API origin, and the WebSocket origin with its ws/wss form.
 * - `frame-src https://www.youtube-nocookie.com` only (privacy-enhanced embeds).
 * - `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'self'`.
 * Other headers:
 * - `X-Content-Type-Options: nosniff`;
 * - `Referrer-Policy: strict-origin-when-cross-origin`;
 * - `Permissions-Policy`: camera for this origin (QR scanner), no microphone, geolocation or
 *   payment.
 * HSTS is set by the HTTPS reverse proxy in front of the app (see docs/security-headers.md), never
 * here, because this server may sit behind plain HTTP inside a private network.
 */
import { NextResponse, type NextRequest } from "next/server";

/** Privacy-enhanced YouTube embed origin (the only allowed frame source). */
export const YOUTUBE_EMBED_ORIGIN = "https://www.youtube-nocookie.com";

/** The origin of `url`, or null when it is missing or not http(s)/ws(s). */
export function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return ["http:", "https:", "ws:", "wss:"].includes(parsed.protocol) ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** `origin` plus its WebSocket form (http→ws, https→wss). */
function withSocketScheme(origin: string): string[] {
  if (origin.startsWith("https:")) return [origin, `wss:${origin.slice("https:".length)}`];
  if (origin.startsWith("http:")) return [origin, `ws:${origin.slice("http:".length)}`];
  return [origin];
}

/** Inputs of {@link contentSecurityPolicy}. */
export interface CspOptions {
  nonce: string;
  /** Public API base (`NEXT_PUBLIC_API_URL`). */
  apiUrl?: string | undefined;
  /** Public WebSocket base (`NEXT_PUBLIC_WS_URL`). */
  wsUrl?: string | undefined;
  /** Comma-separated extra public media origins (`CSP_MEDIA_ORIGINS`). */
  mediaOrigins?: string | undefined;
  /** Development mode (adds `unsafe-eval` for React tooling only). */
  development?: boolean;
}

/** Builds the page Content-Security-Policy. */
export function contentSecurityPolicy(options: CspOptions): string {
  const api = originOf(options.apiUrl);
  const ws = originOf(options.wsUrl);
  const media = (options.mediaOrigins ?? "")
    .split(",")
    .map((value) => originOf(value.trim()))
    .filter((value): value is string => value !== null && !value.startsWith("ws"));
  const unique = (values: (string | null)[]) => [
    ...new Set(values.filter((value): value is string => value !== null)),
  ];
  const mediaSources = unique(["'self'", "blob:", "data:", api, ...media]);
  const connect = unique([
    "'self'",
    ...(api ? withSocketScheme(api) : []),
    ...(ws ? withSocketScheme(ws) : []),
  ]);
  const scripts = [
    "'self'",
    `'nonce-${options.nonce}'`,
    "'strict-dynamic'",
    ...(options.development ? ["'unsafe-eval'"] : []),
  ];
  return [
    "default-src 'self'",
    `script-src ${scripts.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src ${mediaSources.join(" ")}`,
    `media-src ${mediaSources.join(" ")}`,
    "font-src 'self' data:",
    `connect-src ${connect.join(" ")}`,
    `frame-src ${YOUTUBE_EMBED_ORIGIN}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join("; ");
}

/** Static security headers sent with every page. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(self), microphone=(), geolocation=(), payment=(), usb=()",
};

/** Adds the nonce-based CSP to the request (for Next) and all headers to the response. */
export function proxy(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const policy = contentSecurityPolicy({
    nonce,
    apiUrl: process.env.NEXT_PUBLIC_API_URL,
    wsUrl: process.env.NEXT_PUBLIC_WS_URL,
    mediaOrigins: process.env.CSP_MEDIA_ORIGINS,
    development: process.env.NODE_ENV === "development",
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.headers.set(name, value);
  return response;
}

/**
 * Pages only: static build assets, images, audio, legal files and prefetches skip the proxy (they
 * get the static headers from `next.config.ts`).
 */
export const config = {
  matcher: [
    {
      source:
        "/((?!_next/static|_next/image|favicon.ico|brand/|audio/|fonts/|legal/|locales/|robots.txt).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
