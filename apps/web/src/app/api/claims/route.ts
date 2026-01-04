import { NextRequest, NextResponse } from "next/server";
import { getClaims } from "@/lib/db";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    const options = {
      topic: searchParams.get("topic") || undefined,
      authorCategory: searchParams.get("authorCategory") || undefined,
      claimType: searchParams.get("claimType") || undefined,
      days: parseInt(searchParams.get("days") || "30"),
      limit: parseInt(searchParams.get("limit") || "50"),
      offset: parseInt(searchParams.get("offset") || "0"),
    };

    const result = await getClaims(options);

    return NextResponse.json(result);
  } catch (error) {
    console.error("Failed to get claims:", error);
    return NextResponse.json(
      { error: "Failed to get claims" },
      { status: 500 }
    );
  }
}
