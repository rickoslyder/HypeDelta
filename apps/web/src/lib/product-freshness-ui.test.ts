/**
 * Source assertions: freshness banner on public product routes; no weekly-update footer.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const webSrc = path.resolve(__dirname, "..");

function read(rel: string): string {
  return readFileSync(path.join(webSrc, rel), "utf8");
}

const PRODUCT_ROUTES = [
  "app/page.tsx",
  "app/digest/page.tsx",
  "app/claims/page.tsx",
] as const;

describe("product freshness UI contract", () => {
  it("home, digest, and claims render the freshness banner", () => {
    for (const rel of PRODUCT_ROUTES) {
      const src = read(rel);
      expect(src, rel).toMatch(/FreshnessBanner/);
      expect(src, rel).toMatch(/from ["']@\/components\/freshness-banner["']/);
    }
  });

  it("banner is an accessible alert that states last synthesis date and pending count", () => {
    const src = read("components/freshness-banner.tsx");
    expect(src).toMatch(/role=["']alert["']/);
    expect(src).toMatch(/lastSynthesisDate/);
    expect(src).toMatch(/pendingCount/);
    expect(src).toMatch(/Last synthesis/i);
    expect(src).toMatch(/pending/i);
  });

  it("footer no longer promises weekly updates", () => {
    const layout = read("app/layout.tsx");
    expect(layout).not.toMatch(/Updated weekly/);
  });

  // Characterization lock: /live stays process-only and /ready stays SELECT 1.
  // These assertions are already true on HEAD — not the 12D-A RED contract.
  it("keeps process liveness and DB readiness probes separate from pipeline freshness", () => {
    const live = read("app/api/health/live/route.ts");
    const ready = read("app/api/health/ready/route.ts");
    expect(live).not.toMatch(/getProductFreshnessSnapshot|assessProductFreshness/);
    expect(ready).not.toMatch(/getProductFreshnessSnapshot|assessProductFreshness/);
    expect(ready).toMatch(/checkDatabaseReady/);
    expect(live).not.toMatch(/pipeline_runs|source_fetch_attempts/);
    expect(ready).not.toMatch(/pipeline_runs|source_fetch_attempts/);
    const readyDb = read("lib/db.ts");
    expect(readyDb).toMatch(/Bounded DB readiness check for \/api\/health\/ready/);
    expect(readyDb).toMatch(/pool\.query\(\"SELECT 1\"\)/);
  });
});
