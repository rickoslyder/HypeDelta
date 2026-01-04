import { NextRequest, NextResponse } from "next/server";
import { getTopicStats } from "@/lib/db";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const days = parseInt(searchParams.get("days") || "30");

    const topics = await getTopicStats(days);

    return NextResponse.json({ topics });
  } catch (error) {
    console.error("Failed to get topics:", error);
    return NextResponse.json(
      { error: "Failed to get topics" },
      { status: 500 }
    );
  }
}
