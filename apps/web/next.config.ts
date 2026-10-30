import type { NextConfig } from "next";

// Next 16.4 references these Web Platform names, while the pinned TS 5.9
// and Node 24 declarations expose only URLPatternInit globally.
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
