import { NextResponse } from "next/server";

/** DB-independent liveness probe — stable non-secret service/status only. */
export async function GET() {
  return NextResponse.json(
    {
      status: "ok",
      service: "hypedelta-web",
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
