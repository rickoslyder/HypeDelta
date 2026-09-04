import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getResearchers, RESEARCHER_PUBLIC_WINDOW_DAYS } from "@/lib/db";
import { researcherHref } from "@/lib/claim-href";
import { Users, MessageSquare, TrendingUp, Building2 } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function ResearchersPage() {
  const researchers = await getResearchers(RESEARCHER_PUBLIC_WINDOW_DAYS);

  const labResearchers = researchers.filter((r) => r.side === "lab");
  const critics = researchers.filter((r) => r.side === "critic");
  const independents = researchers.filter((r) => r.side === "other");

  return (
    <div className="w-full px-4 md:px-8 lg:px-12 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Researchers</h1>
        <p className="text-muted-foreground">
          Browse AI researchers and critics. See their claims, topics, and source evidence
          from the last {RESEARCHER_PUBLIC_WINDOW_DAYS} days.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3 mb-8">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Lab Researchers</CardTitle>
            <Building2 className="h-4 w-4 text-blue-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{labResearchers.length}</div>
            <p className="text-xs text-muted-foreground">From major AI labs</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Critics</CardTitle>
            <Users className="h-4 w-4 text-orange-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{critics.length}</div>
            <p className="text-xs text-muted-foreground">Independent critics and skeptics</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Claims</CardTitle>
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {researchers.reduce((sum, r) => sum + Number(r.claim_count), 0)}
            </div>
            <p className="text-xs text-muted-foreground">
              In the last {RESEARCHER_PUBLIC_WINDOW_DAYS} days
            </p>
          </CardContent>
        </Card>
      </div>

      {labResearchers.length > 0 && (
        <div className="mb-8">
          <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
            <Building2 className="h-5 w-5 text-blue-500" />
            Lab Researchers
          </h2>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {labResearchers.map((researcher) => (
              <ResearcherCard key={researcher.handle} researcher={researcher} />
            ))}
          </div>
        </div>
      )}

      {critics.length > 0 && (
        <div className="mb-8">
          <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
            <Users className="h-5 w-5 text-orange-500" />
            Critics & Skeptics
          </h2>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {critics.map((researcher) => (
              <ResearcherCard key={researcher.handle} researcher={researcher} />
            ))}
          </div>
        </div>
      )}

      {independents.length > 0 && (
        <div className="mb-8">
          <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-green-500" />
            Other Researchers
          </h2>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {independents.map((researcher) => (
              <ResearcherCard key={researcher.handle} researcher={researcher} />
            ))}
          </div>
        </div>
      )}

      {researchers.length === 0 && (
        <div className="flex flex-col items-center justify-center min-h-[300px] text-center">
          <Users className="h-12 w-12 text-muted-foreground mb-4" />
          <h2 className="text-xl font-semibold mb-2">No Researchers Found</h2>
          <p className="text-muted-foreground">
            Add sources and process content to see researchers appear here.
          </p>
        </div>
      )}
    </div>
  );
}

interface ResearcherCardProps {
  researcher: {
    handle: string;
    name: string;
    side: "lab" | "critic" | "other";
    affiliation: string | null;
    claim_count: number;
    avg_bullishness: number | null;
    prediction_count: number;
  };
}

function ResearcherCard({ researcher }: ResearcherCardProps) {
  const bullishness = Number(researcher.avg_bullishness) || 0.5;
  const claimCount = Number(researcher.claim_count);
  const predictionCount = Number(researcher.prediction_count);
  const isLab = researcher.side === "lab";
  const isCritic = researcher.side === "critic";

  return (
    <Link href={researcherHref(researcher.handle)}>
      <Card className="hover:bg-accent transition-colors cursor-pointer h-full">
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span className="text-lg">{researcher.name}</span>
            <Badge
              variant={isLab ? "default" : isCritic ? "secondary" : "outline"}
              className="capitalize"
            >
              {researcher.side}
            </Badge>
          </CardTitle>
          {researcher.affiliation && (
            <CardDescription>{researcher.affiliation}</CardDescription>
          )}
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Claims (90d)</span>
              <span className="font-medium">{claimCount}</span>
            </div>
            {predictionCount > 0 && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Predictions</span>
                <span className="font-medium">{predictionCount}</span>
              </div>
            )}
            <div className="space-y-1">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Avg. Sentiment</span>
                <span className={
                  bullishness > 0.6 ? "text-green-600 dark:text-green-400"
                  : bullishness < 0.4 ? "text-red-600 dark:text-red-400"
                  : "text-amber-600 dark:text-amber-400"
                }>
                  {bullishness > 0.6 ? "Bullish" : bullishness < 0.4 ? "Bearish" : "Neutral"}
                  {" "}({Math.round(bullishness * 100)}%)
                </span>
              </div>
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${
                    bullishness > 0.6
                      ? "bg-green-500"
                      : bullishness < 0.4
                      ? "bg-red-500"
                      : "bg-amber-500"
                  }`}
                  style={{ width: `${bullishness * 100}%` }}
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
