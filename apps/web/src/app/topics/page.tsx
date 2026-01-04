import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/ui/empty-state";
import { getTopicStats } from "@/lib/db";
import { TrendingUp, Users, FlaskConical, ArrowUpDown, HelpCircle } from "lucide-react";

export const dynamic = "force-dynamic";

type SortOption = "claims" | "bullishness" | "lab_ratio";

interface TopicsPageProps {
  searchParams: Promise<{
    sort?: SortOption;
  }>;
}

export default async function TopicsPage({ searchParams }: TopicsPageProps) {
  const params = await searchParams;
  const sortBy = params.sort || "claims";
  const rawTopics = await getTopicStats(30);

  // Sort topics based on selected option
  const topics = [...rawTopics].sort((a, b) => {
    switch (sortBy) {
      case "bullishness":
        return Number(b.avg_bullishness) - Number(a.avg_bullishness);
      case "lab_ratio":
        const aRatio = Number(a.claim_count) > 0 ? Number(a.lab_count) / Number(a.claim_count) : 0;
        const bRatio = Number(b.claim_count) > 0 ? Number(b.lab_count) / Number(b.claim_count) : 0;
        return bRatio - aRatio;
      case "claims":
      default:
        return Number(b.claim_count) - Number(a.claim_count);
    }
  });

  return (
    <div className="container max-w-screen-2xl py-8 px-4 md:px-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-bold mb-2">Topics</h1>
          <p className="text-muted-foreground">
            AI research topics with claim counts and sentiment breakdown over the last 30 days.
          </p>
        </div>

        {/* Sort controls */}
        <div className="flex items-center gap-2">
          <ArrowUpDown className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Sort by:</span>
          <div className="flex gap-1">
            <Link href="/topics?sort=claims">
              <Badge variant={sortBy === "claims" ? "default" : "outline"} className="cursor-pointer">
                Claims
              </Badge>
            </Link>
            <Tooltip>
              <TooltipTrigger asChild>
                <Link href="/topics?sort=bullishness">
                  <Badge variant={sortBy === "bullishness" ? "default" : "outline"} className="cursor-pointer">
                    Sentiment
                  </Badge>
                </Link>
              </TooltipTrigger>
              <TooltipContent>
                Average bullishness/optimism in claims about this topic
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Link href="/topics?sort=lab_ratio">
                  <Badge variant={sortBy === "lab_ratio" ? "default" : "outline"} className="cursor-pointer">
                    Lab Ratio
                  </Badge>
                </Link>
              </TooltipTrigger>
              <TooltipContent>
                Proportion of claims from AI lab researchers vs. critics
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {topics.map((topic) => {
          const totalClaims = Number(topic.claim_count);
          const bullishness = Number(topic.avg_bullishness) || 0.5;
          const labCount = Number(topic.lab_count);
          const criticCount = Number(topic.critic_count);
          const labRatio = totalClaims > 0 ? labCount / totalClaims : 0.5;

          return (
            <Link key={topic.topic} href={`/topics/${topic.topic}`}>
              <Card className="hover:bg-accent transition-colors cursor-pointer h-full">
                <CardHeader>
                  <CardTitle className="flex items-center justify-between">
                    <Badge variant="outline" className="capitalize text-base font-semibold">
                      {topic.topic}
                    </Badge>
                    <Badge
                      variant={bullishness > 0.6 ? "success" : bullishness < 0.4 ? "destructive" : "secondary"}
                    >
                      {Math.round(bullishness * 100)}% bullish
                    </Badge>
                  </CardTitle>
                  <CardDescription>
                    {totalClaims} claims in the last 30 days
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    {/* Source breakdown */}
                    <div className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <FlaskConical className="h-4 w-4 text-blue-500" />
                        <span>Lab Researchers</span>
                      </div>
                      <span className="font-medium">{labCount}</span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <Users className="h-4 w-4 text-orange-500" />
                        <span>Critics</span>
                      </div>
                      <span className="font-medium">{criticCount}</span>
                    </div>

                    {/* Visual ratio bar */}
                    <div className="space-y-1">
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <Tooltip>
                          <TooltipTrigger className="flex items-center gap-1 cursor-help">
                            Lab vs Critic ratio
                            <HelpCircle className="h-3 w-3" />
                          </TooltipTrigger>
                          <TooltipContent>
                            Blue = claims from AI lab researchers, Orange = claims from critics
                          </TooltipContent>
                        </Tooltip>
                        <span>{Math.round(labRatio * 100)}% lab</span>
                      </div>
                      <div className="h-2 bg-orange-200 dark:bg-orange-900 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-blue-500 rounded-full transition-all"
                          style={{ width: `${labRatio * 100}%` }}
                        />
                      </div>
                    </div>

                    {/* Sentiment bar */}
                    <div className="space-y-1">
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <Tooltip>
                          <TooltipTrigger className="flex items-center gap-1 cursor-help">
                            Sentiment
                            <HelpCircle className="h-3 w-3" />
                          </TooltipTrigger>
                          <TooltipContent>
                            Average optimism level: Bullish (&gt;60%), Neutral (40-60%), Bearish (&lt;40%)
                          </TooltipContent>
                        </Tooltip>
                        <span className={
                          bullishness > 0.6 ? "text-green-600 dark:text-green-400"
                          : bullishness < 0.4 ? "text-red-600 dark:text-red-400"
                          : "text-amber-600 dark:text-amber-400"
                        }>
                          {bullishness > 0.6 ? "Bullish" : bullishness < 0.4 ? "Bearish" : "Neutral"}
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
        })}
      </div>

      {topics.length === 0 && (
        <EmptyState
          icon={TrendingUp}
          title="No Topics Yet"
          description="Process some content to see topics appear here."
          action={{ label: "View Claims", href: "/claims" }}
        />
      )}
    </div>
  );
}
