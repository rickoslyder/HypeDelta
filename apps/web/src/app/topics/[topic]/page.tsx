import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { getClaims, getTopicStats } from "@/lib/db";
import { Calendar, User, ExternalLink, FlaskConical, Users, ArrowRight } from "lucide-react";

export const dynamic = "force-dynamic";

// Format relative time
function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays > 30) {
    return date.toLocaleDateString();
  } else if (diffDays > 0) {
    return `${diffDays}d ago`;
  } else {
    return "Today";
  }
}

interface TopicPageProps {
  params: Promise<{ topic: string }>;
}

export default async function TopicPage({ params }: TopicPageProps) {
  const { topic } = await params;
  const decodedTopic = decodeURIComponent(topic);

  // Get topic stats and claims
  const [topicStats, claimsResult] = await Promise.all([
    getTopicStats(30),
    getClaims({ topic: decodedTopic, days: 30, limit: 50 }),
  ]);
  const claims = claimsResult.claims;

  const stats = topicStats.find((t) => t.topic === decodedTopic);

  if (!stats && claims.length === 0) {
    notFound();
  }

  const labClaims = claims.filter((c) => c.author_category === "lab-researcher");
  const criticClaims = claims.filter((c) => c.author_category === "critic");
  const bullishness = Number(stats?.avg_bullishness) || 0.5;

  return (
    <div className="w-full px-4 md:px-8 lg:px-12 py-8">
      {/* Breadcrumb */}
      <Breadcrumb
        items={[
          { label: "Topics", href: "/topics" },
          { label: decodedTopic },
        ]}
      />

      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-4 mb-4">
          <h1 className="text-3xl font-bold capitalize">{decodedTopic}</h1>
          <Badge
            variant={bullishness > 0.6 ? "success" : bullishness < 0.4 ? "destructive" : "secondary"}
            className="text-sm"
          >
            {Math.round(bullishness * 100)}% bullish
          </Badge>
        </div>
        <p className="text-muted-foreground">
          {stats?.claim_count || claims.length} claims over the last 30 days
        </p>
      </div>

      {/* Stats cards */}
      <div className="grid gap-4 md:grid-cols-4 mb-8">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Claims</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.claim_count || claims.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <FlaskConical className="h-4 w-4 text-blue-500" />
              Lab Researchers
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.lab_count || labClaims.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Users className="h-4 w-4 text-orange-500" />
              Critics
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.critic_count || criticClaims.length}</div>
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

      {/* Claims split by category */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Lab Researcher Claims */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FlaskConical className="h-5 w-5 text-blue-500" />
              Lab Researcher Claims
            </CardTitle>
            <CardDescription>
              What researchers at major AI labs are saying
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {labClaims.length === 0 ? (
                <p className="text-sm text-muted-foreground">No lab researcher claims on this topic.</p>
              ) : (
                labClaims.slice(0, 10).map((claim) => (
                  <ClaimItem key={claim.id} claim={claim} />
                ))
              )}
            </div>
          </CardContent>
        </Card>

        {/* Critic Claims */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5 text-orange-500" />
              Critic Claims
            </CardTitle>
            <CardDescription>
              What critics and skeptics are saying
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {criticClaims.length === 0 ? (
                <p className="text-sm text-muted-foreground">No critic claims on this topic.</p>
              ) : (
                criticClaims.slice(0, 10).map((claim) => (
                  <ClaimItem key={claim.id} claim={claim} />
                ))
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* All claims link */}
      <div className="mt-6 text-center">
        <Link
          href={`/claims?topic=${decodedTopic}`}
          className="inline-flex items-center gap-2 text-sm text-primary hover:underline"
        >
          View all claims for this topic
          <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </div>
  );
}

interface ClaimItemProps {
  claim: {
    id: string;
    claim_text: string;
    claim_type: string;
    author_handle: string | null;
    bullishness: number | null;
    extracted_at: string;
    source_url: string | null;
  };
}

function ClaimItem({ claim }: ClaimItemProps) {
  return (
    <div className="border-l-2 border-muted pl-3 py-1">
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <Badge variant="outline" className="capitalize text-xs">
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
        {claim.author_handle && (
          <Link
            href={`/researchers/${claim.author_handle}`}
            className="flex items-center gap-1 hover:underline"
          >
            <User className="h-3 w-3" />
            @{claim.author_handle}
          </Link>
        )}
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
  );
}
