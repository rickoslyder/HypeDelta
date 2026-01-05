import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getPredictions } from "@/lib/db";
import {
  ArrowLeft,
  Target,
  CheckCircle,
  XCircle,
  Clock,
  HelpCircle,
  TrendingUp,
  TrendingDown,
  Minus,
} from "lucide-react";

export const dynamic = "force-dynamic";

interface PredictionStats {
  total: number;
  verified: number;
  correct: number;
  incorrect: number;
  pending: number;
}

function calculateStats(predictions: Awaited<ReturnType<typeof getPredictions>>): PredictionStats {
  const total = predictions.length;
  const verified = predictions.filter((p) => p.status === "verified").length;
  const correct = predictions.filter(
    (p) => p.status === "verified" && p.accuracy_score && p.accuracy_score >= 0.7
  ).length;
  const incorrect = predictions.filter(
    (p) => p.status === "verified" && p.accuracy_score && p.accuracy_score < 0.3
  ).length;
  const pending = predictions.filter((p) => !p.status || p.status === "pending").length;

  return { total, verified, correct, incorrect, pending };
}

function getStatusIcon(status: string | null, accuracy: number | null) {
  if (!status || status === "pending") {
    return <Clock className="h-4 w-4 text-yellow-500" />;
  }
  if (status === "verified") {
    if (accuracy && accuracy >= 0.7) {
      return <CheckCircle className="h-4 w-4 text-green-500" />;
    } else if (accuracy && accuracy < 0.3) {
      return <XCircle className="h-4 w-4 text-red-500" />;
    }
    return <Minus className="h-4 w-4 text-muted-foreground" />;
  }
  return <HelpCircle className="h-4 w-4 text-muted-foreground" />;
}

function getStatusBadge(status: string | null, accuracy: number | null) {
  if (!status || status === "pending") {
    return <Badge variant="outline" className="text-yellow-600">Pending</Badge>;
  }
  if (status === "verified") {
    if (accuracy && accuracy >= 0.7) {
      return <Badge variant="default" className="bg-green-500">Correct</Badge>;
    } else if (accuracy && accuracy < 0.3) {
      return <Badge variant="destructive">Incorrect</Badge>;
    }
    return <Badge variant="secondary">Partial</Badge>;
  }
  return <Badge variant="outline">{status}</Badge>;
}

function formatTimeframe(timeframe: string | null): string {
  if (!timeframe) return "Unknown";

  // Try to parse common formats
  const lowerTimeframe = timeframe.toLowerCase();
  if (lowerTimeframe.includes("2024")) return "2024";
  if (lowerTimeframe.includes("2025")) return "2025";
  if (lowerTimeframe.includes("2026")) return "2026";
  if (lowerTimeframe.includes("year")) return timeframe;
  if (lowerTimeframe.includes("month")) return timeframe;

  return timeframe;
}

export default async function PredictionsPage() {
  const predictions = await getPredictions({ limit: 100 });
  const stats = calculateStats(predictions);

  // Group by status
  const pendingPredictions = predictions.filter((p) => !p.status || p.status === "pending");
  const verifiedPredictions = predictions.filter((p) => p.status === "verified");

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
        <h1 className="text-3xl font-bold mb-2">Predictions</h1>
        <p className="text-muted-foreground">
          Track and verify AI predictions from researchers.
        </p>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-5 mb-8">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.total}</div>
            <p className="text-xs text-muted-foreground">predictions tracked</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Clock className="h-4 w-4 text-yellow-500" />
              Pending
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.pending}</div>
            <p className="text-xs text-muted-foreground">awaiting verification</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-green-500" />
              Correct
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.correct}</div>
            <p className="text-xs text-muted-foreground">verified accurate</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <XCircle className="h-4 w-4 text-red-500" />
              Incorrect
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.incorrect}</div>
            <p className="text-xs text-muted-foreground">verified wrong</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Accuracy</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {stats.verified > 0
                ? `${Math.round((stats.correct / stats.verified) * 100)}%`
                : "N/A"}
            </div>
            <p className="text-xs text-muted-foreground">of verified predictions</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Pending Predictions */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5 text-yellow-500" />
              Pending Verification
            </CardTitle>
            <CardDescription>
              Predictions that need to be verified
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3 max-h-[500px] overflow-y-auto">
              {pendingPredictions.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No pending predictions
                </p>
              ) : (
                pendingPredictions.map((prediction) => (
                  <div
                    key={prediction.id}
                    className="p-4 rounded-lg border bg-background"
                  >
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex items-center gap-2">
                        {prediction.author && (
                          <Badge variant="outline">@{prediction.author}</Badge>
                        )}
                        {prediction.topic && (
                          <Badge variant="secondary">{prediction.topic}</Badge>
                        )}
                      </div>
                      <Badge variant="outline" className="text-yellow-600">
                        {formatTimeframe(prediction.timeframe)}
                      </Badge>
                    </div>
                    <p className="text-sm mb-2">{prediction.prediction_text}</p>
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>
                        Made: {new Date(prediction.made_at).toLocaleDateString()}
                      </span>
                      {prediction.confidence && (
                        <span>Confidence: {Math.round(prediction.confidence * 100)}%</span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>

        {/* Verified Predictions */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Target className="h-5 w-5 text-green-500" />
              Verified Predictions
            </CardTitle>
            <CardDescription>
              Predictions that have been checked
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3 max-h-[500px] overflow-y-auto">
              {verifiedPredictions.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No verified predictions yet
                </p>
              ) : (
                verifiedPredictions.map((prediction) => (
                  <div
                    key={prediction.id}
                    className={`p-4 rounded-lg border ${
                      prediction.accuracy_score && prediction.accuracy_score >= 0.7
                        ? "border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/30"
                        : prediction.accuracy_score && prediction.accuracy_score < 0.3
                        ? "border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30"
                        : "bg-background"
                    }`}
                  >
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex items-center gap-2">
                        {getStatusIcon(prediction.status, prediction.accuracy_score)}
                        {prediction.author && (
                          <Badge variant="outline">@{prediction.author}</Badge>
                        )}
                      </div>
                      {getStatusBadge(prediction.status, prediction.accuracy_score)}
                    </div>
                    <p className="text-sm mb-2">{prediction.prediction_text}</p>
                    {prediction.evidence && (
                      <p className="text-xs text-muted-foreground italic mb-2">
                        Evidence: {prediction.evidence}
                      </p>
                    )}
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>
                        Verified: {prediction.verified_at
                          ? new Date(prediction.verified_at).toLocaleDateString()
                          : "Unknown"}
                      </span>
                      {prediction.accuracy_score !== null && (
                        <span>
                          Score: {Math.round(prediction.accuracy_score * 100)}%
                        </span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Leaderboard */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5" />
            Researcher Accuracy
          </CardTitle>
          <CardDescription>
            Prediction accuracy by researcher (verified predictions only)
          </CardDescription>
        </CardHeader>
        <CardContent>
          {(() => {
            // Calculate per-author stats
            const authorStats = new Map<string, { correct: number; total: number }>();

            for (const p of verifiedPredictions) {
              if (!p.author) continue;
              const stats = authorStats.get(p.author) || { correct: 0, total: 0 };
              stats.total++;
              if (p.accuracy_score && p.accuracy_score >= 0.7) {
                stats.correct++;
              }
              authorStats.set(p.author, stats);
            }

            const leaderboard = Array.from(authorStats.entries())
              .map(([author, stats]) => ({
                author,
                ...stats,
                accuracy: stats.total > 0 ? stats.correct / stats.total : 0,
              }))
              .filter((a) => a.total >= 2) // Minimum 2 verified predictions
              .sort((a, b) => b.accuracy - a.accuracy);

            if (leaderboard.length === 0) {
              return (
                <p className="text-sm text-muted-foreground text-center py-8">
                  Not enough verified predictions to show leaderboard
                </p>
              );
            }

            return (
              <div className="space-y-2">
                {leaderboard.map((entry, index) => (
                  <div
                    key={entry.author}
                    className="flex items-center justify-between p-3 rounded-lg border"
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-lg font-bold text-muted-foreground w-6">
                        {index + 1}
                      </span>
                      <span className="font-medium">@{entry.author}</span>
                    </div>
                    <div className="flex items-center gap-4">
                      <span className="text-sm text-muted-foreground">
                        {entry.correct}/{entry.total} correct
                      </span>
                      <Badge
                        variant={entry.accuracy >= 0.7 ? "default" : entry.accuracy >= 0.5 ? "secondary" : "destructive"}
                      >
                        {Math.round(entry.accuracy * 100)}%
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}
        </CardContent>
      </Card>

      {/* Info */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HelpCircle className="h-5 w-5 text-blue-500" />
            About Prediction Tracking
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p>
            Predictions are extracted from researcher claims that include specific,
            verifiable statements about future events or capabilities.
          </p>
          <ul className="list-disc list-inside space-y-1 ml-2">
            <li>Predictions with timeframes are tracked for verification</li>
            <li>Accuracy scores range from 0% (completely wrong) to 100% (exactly right)</li>
            <li>Predictions scoring 70%+ are marked as "Correct"</li>
            <li>Predictions scoring below 30% are marked as "Incorrect"</li>
          </ul>
          <p className="mt-4">
            To verify predictions, use the prediction-tracking skill via the CLI.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
