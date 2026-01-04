import { NextRequest, NextResponse } from "next/server";
import { runProcess, isOperationRunning } from "@/lib/cli-runner";

export async function POST(request: NextRequest) {
  try {
    // Check if process is already running
    if (isOperationRunning("process")) {
      return NextResponse.json(
        { error: "Process operation is already running" },
        { status: 409 }
      );
    }

    const { limit = 50 } = await request.json();

    // Validate input
    const safeLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 50)));

    // Run the process command
    const result = await runProcess(safeLimit);

    if (result.success) {
      return NextResponse.json({
        success: true,
        message: `Process operation completed successfully (limit: ${safeLimit})`,
        output: result.output,
      });
    } else {
      return NextResponse.json(
        {
          success: false,
          error: result.error || "Process operation failed",
          output: result.output,
        },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error("Failed to trigger process:", error);
    return NextResponse.json(
      { error: "Failed to trigger process operation" },
      { status: 500 }
    );
  }
}

export async function GET() {
  // Return status of process operation
  const running = isOperationRunning("process");
  return NextResponse.json({
    running,
    operationId: "process",
  });
}
