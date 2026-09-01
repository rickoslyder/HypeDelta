import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import nextConfig from "./next.config";

const WEB_DIR = path.resolve(__dirname);
const CANONICAL_SHARED = {
  "@hypedelta/author-side": path.resolve(WEB_DIR, "../../src/author-side.ts"),
  "@hypedelta/researcher-identity": path.resolve(
    WEB_DIR,
    "../../src/researcher-identity.ts",
  ),
} as const;

describe("web security headers", () => {
  it("applies the hardening baseline to every route", async () => {
    expect(nextConfig.poweredByHeader).toBe(false);
    expect(nextConfig.headers).toBeTypeOf("function");

    const rules = await nextConfig.headers!();
    expect(rules).toHaveLength(1);
    expect(rules[0].source).toBe("/:path*");

    const headers = Object.fromEntries(
      rules[0].headers.map(({ key, value }) => [key.toLowerCase(), value]),
    );

    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(headers["content-security-policy"]).toContain("object-src 'none'");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["strict-transport-security"]).toContain("max-age=31536000");
  });
});

describe("Next 16 Turbopack shared-module build contract", () => {
  it("aliases canonical author-side/identity files with relative specifiers, not absolute server-relative paths", () => {
    const aliases = nextConfig.turbopack?.resolveAlias as
      | Record<string, string>
      | undefined;
    expect(aliases).toBeDefined();

    for (const [name, canonical] of Object.entries(CANONICAL_SHARED)) {
      expect(existsSync(canonical), canonical).toBe(true);
      const target = aliases![name];
      expect(target, name).toEqual(expect.any(String));
      expect(path.isAbsolute(target), `${name} must not be an absolute /server-relative alias`).toBe(
        false,
      );
      expect(target.startsWith("/"), name).toBe(false);
      expect(path.resolve(WEB_DIR, target)).toBe(canonical);
    }
  });
});
