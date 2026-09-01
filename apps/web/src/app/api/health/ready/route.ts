import { NextResponse } from "next/server";
import { checkDatabaseReady } from "@/lib/db";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** Bounded DB readiness — generic 503 on failure; never leaks config/errors. */
export async function GET() {
  try {
    const ready = await checkDatabaseReady();
    if (!ready) {
      return NextResponse.json(
        { status: "not_ready" },
        { status: 503, headers: NO_STORE },
      );
    }
    return NextResponse.json(
      { status: "ready" },
      { status: 200, headers: NO_STORE },
    );
  } catch {
    return NextResponse.json(
      { status: "not_ready" },
      { status: 503, headers: NO_STORE },
    );
  }
}
