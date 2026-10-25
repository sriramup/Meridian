import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: false,
  // a second dev server alongside the first (e.g. one on the mock API, one on the real one) needs its own build dir
  distDir: process.env.NEXT_DIST_DIR || ".next",
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
