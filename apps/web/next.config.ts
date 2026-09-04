import type { NextConfig } from "next";
import path from "path";

const isDevelopment = process.env.NODE_ENV !== "production";
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDevelopment ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${isDevelopment ? " ws: http: https:" : ""}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains",
  },
];

const repoRoot = path.resolve(__dirname, "../..");
const sharedSrcFile = (name: string) => path.resolve(repoRoot, "src", name);
// Next 16 Turbopack treats absolute `/...` alias targets as unimplemented
// server-relative URL imports. Keep a relative specifier from apps/web so
// worker and web share the canonical src modules without vendoring copies.
const turbopackSharedSrc = (name: string) =>
  path.relative(__dirname, sharedSrcFile(name)).split(path.sep).join("/");

const sharedAliases = {
  "@hypedelta/types": "types.ts",
  "@hypedelta/storage": "storage.ts",
  "@hypedelta/author-side": "author-side.ts",
  "@hypedelta/researcher-identity": "researcher-identity.ts",
} as const;

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,

  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },

  // Allow pg and other Node.js modules in server components
  serverExternalPackages: ["pg"],

  // Turbopack configuration (Next.js 16+)
  turbopack: {
    root: repoRoot,
    resolveAlias: Object.fromEntries(
      Object.entries(sharedAliases).map(([alias, file]) => [alias, turbopackSharedSrc(file)]),
    ),
  },

  // Webpack fallback: absolute filesystem aliases are valid here.
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      ...Object.fromEntries(
        Object.entries(sharedAliases).map(([alias, file]) => [alias, sharedSrcFile(file)]),
      ),
    };
    return config;
  },
};

export default nextConfig;
