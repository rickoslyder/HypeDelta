/**
 * CLI Runner utility for executing HypeDelta CLI commands from the web frontend
 */

import { spawn, ChildProcess } from "child_process";
import path from "path";

export interface CliResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode: number | null;
}

// Track running operations to prevent concurrent runs
const runningOperations = new Map<string, ChildProcess>();

/**
 * Execute a CLI command and return the result
 */
export async function runCliCommand(
  command: string,
  args: string[],
  options: {
    timeout?: number;
    operationId?: string;
  } = {}
): Promise<CliResult> {
  const { timeout = 300000, operationId } = options; // 5 minute default timeout

  // Check if this operation is already running
  if (operationId && runningOperations.has(operationId)) {
    return {
      success: false,
      output: "",
      error: `Operation '${operationId}' is already running`,
      exitCode: null,
    };
  }

  return new Promise((resolve) => {
    const projectRoot = path.resolve(process.cwd(), "../..");
    const fullArgs = ["src/cli.ts", command, ...args];

    console.log(`[CLI Runner] Executing: tsx ${fullArgs.join(" ")} in ${projectRoot}`);

    const child = spawn("npx", ["tsx", ...fullArgs], {
      cwd: projectRoot,
      env: {
        ...process.env,
        NODE_ENV: "production",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (operationId) {
      runningOperations.set(operationId, child);
    }

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    const timeoutId = setTimeout(() => {
      child.kill("SIGTERM");
      if (operationId) {
        runningOperations.delete(operationId);
      }
      resolve({
        success: false,
        output: stdout,
        error: `Operation timed out after ${timeout / 1000} seconds`,
        exitCode: null,
      });
    }, timeout);

    child.on("close", (code) => {
      clearTimeout(timeoutId);
      if (operationId) {
        runningOperations.delete(operationId);
      }

      resolve({
        success: code === 0,
        output: stdout,
        error: code !== 0 ? stderr || `Process exited with code ${code}` : undefined,
        exitCode: code,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timeoutId);
      if (operationId) {
        runningOperations.delete(operationId);
      }

      resolve({
        success: false,
        output: stdout,
        error: `Failed to start process: ${err.message}`,
        exitCode: null,
      });
    });
  });
}

/**
 * Run the fetch command
 */
export async function runFetch(days: number = 1): Promise<CliResult> {
  const safeDays = Math.max(1, Math.min(30, Math.floor(days)));
  return runCliCommand("fetch", ["--days", safeDays.toString()], {
    operationId: "fetch",
    timeout: 600000, // 10 minutes for fetching
  });
}

/**
 * Run the process command
 */
export async function runProcess(limit: number = 50): Promise<CliResult> {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  return runCliCommand("process", ["--limit", safeLimit.toString()], {
    operationId: "process",
    timeout: 1800000, // 30 minutes for processing
  });
}

/**
 * Run the synthesize command
 */
export async function runSynthesize(days: number = 7): Promise<CliResult> {
  const safeDays = Math.max(1, Math.min(90, Math.floor(days)));
  return runCliCommand("synthesize", ["--days", safeDays.toString()], {
    operationId: "synthesize",
    timeout: 600000, // 10 minutes for synthesis
  });
}

/**
 * Check if an operation is currently running
 */
export function isOperationRunning(operationId: string): boolean {
  return runningOperations.has(operationId);
}

/**
 * Get status of all running operations
 */
export function getRunningOperations(): string[] {
  return Array.from(runningOperations.keys());
}
