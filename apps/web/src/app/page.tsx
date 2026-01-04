import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getSystemStatus, getTopicStats, getLatestSynthesis } from "@/lib/db";
import { ArrowRight, TrendingUp, TrendingDown, Activity, FileText, Users, Database } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [status, topics, synthesis] = await Promise.all([
    getSystemStatus(),
    getTopicStats(14),
    getLatestSynthesis(),
  ]);

  // Parse hype assessment if available
  const hypeAssessment = synthesis?.hype_assessment as {
    overallSentiment?: number;
    overhyped?: Array<{ topic: string; delta: number; reason: string }>;
    underhyped?: Array<{ topic: string; delta: number; reason: string }>;
  } | null;

  return (
    <div className="container max-w-screen-2xl py-8 px-4 md:px-6">
      {/* Hero Section */}
      <div className="flex flex-col items-center text-center mb-12">
        <h1 className="text-4xl font-bold tracking-tight mb-4">
          AI Intelligence Digest
        </h1>
        <p className="text-xl text-muted-foreground max-w-2xl mb-6">
          Weekly synthesis of AI research discourse. Track what lab researchers
          are saying vs critics. Identify overhyped and underhyped topics.
        </p>
        <div className="flex gap-4">
          <Link
            href="/digest"
            className="inline-flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md hover:bg-primary/90 transition-colors"
          >
            Read Latest Digest <ArrowRight className="h-4 w-4" />
          </Link>
          <Link
            href="/topics"
            className="inline-flex items-center gap-2 border px-4 py-2 rounded-md hover:bg-accent transition-colors"
          >
            Explore Topics
          </Link>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4 mb-8">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Claims</CardTitle>
            <FileText className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{status.claims.total.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">
              +{status.claims.last_24h} in last 24h
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Sources</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{status.sources.active}</div>
            <p className="text-xs text-muted-foreground">
              of {status.sources.total} total
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Content Processed</CardTitle>
            <Database className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{status.content.processed_content.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">
              {status.content.unprocessed_content} pending
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Syntheses</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{status.synthesis.count}</div>
            <p className="text-xs text-muted-foreground">
              Latest: {status.synthesis.latest ? new Date(status.synthesis.latest).toLocaleDateString() : 'None'}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Topics and Hype Assessment */}
      <div className="grid gap-6 md:grid-cols-2 mb-8">
        {/* Top Topics */}
        <Card>
          <CardHeader>
            <CardTitle>Top Topics (14 days)</CardTitle>
            <CardDescription>Claims by topic with sentiment breakdown</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {topics.slice(0, 8).map((topic) => {
                const totalClaims = Number(topic.claim_count);
                const bullishness = Number(topic.avg_bullishness) || 0.5;
                const labCount = Number(topic.lab_count);
                const criticCount = Number(topic.critic_count);

                return (
                  <Link
                    key={topic.topic}
                    href={`/topics/${topic.topic}`}
                    className="flex items-center justify-between p-2 rounded hover:bg-accent transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <Badge variant="outline" className="capitalize">
                        {topic.topic}
                      </Badge>
                      <span className="text-sm text-muted-foreground">
                        {totalClaims} claims
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        Lab: {labCount} / Critic: {criticCount}
                      </span>
                      <Badge
                        variant={bullishness > 0.6 ? "success" : bullishness < 0.4 ? "destructive" : "secondary"}
                        className="text-xs"
                      >
                        {Math.round(bullishness * 100)}%
                      </Badge>
                    </div>
                  </Link>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* Hype Assessment */}
        <Card>
          <CardHeader>
            <CardTitle>Hype Assessment</CardTitle>
            <CardDescription>Overhyped vs underhyped topics</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-6">
              {/* Overhyped */}
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <TrendingUp className="h-4 w-4 text-red-500" />
                  <span className="font-medium text-sm">Overhyped</span>
                </div>
                <div className="space-y-2">
                  {hypeAssessment?.overhyped?.slice(0, 3).map((item) => (
                    <div key={item.topic} className="flex items-center justify-between p-2 rounded bg-red-50 dark:bg-red-950/30">
                      <Badge variant="outline" className="capitalize">{item.topic}</Badge>
                      <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                        {item.reason?.slice(0, 50)}...
                      </span>
                    </div>
                  )) || (
                    <p className="text-sm text-muted-foreground">No synthesis data available</p>
                  )}
                </div>
              </div>

              {/* Underhyped */}
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <TrendingDown className="h-4 w-4 text-green-500" />
                  <span className="font-medium text-sm">Underhyped</span>
                </div>
                <div className="space-y-2">
                  {hypeAssessment?.underhyped?.slice(0, 3).map((item) => (
                    <div key={item.topic} className="flex items-center justify-between p-2 rounded bg-green-50 dark:bg-green-950/30">
                      <Badge variant="outline" className="capitalize">{item.topic}</Badge>
                      <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                        {item.reason?.slice(0, 50)}...
                      </span>
                    </div>
                  )) || (
                    <p className="text-sm text-muted-foreground">No synthesis data available</p>
                  )}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Quick Links */}
      <div className="grid gap-4 md:grid-cols-3">
        <Link href="/digest">
          <Card className="hover:bg-accent transition-colors cursor-pointer h-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText className="h-5 w-5" />
                Weekly Digest
              </CardTitle>
              <CardDescription>
                Read the full synthesis of AI research discourse with key debates,
                predictions, and signals.
              </CardDescription>
            </CardHeader>
          </Card>
        </Link>
        <Link href="/claims">
          <Card className="hover:bg-accent transition-colors cursor-pointer h-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Database className="h-5 w-5" />
                Claim Browser
              </CardTitle>
              <CardDescription>
                Search and filter through all extracted claims. Filter by topic,
                author, stance, and more.
              </CardDescription>
            </CardHeader>
          </Card>
        </Link>
        <Link href="/researchers">
          <Card className="hover:bg-accent transition-colors cursor-pointer h-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="h-5 w-5" />
                Researchers
              </CardTitle>
              <CardDescription>
                Browse researcher profiles. See their claims, topics, and
                prediction accuracy over time.
              </CardDescription>
            </CardHeader>
          </Card>
        </Link>
      </div>
    </div>
  );
}
