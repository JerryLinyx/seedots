import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // A package-lock.json higher up (e.g. in $HOME) makes Next guess the wrong workspace root.
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;
