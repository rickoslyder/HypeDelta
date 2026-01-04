import { NextRequest, NextResponse } from "next/server";
import { getPredictions } from "@/lib/db";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    const options = {
      status: searchParams.get("status") || undefined,
      author: searchParams.get("author") || undefined,
      limit: parseInt(searchParams.get("limit") || "50"),
    };

    const predictions = await getPredictions(options);

    return NextResponse.json({ predictions });
  } catch (error) {
    console.error("Failed to get predictions:", error);
    return NextResponse.json(
      { error: "Failed to get predictions" },
      { status: 500 }
    );
  }
}
