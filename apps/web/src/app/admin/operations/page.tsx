"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  Play,
  RefreshCw,
  Zap,
  FileText,
  Loader2,
  CheckCircle,
  XCircle,
} from "lucide-react";

interface OperationResult {
  success: boolean;
  message?: string;
  error?: string;
  details?: Record<string, unknown>;
}

export default function OperationsPage() {
  const [loading, setLoading] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, OperationResult>>({});

  const runOperation = async (operation: string, options: Record<string, unknown> = {}) => {
    setLoading(operation);
    setResults((prev) => ({ ...prev, [operation]: undefined as unknown as OperationResult }));

    try {
      const response = await fetch(`/api/admin/${operation}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(options),
      });

      const data = await response.json();

      if (!response.ok) {
        setResults((prev) => ({
          ...prev,
          [operation]: { success: false, error: data.error || "Operation failed" },
        }));
      } else {
        setResults((prev) => ({
          ...prev,
          [operation]: { success: true, message: data.message, details: data },
        }));
      }
    } catch (error) {
      setResults((prev) => ({
        ...prev,
        [operation]: { success: false, error: String(error) },
      }));
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="w-full px-4 md:px-8 lg:px-12 py-8">
      {/* Back link */}
      <Link
        href="/admin"
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-6"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Admin
      </Link>

      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Operations</h1>
        <p className="text-muted-foreground">
          Trigger data pipeline operations manually.
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Fetch Operation */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <RefreshCw className="h-5 w-5" />
              Fetch Content
            </CardTitle>
            <CardDescription>
              Fetch new content from all active sources (Twitter, Substack, etc.)
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Button
                onClick={() => runOperation("fetch", { days: 1 })}
                disabled={loading !== null}
              >
                {loading === "fetch" ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Play className="h-4 w-4 mr-2" />
                )}
                Fetch (1 day)
              </Button>
              <Button
                variant="outline"
                onClick={() => runOperation("fetch", { days: 7 })}
                disabled={loading !== null}
              >
                Fetch (7 days)
              </Button>
            </div>
            {results.fetch && <OperationResultDisplay result={results.fetch} />}
          </CardContent>
        </Card>

        {/* Process Operation */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5" />
              Process Content
            </CardTitle>
            <CardDescription>
              Extract claims from unprocessed content using AI
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Button
                onClick={() => runOperation("process", { limit: 50 })}
                disabled={loading !== null}
              >
                {loading === "process" ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Play className="h-4 w-4 mr-2" />
                )}
                Process (50 items)
              </Button>
              <Button
                variant="outline"
                onClick={() => runOperation("process", { limit: 200 })}
                disabled={loading !== null}
              >
                Process (200 items)
              </Button>
            </div>
            {results.process && <OperationResultDisplay result={results.process} />}
          </CardContent>
        </Card>

        {/* Synthesize Operation */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Synthesize
            </CardTitle>
            <CardDescription>
              Generate weekly synthesis and digest from extracted claims
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Button
                onClick={() => runOperation("synthesize", { days: 7 })}
                disabled={loading !== null}
              >
                {loading === "synthesize" ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Play className="h-4 w-4 mr-2" />
                )}
                Synthesize (7 days)
              </Button>
              <Button
                variant="outline"
                onClick={() => runOperation("synthesize", { days: 14 })}
                disabled={loading !== null}
              >
                Synthesize (14 days)
              </Button>
            </div>
            {results.synthesize && <OperationResultDisplay result={results.synthesize} />}
          </CardContent>
        </Card>

        {/* Full Pipeline */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Play className="h-5 w-5" />
              Full Pipeline
            </CardTitle>
            <CardDescription>
              Run the complete pipeline: fetch → process → synthesize
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button
              onClick={() => runOperation("pipeline", { days: 7, limit: 100 })}
              disabled={loading !== null}
              className="w-full"
            >
              {loading === "pipeline" ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Play className="h-4 w-4 mr-2" />
              )}
              Run Full Pipeline
            </Button>
            {results.pipeline && <OperationResultDisplay result={results.pipeline} />}
          </CardContent>
        </Card>
      </div>

      {/* Operation Notes */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Notes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>• <strong>Fetch</strong>: Retrieves new content from Twitter, Substack, and other sources.</p>
          <p>• <strong>Process</strong>: Uses AI to extract claims, predictions, and signals from content.</p>
          <p>• <strong>Synthesize</strong>: Aggregates claims into topic syntheses and generates the weekly digest.</p>
          <p>• Operations can take several minutes depending on the amount of content.</p>
        </CardContent>
      </Card>
    </div>
  );
}

function OperationResultDisplay({ result }: { result: OperationResult }) {
  return (
    <div
      className={`p-3 rounded-md ${
        result.success ? "bg-green-50 dark:bg-green-950/30" : "bg-red-50 dark:bg-red-950/30"
      }`}
    >
      <div className="flex items-center gap-2 mb-1">
        {result.success ? (
          <CheckCircle className="h-4 w-4 text-green-600" />
        ) : (
          <XCircle className="h-4 w-4 text-red-600" />
        )}
        <span className={`text-sm font-medium ${result.success ? "text-green-600" : "text-red-600"}`}>
          {result.success ? "Success" : "Failed"}
        </span>
      </div>
      {result.message && <p className="text-sm text-muted-foreground">{result.message}</p>}
      {result.error && <p className="text-sm text-red-600">{result.error}</p>}
      {result.details && result.success && (
        <div className="mt-2 text-xs text-muted-foreground">
          <pre className="whitespace-pre-wrap">
            {JSON.stringify(result.details, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
