/**
 * Source/contract tests for the public /predictions product surface.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const webSrc = path.resolve(__dirname, "..");

function read(rel: string): string {
  return readFileSync(path.join(webSrc, rel), "utf8");
}

describe("predictions product surface", () => {
  it("adds a force-dynamic /predictions route backed by the persisted read model", () => {
    const page = read("app/predictions/page.tsx");
    expect(page).toMatch(/export const dynamic = ["']force-dynamic["']/);
    expect(page).toMatch(/getPersistedPredictions/);
    expect(page).toMatch(/Target date not normalized/);
    expect(page).toMatch(/searchParams/);
    expect(page).not.toMatch(/\bfetch\s*\(/);
    expect(page).not.toMatch(/getPredictions\s*\(/);
  });

  it("exposes accessible GET status and topic filters plus pagination", () => {
    const page = read("app/predictions/page.tsx");
    const hrefs = read("lib/persisted-predictions.ts");
    expect(page).toMatch(/predictionsHref/);
    expect(hrefs).toMatch(/status=\$\{/);
    expect(hrefs).toMatch(/topic=\$\{/);
    expect(page).toMatch(/Pagination/);
    expect(page).toMatch(/aria-label/);
    expect(page).toMatch(/aria-current/);
  });

  it("adds Predictions to desktop and mobile primary nav", () => {
    const layout = read("app/layout.tsx");
    expect(layout).toMatch(/href:\s*["']\/predictions["']/);
    expect(layout).toMatch(/label:\s*["']Predictions["']/);
    expect(layout).toMatch(/aria-label=["']Primary["']/);
    expect(layout).toMatch(/aria-label=["']Primary mobile["']/);
    expect(layout).toMatch(/primaryLinks\.map/);
  });

  it("adds Predictions to the command palette and renames Agent Reliability to Evidence Ledger", () => {
    const palette = read("components/command-palette.tsx");
    expect(palette).toMatch(/router\.push\(["']\/predictions["']\)/);
    expect(palette).toMatch(/Predictions/);
    expect(palette).toMatch(/Evidence Ledger/);
    expect(palette).not.toMatch(/Agent Reliability/);
    expect(palette).toMatch(/router\.push\(["']\/reliability["']\)/);
  });

  it("does not add extra public cards or routes beyond Predictions nav", () => {
    const home = read("app/page.tsx");
    expect(home).not.toMatch(/href=["']\/predictions["']/);
    const layout = read("app/layout.tsx");
    expect(layout).not.toMatch(/href:\s*["']\/accuracy["']/);
  });
});
