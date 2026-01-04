import { NextRequest, NextResponse } from "next/server";
import { getResearchers } from "@/lib/db";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const days = parseInt(searchParams.get("days") || "30");

    const researchers = await getResearchers(days);

    return NextResponse.json({ researchers });
  } catch (error) {
    console.error("Failed to get researchers:", error);
    return NextResponse.json(
      { error: "Failed to get researchers" },
      { status: 500 }
    );
  }
}
