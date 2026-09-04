/**
 * Pure product-freshness policy: synthesis age, source cadence, backlog.
 * No DB, no network.
 */
import { describe, expect, it } from "vitest";
import { assessProductFreshness } from "./product-freshness";
import type { ProductFreshnessSource, ProductFreshnessStatus } from "./product-freshness";

const NOW = new Date("2026-08-28T12:00:00.000Z");
const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function hoursAgo(hours: number, now: Date = NOW): string {
  return new Date(now.getTime() - hours * HOUR_MS).toISOString();
}

function daysAgo(days: number, now: Date = NOW): string {
  return new Date(now.getTime() - days * 24 * HOUR_MS).toISOString();
}

/** Overdue only after max(cadence*2, cadence+6h). */
function graceHours(cadenceHours: number): number {
  return Math.max(cadenceHours * 2, cadenceHours + 6);
}

function source(
  identifier: string,
  overrides: Partial<ProductFreshnessSource> = {},
): ProductFreshnessSource {
  return {
    identifier,
    type: "twitter",
    last_fetched: hoursAgo(1),
    fetch_frequency_hours: 4,
    ...overrides,
  };
}

function healthyLedger() {
  return {
    pipelineLatestSuccessAt: hoursAgo(1),
    pipelineLatestFinishedAt: hoursAgo(1),
    pipelineLatestOk: true as boolean | null,
    pipelineLatestErrorClass: null as string | null,
    fetchLatestSuccessAt: hoursAgo(1),
  };
}

function snapshot(
  overrides: Partial<ProductFreshnessStatus> = {},
): ProductFreshnessStatus {
  return {
    synthesisLatest: daysAgo(3),
    unprocessedCount: 10,
    activeSources: [source("sama")],
    ...healthyLedger(),
    ...overrides,
  };
}

function fleet(active: number, overdue: number, cadenceHours = 4): ProductFreshnessSource[] {
  const grace = graceHours(cadenceHours);
  return Array.from({ length: active }, (_, i) =>
    source(`s${i}`, {
      last_fetched:
        i < overdue
          ? new Date(NOW.getTime() - grace * HOUR_MS - 1).toISOString()
          : hoursAgo(1),
      fetch_frequency_hours: cadenceHours,
    }),
  );
}

describe("assessProductFreshness", () => {
  it("is fresh when synthesis and sources are within thresholds", () => {
    const result = assessProductFreshness(snapshot(), NOW);

    expect(result.status).toBe("fresh");
    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.lastSynthesisDate).toBe("2026-08-25");
    expect(result.pendingCount).toBe(10);
    expect(result.overdueSourceCount).toBe(0);
  });

  it("does not mark synthesis stale at exactly 8 days", () => {
    const result = assessProductFreshness(
      snapshot({ synthesisLatest: new Date(NOW.getTime() - EIGHT_DAYS_MS).toISOString() }),
      NOW,
    );

    expect(result.reasons).not.toContain("SYNTHESIS_STALE");
    expect(result.reasons).not.toContain("SYNTHESIS_MISSING");
    expect(result.status).toBe("fresh");
    expect(result.ok).toBe(true);
  });

  it("marks synthesis stale one millisecond past 8 days", () => {
    const result = assessProductFreshness(
      snapshot({
        synthesisLatest: new Date(NOW.getTime() - EIGHT_DAYS_MS - 1).toISOString(),
      }),
      NOW,
    );

    expect(result.reasons).toContain("SYNTHESIS_STALE");
    expect(result.status).toBe("stale");
    expect(result.ok).toBe(false);
    expect(result.lastSynthesisDate).toBe("2026-08-20");
  });

  it("marks missing synthesis as stale with SYNTHESIS_MISSING", () => {
    const result = assessProductFreshness(
      snapshot({ synthesisLatest: null }),
      NOW,
    );

    expect(result.reasons).toContain("SYNTHESIS_MISSING");
    expect(result.reasons).not.toContain("SYNTHESIS_STALE");
    expect(result.status).toBe("stale");
    expect(result.ok).toBe(false);
    expect(result.lastSynthesisDate).toBeNull();
  });

  it("does not mark a source overdue at exactly its fetch cadence", () => {
    const result = assessProductFreshness(
      snapshot({
        activeSources: [source("sama", { last_fetched: hoursAgo(4), fetch_frequency_hours: 4 })],
      }),
      NOW,
    );

    expect(result.reasons).not.toContain("SOURCES_OVERDUE");
    expect(result.overdueSourceCount).toBe(0);
    expect(result.status).toBe("fresh");
    expect(result.ok).toBe(true);
  });

  it("does not mark a source overdue one millisecond past its configured cadence", () => {
    const result = assessProductFreshness(
      snapshot({
        activeSources: [
          source("sama", {
            last_fetched: new Date(NOW.getTime() - 4 * HOUR_MS - 1).toISOString(),
            fetch_frequency_hours: 4,
          }),
        ],
      }),
      NOW,
    );

    expect(result.overdueSourceCount).toBe(0);
    expect(result.reasons).not.toContain("SOURCES_OVERDUE");
    expect(result.status).toBe("fresh");
    expect(result.ok).toBe(true);
  });

  it("does not mark a source overdue just before its grace horizon", () => {
    const cadence = 4;
    const graceMs = graceHours(cadence) * HOUR_MS;
    const result = assessProductFreshness(
      snapshot({
        activeSources: [
          source("sama", {
            last_fetched: new Date(NOW.getTime() - graceMs + 1).toISOString(),
            fetch_frequency_hours: cadence,
          }),
        ],
      }),
      NOW,
    );

    expect(result.overdueSourceCount).toBe(0);
    expect(result.reasons).not.toContain("SOURCES_OVERDUE");
    expect(result.status).toBe("fresh");
  });

  it("does not mark a source overdue at exactly its grace horizon", () => {
    const cadence = 4;
    const graceMs = graceHours(cadence) * HOUR_MS;
    const result = assessProductFreshness(
      snapshot({
        activeSources: [
          source("sama", {
            last_fetched: new Date(NOW.getTime() - graceMs).toISOString(),
            fetch_frequency_hours: cadence,
          }),
        ],
      }),
      NOW,
    );

    expect(result.overdueSourceCount).toBe(0);
    expect(result.reasons).not.toContain("SOURCES_OVERDUE");
    expect(result.status).toBe("fresh");
  });

  it("marks a source overdue one millisecond past its grace horizon", () => {
    const cadence = 4;
    const graceMs = graceHours(cadence) * HOUR_MS;
    const result = assessProductFreshness(
      snapshot({
        activeSources: [
          source("sama", {
            last_fetched: new Date(NOW.getTime() - graceMs - 1).toISOString(),
            fetch_frequency_hours: cadence,
          }),
        ],
      }),
      NOW,
    );

    expect(result.overdueSourceCount).toBe(1);
    expect(result.reasons).not.toContain("SOURCES_OVERDUE");
    expect(result.status).toBe("fresh");
    expect(result.ok).toBe(true);
  });

  it("treats never-fetched active sources as overdue without site-wide degradation", () => {
    const result = assessProductFreshness(
      snapshot({
        activeSources: [
          source("gwern", {
            type: "blog",
            last_fetched: null,
            fetch_frequency_hours: 12,
          }),
        ],
      }),
      NOW,
    );

    expect(result.overdueSourceCount).toBe(1);
    expect(result.reasons).not.toContain("SOURCES_OVERDUE");
    expect(result.status).toBe("fresh");
    expect(result.ok).toBe(true);
  });

  it("evaluates each active source against its own grace horizon", () => {
    const result = assessProductFreshness(
      snapshot({
        activeSources: [
          source("fast", {
            last_fetched: new Date(NOW.getTime() - graceHours(4) * HOUR_MS - 1).toISOString(),
            fetch_frequency_hours: 4,
          }),
          source("slow", {
            type: "blog",
            last_fetched: hoursAgo(11),
            fetch_frequency_hours: 24,
          }),
        ],
      }),
      NOW,
    );

    expect(result.overdueSourceCount).toBe(1);
    expect(result.reasons).not.toContain("SOURCES_OVERDUE");
    expect(result.status).toBe("fresh");
  });

  it("uses a 24h default cadence (48h grace) when fetch_frequency_hours is null", () => {
    const onTime = assessProductFreshness(
      snapshot({
        activeSources: [
          source("defaulted", {
            type: "arxiv",
            last_fetched: hoursAgo(24),
            fetch_frequency_hours: null,
          }),
        ],
      }),
      NOW,
    );
    expect(onTime.overdueSourceCount).toBe(0);
    expect(onTime.reasons).not.toContain("SOURCES_OVERDUE");

    const atGrace = assessProductFreshness(
      snapshot({
        activeSources: [
          source("defaulted", {
            type: "arxiv",
            last_fetched: hoursAgo(48),
            fetch_frequency_hours: null,
          }),
        ],
      }),
      NOW,
    );
    expect(atGrace.overdueSourceCount).toBe(0);

    const overdue = assessProductFreshness(
      snapshot({
        activeSources: [
          source("defaulted", {
            type: "arxiv",
            last_fetched: new Date(NOW.getTime() - 48 * HOUR_MS - 1).toISOString(),
            fetch_frequency_hours: null,
          }),
        ],
      }),
      NOW,
    );
    expect(overdue.overdueSourceCount).toBe(1);
    expect(overdue.reasons).not.toContain("SOURCES_OVERDUE");
    expect(overdue.status).toBe("fresh");
  });

  it("keeps product health fresh when 2 of 20 sources are overdue and still reports the count", () => {
    const result = assessProductFreshness(
      snapshot({ activeSources: fleet(20, 2) }),
      NOW,
    );

    expect(result.overdueSourceCount).toBe(2);
    expect(result.reasons).not.toContain("SOURCES_OVERDUE");
    expect(result.status).toBe("fresh");
    expect(result.ok).toBe(true);
  });

  it("degrades when 3 of 20 sources are overdue", () => {
    const result = assessProductFreshness(
      snapshot({ activeSources: fleet(20, 3) }),
      NOW,
    );

    expect(result.overdueSourceCount).toBe(3);
    expect(result.reasons).toContain("SOURCES_OVERDUE");
    expect(result.status).toBe("degraded");
    expect(result.ok).toBe(false);
  });

  it("keeps product health fresh when 14 of 150 sources are overdue and still reports the count", () => {
    const result = assessProductFreshness(
      snapshot({ activeSources: fleet(150, 14) }),
      NOW,
    );

    expect(result.overdueSourceCount).toBe(14);
    expect(result.reasons).not.toContain("SOURCES_OVERDUE");
    expect(result.status).toBe("fresh");
    expect(result.ok).toBe(true);
  });

  it("degrades when 15 of 150 sources are overdue", () => {
    const result = assessProductFreshness(
      snapshot({ activeSources: fleet(150, 15) }),
      NOW,
    );

    expect(result.overdueSourceCount).toBe(15);
    expect(result.reasons).toContain("SOURCES_OVERDUE");
    expect(result.status).toBe("degraded");
    expect(result.ok).toBe(false);
  });

  it("reports a large backlog without failing pipeline liveness by itself", () => {
    const result = assessProductFreshness(
      snapshot({ unprocessedCount: 100 }),
      NOW,
    );

    expect(result.reasons).toContain("BACKLOG_LARGE");
    expect(result.pendingCount).toBe(100);
    expect(result.status).toBe("fresh");
    expect(result.ok).toBe(true);
  });

  it("keeps backlog below 100 from appearing as BACKLOG_LARGE", () => {
    const result = assessProductFreshness(
      snapshot({ unprocessedCount: 99 }),
      NOW,
    );

    expect(result.reasons).not.toContain("BACKLOG_LARGE");
    expect(result.pendingCount).toBe(99);
    expect(result.ok).toBe(true);
  });

  it("emits stable reason order and display-safe dates when several issues apply", () => {
    const result = assessProductFreshness(
      snapshot({
        synthesisLatest: daysAgo(9),
        unprocessedCount: 250,
        activeSources: [
          source("dead-a", { last_fetched: daysAgo(20), fetch_frequency_hours: 4 }),
          source("dead-b", { last_fetched: daysAgo(20), fetch_frequency_hours: 4 }),
          source("dead-c", { last_fetched: daysAgo(20), fetch_frequency_hours: 4 }),
        ],
      }),
      NOW,
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe("degraded");
    expect(result.reasons).toEqual([
      "SYNTHESIS_STALE",
      "SOURCES_OVERDUE",
      "BACKLOG_LARGE",
    ]);
    expect(result.lastSynthesisDate).toBe("2026-08-19");
    expect(result.lastSynthesisDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.pendingCount).toBe(250);
    expect(result.overdueSourceCount).toBe(3);
  });

  it("does not flag pipeline SLO at exactly 6h", () => {
    const at = new Date(NOW.getTime() - 6 * HOUR_MS).toISOString();
    const result = assessProductFreshness(
      snapshot({
        pipelineLatestSuccessAt: at,
        pipelineLatestFinishedAt: at,
        pipelineLatestOk: true,
      }),
      NOW,
    );

    expect(result.reasons).not.toContain("PIPELINE_NO_RECENT_SUCCESS");
    expect(result.lastPipelineSuccessAt).toBe(at);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("fresh");
  });

  it("is stale when synthesis/sources are fresh but no pipeline_runs success within 6h", () => {
    const pipelineAt = new Date(NOW.getTime() - 6 * HOUR_MS - 1).toISOString();
    const result = assessProductFreshness(
      snapshot({
        pipelineLatestSuccessAt: pipelineAt,
        pipelineLatestFinishedAt: pipelineAt,
        pipelineLatestOk: true,
        pipelineLatestErrorClass: null,
        fetchLatestSuccessAt: hoursAgo(1),
      }),
      NOW,
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe("stale");
    expect(result.reasons).toContain("PIPELINE_NO_RECENT_SUCCESS");
    expect(result.lastPipelineSuccessAt).toBe(pipelineAt);
    expect(result.lastFetchSuccessAt).toBe(hoursAgo(1));
    expect(result.errorClass).toBeNull();
  });

  it("does not flag fetch SLO at exactly 6h", () => {
    const at = new Date(NOW.getTime() - 6 * HOUR_MS).toISOString();
    const result = assessProductFreshness(
      snapshot({ fetchLatestSuccessAt: at }),
      NOW,
    );

    expect(result.reasons).not.toContain("FETCH_NO_RECENT_SUCCESS");
    expect(result.lastFetchSuccessAt).toBe(at);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("fresh");
  });

  it("is stale when synthesis/sources/pipeline are fresh but no fetch success within 6h", () => {
    const fetchAt = new Date(NOW.getTime() - 6 * HOUR_MS - 1).toISOString();
    const result = assessProductFreshness(
      snapshot({ fetchLatestSuccessAt: fetchAt }),
      NOW,
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe("stale");
    expect(result.reasons).toContain("FETCH_NO_RECENT_SUCCESS");
    expect(result.reasons).not.toContain("PIPELINE_NO_RECENT_SUCCESS");
    expect(result.lastFetchSuccessAt).toBe(fetchAt);
    expect(result.lastPipelineSuccessAt).toBe(hoursAgo(1));
  });

  it("is stale when pipeline_runs and source_fetch_attempts have never succeeded", () => {
    const result = assessProductFreshness(
      snapshot({
        pipelineLatestSuccessAt: null,
        pipelineLatestFinishedAt: null,
        pipelineLatestOk: null,
        pipelineLatestErrorClass: null,
        fetchLatestSuccessAt: null,
      }),
      NOW,
    );

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("PIPELINE_NO_RECENT_SUCCESS");
    expect(result.reasons).toContain("FETCH_NO_RECENT_SUCCESS");
    expect(result.lastPipelineSuccessAt).toBeNull();
    expect(result.lastFetchSuccessAt).toBeNull();
  });

  it("is degraded when the latest pipeline_runs row failed, exposing only error_class", () => {
    const result = assessProductFreshness(
      snapshot({
        pipelineLatestSuccessAt: hoursAgo(1),
        pipelineLatestFinishedAt: hoursAgo(0.5),
        pipelineLatestOk: false,
        pipelineLatestErrorClass: "timeout",
        fetchLatestSuccessAt: hoursAgo(1),
      }),
      NOW,
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe("degraded");
    expect(result.reasons).toContain("PIPELINE_FAILED");
    expect(result.errorClass).toBe("timeout");
    expect(JSON.stringify(result)).not.toMatch(/error_message/i);
    expect(JSON.stringify(result)).not.toMatch(/postgresql:\/\//i);
  });

  it("drops unknown error_class values rather than echoing raw text", () => {
    const result = assessProductFreshness(
      snapshot({
        pipelineLatestOk: false,
        pipelineLatestErrorClass: "password authentication failed postgresql://secret",
      } as Partial<ProductFreshnessStatus>),
      NOW,
    );

    expect(result.reasons).toContain("PIPELINE_FAILED");
    expect(result.errorClass).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/postgresql:\/\//i);
    expect(JSON.stringify(result)).not.toMatch(/password authentication/i);
  });
});
