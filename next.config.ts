import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produces .next/standalone with only the files the server actually needs,
  // which is what the Dockerfile ships. Harmless during `next dev`.
  output: "standalone",

  // yt-dlp-exec ships a binary; it must not be bundled by the compiler.
  serverExternalPackages: ["yt-dlp-exec"],
};

export default nextConfig;
