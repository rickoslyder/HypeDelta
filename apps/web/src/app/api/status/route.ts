import { NextResponse } from "next/server";
import { getSystemStatus } from "@/lib/db";

export async function GET() {
  try {
    const status = await getSystemStatus();
    return NextResponse.json(status);
  } catch (error) {
    console.error("Failed to get system status:", error);
    return NextResponse.json(
      { error: "Failed to get system status" },
      { status: 500 }
    );
  }
}
