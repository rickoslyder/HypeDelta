import { NextRequest, NextResponse } from "next/server";
import { isAuthenticatedRequest } from "@/lib/auth";

export const dynamic = "force-dynamic";

async function notImplemented(request: NextRequest) {
  if (!(await isAuthenticatedRequest(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ error: "Not Implemented" }, { status: 501 });
}

export const GET = notImplemented;
export const POST = notImplemented;
