import { NextRequest, NextResponse } from "next/server";
import { runSynthesize, isOperationRunning } from "@/lib/cli-runner";

export async function POST(request: NextRequest) {
  try {
    // Check if synthesize is already running
    if (isOperationRunning("synthesize")) {
      return NextResponse.json(
        { error: "Synthesize operation is already running" },
        { status: 409 }
      );
    }

    const { days = 7 } = await request.json();

    // Validate input
    const safeDays = Math.max(1, Math.min(90, Math.floor(Number(days) || 7)));

    // Run the synthesize command
    const result = await runSynthesize(safeDays);

    if (result.success) {
      return NextResponse.json({
        success: true,
        message: `Synthesize operation completed successfully (${safeDays} days)`,
        output: result.output,
      });
    } else {
      return NextResponse.json(
        {
          success: false,
          error: result.error || "Synthesize operation failed",
          output: result.output,
        },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error("Failed to trigger synthesize:", error);
    return NextResponse.json(
      { error: "Failed to trigger synthesize operation" },
      { status: 500 }
    );
  }
}

export async function GET() {
  // Return status of synthesize operation
  const running = isOperationRunning("synthesize");
  return NextResponse.json({
    running,
    operationId: "synthesize",
  });
}
