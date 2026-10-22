import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // A package-lock.json higher up (e.g. in $HOME) makes Next guess the wrong workspace root.
  // The root is the repo, because the app imports packages/rigs from outside its own folder.
  outputFileTracingRoot: path.join(__dirname, "../.."),
  experimental: { externalDir: true },
};

export default nextConfig;
