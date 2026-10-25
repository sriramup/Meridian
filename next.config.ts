import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: false,
  // the dev badge sits over the projects sidebar's footer; build and runtime errors still show
  devIndicators: false,
  async headers() {
    return [
      {
        source: "/data/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=3600, stale-while-revalidate=86400" }],
      },
    ];
  },
};

export default nextConfig;
