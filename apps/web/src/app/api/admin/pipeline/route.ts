import { NextRequest, NextResponse } from "next/server";
import { runFetch, runProcess, runSynthesize, getRunningOperations } from "@/lib/cli-runner";

export async function POST(request: NextRequest) {
  try {
    // Check if any pipeline operation is already running
    const running = getRunningOperations();
    if (running.length > 0) {
      return NextResponse.json(
        { error: `Operations already running: ${running.join(", ")}` },
        { status: 409 }
      );
    }

    const { days = 7, limit = 100 } = await request.json();

    // Validate inputs
    const safeDays = Math.max(1, Math.min(30, Math.floor(Number(days) || 7)));
    const safeLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));

    const results: {
      fetch?: { success: boolean; output?: string; error?: string };
      process?: { success: boolean; output?: string; error?: string };
      synthesize?: { success: boolean; output?: string; error?: string };
    } = {};

    // Step 1: Fetch
    console.log("[Pipeline] Starting fetch...");
    const fetchResult = await runFetch(safeDays);
    results.fetch = {
      success: fetchResult.success,
      output: fetchResult.output,
      error: fetchResult.error,
    };

    if (!fetchResult.success) {
      return NextResponse.json({
        success: false,
        message: "Pipeline failed at fetch stage",
        results,
      }, { status: 500 });
    }

    // Step 2: Process
    console.log("[Pipeline] Starting process...");
    const processResult = await runProcess(safeLimit);
    results.process = {
      success: processResult.success,
      output: processResult.output,
      error: processResult.error,
    };

    if (!processResult.success) {
      return NextResponse.json({
        success: false,
        message: "Pipeline failed at process stage",
        results,
      }, { status: 500 });
    }

    // Step 3: Synthesize
    console.log("[Pipeline] Starting synthesize...");
    const synthesizeResult = await runSynthesize(safeDays);
    results.synthesize = {
      success: synthesizeResult.success,
      output: synthesizeResult.output,
      error: synthesizeResult.error,
    };

    if (!synthesizeResult.success) {
      return NextResponse.json({
        success: false,
        message: "Pipeline failed at synthesize stage",
        results,
      }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      message: `Full pipeline completed successfully (${safeDays} days, limit: ${safeLimit})`,
      results,
    });
  } catch (error) {
    console.error("Failed to run pipeline:", error);
    return NextResponse.json(
      { error: "Failed to run pipeline" },
      { status: 500 }
    );
  }
}

export async function GET() {
  // Return status of all pipeline operations
  const running = getRunningOperations();
  return NextResponse.json({
    running: running.length > 0,
    operations: running,
  });
}
