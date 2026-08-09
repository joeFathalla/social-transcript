import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produces .next/standalone with only the files the server actually needs,
  // which is what the Dockerfile ships. Harmless during `next dev`.
  output: "standalone",
};

export default nextConfig;
