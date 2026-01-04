import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  output: "standalone",

  // Allow pg and other Node.js modules in server components
  serverExternalPackages: ["pg"],

  // Turbopack configuration (Next.js 16+)
  turbopack: {
    resolveAlias: {
      "@hypedelta/types": path.resolve(__dirname, "../../src/types.ts"),
      "@hypedelta/storage": path.resolve(__dirname, "../../src/storage.ts"),
    },
  },

  // Webpack config for resolving backend types (fallback for production builds)
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      "@hypedelta/types": path.resolve(__dirname, "../../src/types.ts"),
      "@hypedelta/storage": path.resolve(__dirname, "../../src/storage.ts"),
    };
    return config;
  },
};

export default nextConfig;
