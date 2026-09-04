import { NextResponse } from "next/server";
import { getProductFreshnessSnapshot } from "@/lib/db";
import { assessProductFreshness } from "@/lib/product-freshness";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** Product/pipeline freshness — 200 fresh, 503 stale/degraded; never leaks SQL/config. */
export async function GET() {
  try {
    const snapshot = await getProductFreshnessSnapshot();
    const assessment = assessProductFreshness(snapshot, new Date());
    return NextResponse.json(
      {
        status: assessment.status,
        ok: assessment.ok,
        reasons: assessment.reasons,
        lastSynthesisDate: assessment.lastSynthesisDate,
        pendingCount: assessment.pendingCount,
        overdueSourceCount: assessment.overdueSourceCount,
        lastPipelineSuccessAt: assessment.lastPipelineSuccessAt,
        lastFetchSuccessAt: assessment.lastFetchSuccessAt,
        errorClass: assessment.errorClass,
      },
      { status: assessment.ok ? 200 : 503, headers: NO_STORE },
    );
  } catch {
    return NextResponse.json(
      { status: "unavailable", ok: false },
      { status: 503, headers: NO_STORE },
    );
  }
}
