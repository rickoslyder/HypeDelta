import { getProductFreshnessSnapshot } from "@/lib/db";
import { assessProductFreshness } from "@/lib/product-freshness";

const BANNER_CLASS =
  "border-b border-amber-500/50 bg-amber-50 px-4 py-3 text-amber-950 dark:bg-amber-950/50 dark:text-amber-50 md:px-8 lg:px-12";

type FreshnessView =
  | { kind: "fresh" }
  | { kind: "stale"; synthesisLabel: string; pendingCount: number }
  | { kind: "error" };

/**
 * Accessible product-freshness warning. Renders nothing when the pipeline is fresh.
 * Fail-visible on read errors: generic warning, no leaked SQL/config.
 */
export async function FreshnessBanner() {
  let view: FreshnessView;
  try {
    const snapshot = await getProductFreshnessSnapshot();
    const assessment = assessProductFreshness(snapshot, new Date());
    if (assessment.ok) {
      view = { kind: "fresh" };
    } else {
      const synthesisLabel = assessment.lastSynthesisDate
        ? `Last synthesis: ${assessment.lastSynthesisDate}`
        : "Last synthesis: unavailable";
      view = {
        kind: "stale",
        synthesisLabel,
        pendingCount: assessment.pendingCount,
      };
    }
  } catch {
    view = { kind: "error" };
  }

  if (view.kind === "fresh") return null;

  if (view.kind === "error") {
    return (
      <div role="alert" aria-live="assertive" className={BANNER_CLASS}>
        <p className="font-semibold">Pipeline freshness is unavailable</p>
      </div>
    );
  }

  return (
    <div role="alert" aria-live="assertive" className={BANNER_CLASS}>
      <p className="font-semibold">Pipeline data may be stale or degraded.</p>
      <p className="mt-1 text-sm">
        {view.synthesisLabel}. {view.pendingCount.toLocaleString()} pending.
      </p>
    </div>
  );
}
