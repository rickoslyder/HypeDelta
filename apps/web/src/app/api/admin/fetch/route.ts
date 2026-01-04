import { NextRequest, NextResponse } from "next/server";
import { runFetch, isOperationRunning } from "@/lib/cli-runner";

export async function POST(request: NextRequest) {
  try {
    // Check if fetch is already running
    if (isOperationRunning("fetch")) {
      return NextResponse.json(
        { error: "Fetch operation is already running" },
        { status: 409 }
      );
    }

    const { days = 1 } = await request.json();

    // Validate input
    const safeDays = Math.max(1, Math.min(30, Math.floor(Number(days) || 1)));

    // Run the fetch command
    const result = await runFetch(safeDays);

    if (result.success) {
      return NextResponse.json({
        success: true,
        message: `Fetch operation completed successfully for ${safeDays} day(s)`,
        output: result.output,
      });
    } else {
      return NextResponse.json(
        {
          success: false,
          error: result.error || "Fetch operation failed",
          output: result.output,
        },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error("Failed to trigger fetch:", error);
    return NextResponse.json(
      { error: "Failed to trigger fetch operation" },
      { status: 500 }
    );
  }
}

export async function GET() {
  // Return status of fetch operation
  const running = isOperationRunning("fetch");
  return NextResponse.json({
    running,
    operationId: "fetch",
  });
}
