/**
 * FreshnessBanner fail-visible contract: DB read errors must warn, never leak internals.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetProductFreshnessSnapshot = vi.fn();

vi.mock("@/lib/db", () => ({
  getProductFreshnessSnapshot: (...args: unknown[]) =>
    mockGetProductFreshnessSnapshot(...args),
}));

function collectText(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join("");
  if (typeof node === "object" && node !== null && "props" in node) {
    return collectText((node as { props?: { children?: unknown } }).props?.children);
  }
  return "";
}

function recentIso(msAgo = 0): string {
  return new Date(Date.now() - msAgo).toISOString();
}

function snapshot(overrides: Record<string, unknown> = {}) {
  const recent = recentIso();
  return {
    synthesisLatest: recent,
    unprocessedCount: 1,
    activeSources: [
      {
        identifier: "sama",
        type: "twitter",
        last_fetched: recent,
        fetch_frequency_hours: 24,
        is_active: true,
      },
    ],
    pipelineLatestSuccessAt: recent,
    pipelineLatestFinishedAt: recent,
    pipelineLatestOk: true,
    pipelineLatestErrorClass: null,
    fetchLatestSuccessAt: recent,
    ...overrides,
  };
}

function collectAttrs(node: unknown): { role?: string; ariaLive?: string } {
  if (node == null || typeof node !== "object") return {};
  if (Array.isArray(node)) {
    return node.reduce((acc, child) => ({ ...acc, ...collectAttrs(child) }), {});
  }
  const el = node as { props?: Record<string, unknown> };
  const props = el.props ?? {};
  const self = {
    ...(typeof props.role === "string" ? { role: props.role } : {}),
    ...(typeof props["aria-live"] === "string" ? { ariaLive: props["aria-live"] as string } : {}),
  };
  return { ...self, ...collectAttrs(props.children) };
}

describe("FreshnessBanner", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders an accessible warning when the freshness DB read throws, without leaking internals", async () => {
    mockGetProductFreshnessSnapshot.mockRejectedValue(
      new Error(
        'relation "synthesis_results" connect ECONNREFUSED postgresql://user:s3cret@db.internal:5432/ai_intel DATABASE_URL token=abc SELECT MAX(generated_at)',
      ),
    );

    const { FreshnessBanner } = await import("./freshness-banner");
    const tree = await FreshnessBanner();

    expect(tree).not.toBeNull();
    const attrs = collectAttrs(tree);
    expect(attrs.role).toBe("alert");
    expect(attrs.ariaLive).toBe("assertive");

    const text = collectText(tree);
    expect(text).toContain("Pipeline freshness is unavailable");
    expect(text).not.toMatch(/postgresql:\/\//i);
    expect(text).not.toMatch(/s3cret/i);
    expect(text).not.toMatch(/DATABASE_URL/i);
    expect(text).not.toMatch(/ECONNREFUSED/i);
    expect(text).not.toMatch(/token=abc/i);
    expect(text).not.toMatch(/db\.internal/i);
    expect(text).not.toMatch(/synthesis_results/i);
    expect(text).not.toMatch(/generated_at/i);
    expect(text).not.toMatch(/Error:/i);
  });

  it("renders the stale banner when assessment is not ok, and nothing when fresh", async () => {
    mockGetProductFreshnessSnapshot.mockResolvedValue(
      snapshot({
        synthesisLatest: null,
        unprocessedCount: 3,
        activeSources: [],
      }),
    );

    const { FreshnessBanner } = await import("./freshness-banner");
    const stale = await FreshnessBanner();
    expect(stale).not.toBeNull();
    const staleText = collectText(stale);
    expect(staleText).toContain("Pipeline data may be stale or degraded.");
    expect(staleText).toContain("Last synthesis: unavailable");
    expect(staleText).toContain("3 pending.");
    expect(collectAttrs(stale).role).toBe("alert");

    vi.resetModules();
    mockGetProductFreshnessSnapshot.mockResolvedValue(snapshot());
    const freshMod = await import("./freshness-banner");
    await expect(freshMod.FreshnessBanner()).resolves.toBeNull();
  });

  it("renders the stale banner when synthesis/sources are fresh but the pipeline ledger is past SLO", async () => {
    const sevenHoursMs = 7 * 60 * 60 * 1000;
    mockGetProductFreshnessSnapshot.mockResolvedValue(
      snapshot({
        pipelineLatestSuccessAt: recentIso(sevenHoursMs),
        pipelineLatestFinishedAt: recentIso(sevenHoursMs),
        pipelineLatestOk: true,
        pipelineLatestErrorClass: null,
      }),
    );

    const { FreshnessBanner } = await import("./freshness-banner");
    const tree = await FreshnessBanner();
    expect(tree).not.toBeNull();
    const text = collectText(tree);
    expect(text).toContain("Pipeline data may be stale or degraded.");
    expect(text).toMatch(/Last synthesis: \d{4}-\d{2}-\d{2}/);
    expect(text).toContain("1 pending.");
    expect(collectAttrs(tree).role).toBe("alert");
    expect(text).not.toMatch(/postgresql:\/\//i);
    expect(text).not.toMatch(/error_message/i);
    expect(text).not.toMatch(/PIPELINE_NO_RECENT_SUCCESS/);
  });

  it("keeps throwable freshness computation inside try/catch and returns JSX outside", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(fileURLToPath(new URL("./freshness-banner.tsx", import.meta.url)), "utf8");
    const tryStart = src.indexOf("try {");
    const afterCatch = src.indexOf("if (view.kind === \"fresh\")");
    expect(tryStart).toBeGreaterThan(-1);
    expect(afterCatch).toBeGreaterThan(tryStart);
    const tryCatchRegion = src.slice(tryStart, afterCatch);
    expect(tryCatchRegion).toMatch(/getProductFreshnessSnapshot/);
    expect(tryCatchRegion).toMatch(/assessProductFreshness/);
    expect(tryCatchRegion).toMatch(/catch/);
    expect(tryCatchRegion).not.toMatch(/<[A-Za-z]/);
    expect(src.slice(afterCatch)).toMatch(/return \(/);
  });
});
