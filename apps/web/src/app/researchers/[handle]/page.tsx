import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { getClaims, getResearchers, getPredictions } from "@/lib/db";
import { Calendar, ExternalLink, MessageSquare, TrendingUp, Target } from "lucide-react";

export const dynamic = "force-dynamic";

interface ResearcherPageProps {
  params: Promise<{ handle: string }>;
}

export default async function ResearcherPage({ params }: ResearcherPageProps) {
  const { handle } = await params;
  const decodedHandle = decodeURIComponent(handle);

  // Get researcher info and claims
  const [researchers, claimsResult, predictions] = await Promise.all([
    getResearchers(365), // Get all researchers
    getClaims({ author: decodedHandle, days: 90, limit: 50 }),
    getPredictions({ author: decodedHandle, limit: 20 }),
  ]);
  const claims = claimsResult.claims;

  const researcher = researchers.find((r) => r.handle === decodedHandle);

  if (!researcher && claims.length === 0) {
    notFound();
  }

  const bullishness = Number(researcher?.avg_bullishness) || 0.5;

  // Group claims by topic
  const claimsByTopic = claims.reduce((acc, claim) => {
    const topic = claim.topic || "other";
    if (!acc[topic]) acc[topic] = [];
    acc[topic].push(claim);
    return acc;
  }, {} as Record<string, typeof claims>);

  const topTopics = Object.entries(claimsByTopic)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 5);

  return (
    <div className="w-full px-4 md:px-8 lg:px-12 py-8">
      {/* Breadcrumb */}
      <Breadcrumb
        items={[
          { label: "Researchers", href: "/researchers" },
          { label: `@${decodedHandle}` },
        ]}
      />

      {/* Header */}
      <div className="mb-8">
        <div className="flex flex-wrap items-center gap-4 mb-2">
          <h1 className="text-3xl font-bold">@{decodedHandle}</h1>
          {researcher && (
            <Badge
              variant={
                researcher.category === "lab-researcher"
                  ? "default"
                  : researcher.category === "critic"
                  ? "secondary"
                  : "outline"
              }
              className="capitalize"
            >
              {researcher.category?.replace("_", " ") || "Unknown"}
            </Badge>
          )}
        </div>
        {researcher && (
          <p className="text-muted-foreground">
            {researcher.name}
            {researcher.name && researcher.affiliation && " • "}
            {researcher.affiliation}
          </p>
        )}
      </div>

      {/* Stats cards */}
      <div className="grid gap-4 md:grid-cols-4 mb-8">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <MessageSquare className="h-4 w-4" />
              Claims (90d)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{claims.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Target className="h-4 w-4" />
              Predictions
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{predictions.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <TrendingUp className="h-4 w-4" />
              Topics
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{Object.keys(claimsByTopic).length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Avg. Sentiment</CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${
              bullishness > 0.6 ? "text-green-600" : bullishness < 0.4 ? "text-red-600" : "text-amber-600"
            }`}>
              {bullishness > 0.6 ? "Bullish" : bullishness < 0.4 ? "Bearish" : "Neutral"}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Main content - Claims */}
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Recent Claims</CardTitle>
              <CardDescription>Claims extracted over the last 90 days</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {claims.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No claims found for this researcher.</p>
                ) : (
                  claims.slice(0, 20).map((claim) => (
                    <div key={claim.id} className="border-l-2 border-muted pl-3 py-1">
                      <div className="flex flex-wrap items-center gap-2 mb-1">
                        <Badge variant="outline" className="capitalize text-xs">
                          {claim.topic}
                        </Badge>
                        <Badge variant="secondary" className="capitalize text-xs">
                          {claim.claim_type}
                        </Badge>
                        {claim.bullishness !== null && (
                          <Badge
                            variant={
                              claim.bullishness > 0.6
                                ? "success"
                                : claim.bullishness < 0.4
                                ? "destructive"
                                : "secondary"
                            }
                            className="text-xs"
                          >
                            {claim.bullishness > 0.6 ? "Bullish" : claim.bullishness < 0.4 ? "Bearish" : "Neutral"}
                          </Badge>
                        )}
                      </div>
                      <p className="text-sm mb-2">{claim.claim_text}</p>
                      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                        <div className="flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          {new Date(claim.extracted_at).toLocaleDateString()}
                        </div>
                        {claim.source_url && (
                          <a
                            href={claim.source_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 hover:underline"
                          >
                            <ExternalLink className="h-3 w-3" />
                            Source
                          </a>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>

          {/* Predictions */}
          {predictions.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Predictions</CardTitle>
                <CardDescription>Tracked predictions and their outcomes</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {predictions.map((prediction) => (
                    <div key={prediction.id} className="border-l-2 border-muted pl-3 py-1">
                      <div className="flex flex-wrap items-center gap-2 mb-1">
                        <Badge
                          variant={
                            prediction.status === "verified"
                              ? "success"
                              : prediction.status === "failed"
                              ? "destructive"
                              : "secondary"
                          }
                          className="capitalize text-xs"
                        >
                          {prediction.status || "pending"}
                        </Badge>
                        {prediction.timeframe && (
                          <span className="text-xs text-muted-foreground">
                            Timeframe: {prediction.timeframe}
                          </span>
                        )}
                      </div>
                      <p className="text-sm">{prediction.prediction_text}</p>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* Top Topics */}
          <Card>
            <CardHeader>
              <CardTitle>Top Topics</CardTitle>
              <CardDescription>Most discussed topics</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {topTopics.map(([topic, topicClaims]) => (
                  <Link
                    key={topic}
                    href={`/topics/${topic}`}
                    className="flex items-center justify-between p-2 rounded hover:bg-accent transition-colors"
                  >
                    <Badge variant="outline" className="capitalize">
                      {topic}
                    </Badge>
                    <span className="text-sm text-muted-foreground">
                      {topicClaims.length} claims
                    </span>
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Sentiment Distribution */}
          <Card>
            <CardHeader>
              <CardTitle>Sentiment Distribution</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {(() => {
                  const bullish = claims.filter((c) => (c.bullishness ?? 0.5) > 0.6).length;
                  const bearish = claims.filter((c) => (c.bullishness ?? 0.5) < 0.4).length;
                  const neutral = claims.length - bullish - bearish;
                  const total = claims.length || 1;

                  return (
                    <>
                      <div className="space-y-1">
                        <div className="flex justify-between text-sm">
                          <span className="text-green-600">Bullish</span>
                          <span>{bullish} ({Math.round(bullish / total * 100)}%)</span>
                        </div>
                        <div className="h-2 bg-muted rounded-full overflow-hidden">
                          <div
                            className="h-full bg-green-500 rounded-full"
                            style={{ width: `${(bullish / total) * 100}%` }}
                          />
                        </div>
                      </div>
                      <div className="space-y-1">
                        <div className="flex justify-between text-sm">
                          <span className="text-amber-600">Neutral</span>
                          <span>{neutral} ({Math.round(neutral / total * 100)}%)</span>
                        </div>
                        <div className="h-2 bg-muted rounded-full overflow-hidden">
                          <div
                            className="h-full bg-amber-500 rounded-full"
                            style={{ width: `${(neutral / total) * 100}%` }}
                          />
                        </div>
                      </div>
                      <div className="space-y-1">
                        <div className="flex justify-between text-sm">
                          <span className="text-red-600">Bearish</span>
                          <span>{bearish} ({Math.round(bearish / total * 100)}%)</span>
                        </div>
                        <div className="h-2 bg-muted rounded-full overflow-hidden">
                          <div
                            className="h-full bg-red-500 rounded-full"
                            style={{ width: `${(bearish / total) * 100}%` }}
                          />
                        </div>
                      </div>
                    </>
                  );
                })()}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
