import { NextResponse } from "next/server";
import { getLatestSynthesis } from "@/lib/db";

export async function GET() {
  try {
    const synthesis = await getLatestSynthesis();

    if (!synthesis) {
      return NextResponse.json(
        { error: "No synthesis found" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      generatedAt: synthesis.generated_at,
      lookbackDays: synthesis.lookback_days,
      syntheses: synthesis.syntheses,
      hypeAssessment: synthesis.hype_assessment,
      digest: synthesis.digest_markdown,
      periodStart: synthesis.period_start,
      periodEnd: synthesis.period_end,
    });
  } catch (error) {
    console.error("Failed to get digest:", error);
    return NextResponse.json(
      { error: "Failed to get digest" },
      { status: 500 }
    );
  }
}
