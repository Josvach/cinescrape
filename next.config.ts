import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Cron routes stream large upstream payloads (the Cinema City feed is ~5 MB)
    // and need the full Node runtime rather than the edge runtime.
    serverActions: { bodySizeLimit: "2mb" },
  },
};

export default nextConfig;
