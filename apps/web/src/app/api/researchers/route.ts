import { NextRequest, NextResponse } from "next/server";
import { getResearchers, RESEARCHER_PUBLIC_WINDOW_DAYS } from "@/lib/db";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const raw = searchParams.get("days");
    const days = raw
      ? parseInt(raw, 10)
      : RESEARCHER_PUBLIC_WINDOW_DAYS;

    const researchers = await getResearchers(
      Number.isFinite(days) ? days : RESEARCHER_PUBLIC_WINDOW_DAYS
    );

    return NextResponse.json({ researchers });
  } catch (error) {
    console.error("Failed to get researchers:", error);
    return NextResponse.json(
      { error: "Failed to get researchers" },
      { status: 500 }
    );
  }
}
