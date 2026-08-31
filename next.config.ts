import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  distDir: 'build',
  typescript: {
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
