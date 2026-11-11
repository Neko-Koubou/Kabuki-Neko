import type { NextConfig } from "next";

// Next 16.4 references these Web Platform names, while the pinned TS 5.9
// and Node 26 (@types/node 26.6.6) declarations expose only URLPattern,
// URLPatternInit and URLPatternResult globally; the input/options aliases
// stay scoped to the "node:url" module, so they are re-declared here.
declare global {
  type URLPatternInput = string | URLPatternInit;
  type URLPatternOptions = import("node:url").URLPatternOptions;
}

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ["@kabuki-neko/shared"],
  /**
   * `/dashboard` → `/dashboard/quizzes` (SA §1.2) as a 307 before any rendering, so the protected
   * layout never streams for the bare dashboard URL; the page-level redirect remains as a fallback.
   */
  /**
   * Static browser security headers on every response, including static files the proxy skips
   * (SA §10.1; TASK-164). The nonce-based Content-Security-Policy is added per page by
   * `src/proxy.ts`; HSTS belongs to the HTTPS reverse proxy (docs/security-headers.md).
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(self), microphone=(), geolocation=(), payment=(), usb=()",
          },
        ],
      },
    ];
  },
  async redirects() {
    return [{ source: "/dashboard", destination: "/dashboard/quizzes", permanent: false }];
  },
};

export default nextConfig;
