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
};

export default nextConfig;
