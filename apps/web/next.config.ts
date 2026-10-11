import { randomUUID } from "node:crypto";
import type { NextConfig } from "next";

// One identifier per build. The offline service worker embeds it, so every deploy changes the
// worker's bytes and phones re-download the saved app instead of keeping the first copy forever.
// Release builds pass the image tag (git SHA); any other build gets a fresh random value.
const buildId = process.env.OPENBALANCE_BUILD_ID?.trim() || randomUUID();

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  generateBuildId: () => buildId,
  env: { OPENBALANCE_BUILD_ID: buildId },
};

export default nextConfig;
