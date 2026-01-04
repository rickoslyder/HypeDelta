import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Markdown } from "@/components/markdown";
import { getLatestSynthesis, getTopicStats } from "@/lib/db";
import { TrendingUp, TrendingDown, Calendar, AlertCircle } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function DigestPage() {
  const [synthesis, topics] = await Promise.all([
    getLatestSynthesis(),
    getTopicStats(14),
  ]);

  if (!synthesis) {
    return (
      <div className="container max-w-screen-2xl py-8 px-4 md:px-6">
        <div className="flex flex-col items-center justify-center min-h-[400px] text-center">
          <AlertCircle className="h-12 w-12 text-muted-foreground mb-4" />
          <h1 className="text-2xl font-bold mb-2">No Digest Available</h1>
          <p className="text-muted-foreground">
            Run the synthesis process to generate a digest.
          </p>
        </div>
      </div>
    );
  }

  const hypeAssessment = synthesis.hype_assessment;

  return (
    <div className="container max-w-screen-2xl py-8 px-4 md:px-6">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-2 text-muted-foreground mb-2">
          <Calendar className="h-4 w-4" />
          <span className="text-sm">
            Generated {new Date(synthesis.created_at).toLocaleDateString("en-US", {
              weekday: "long",
              year: "numeric",
              month: "long",
              day: "numeric",
            })}
          </span>
        </div>
        <h1 className="text-3xl font-bold mb-2">Weekly AI Intelligence Digest</h1>
        <p className="text-muted-foreground">
          Period: {new Date(synthesis.period_start).toLocaleDateString()} - {new Date(synthesis.period_end).toLocaleDateString()}
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Main Content */}
        <div className="lg:col-span-2 space-y-6">
          {/* Digest Content */}
          {synthesis.digest_markdown && (
            <Card>
              <CardHeader>
                <CardTitle>Full Digest</CardTitle>
              </CardHeader>
              <CardContent>
                <Markdown>{synthesis.digest_markdown}</Markdown>
              </CardContent>
            </Card>
          )}

          {/* Topic Syntheses */}
          {synthesis.syntheses && synthesis.syntheses.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Topic Syntheses</CardTitle>
                <CardDescription>Summary by topic from the past {synthesis.lookback_days} days</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-6">
                  {synthesis.syntheses.map((topicSynthesis, i) => (
                    <div key={i} className="border-l-2 border-primary pl-4">
                      <Badge variant="outline" className="mb-2 capitalize">
                        {topicSynthesis.topic}
                      </Badge>
                      {topicSynthesis.summary && (
                        <p className="text-sm mb-3">{topicSynthesis.summary}</p>
                      )}
                      {topicSynthesis.keyDebates && topicSynthesis.keyDebates.length > 0 && (
                        <div className="space-y-2">
                          {topicSynthesis.keyDebates.map((debate, j) => (
                            <div key={j} className="text-sm">
                              <p className="text-muted-foreground">{debate.summary}</p>
                              {(debate.labPosition || debate.criticPosition) && (
                                <div className="grid gap-2 md:grid-cols-2 text-xs mt-2">
                                  {debate.labPosition && (
                                    <div className="p-2 rounded bg-blue-50 dark:bg-blue-950/30">
                                      <span className="font-medium text-blue-600 dark:text-blue-400">Lab:</span>
                                      <p className="text-muted-foreground mt-1">{debate.labPosition}</p>
                                    </div>
                                  )}
                                  {debate.criticPosition && (
                                    <div className="p-2 rounded bg-orange-50 dark:bg-orange-950/30">
                                      <span className="font-medium text-orange-600 dark:text-orange-400">Critic:</span>
                                      <p className="text-muted-foreground mt-1">{debate.criticPosition}</p>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* Hype Assessment */}
          <Card>
            <CardHeader>
              <CardTitle>Hype Assessment</CardTitle>
              <CardDescription>Lab enthusiasm vs critic skepticism</CardDescription>
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
                    {hypeAssessment?.overhyped?.map((item) => (
                      <div key={item.topic} className="p-2 rounded bg-red-50 dark:bg-red-950/30">
                        <div className="flex items-center justify-between mb-1">
                          <Badge variant="outline" className="capitalize text-xs">{item.topic}</Badge>
                          <span className="text-xs text-red-600 dark:text-red-400">
                            +{Math.round(item.delta * 100)}%
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground">{item.reason}</p>
                      </div>
                    )) || (
                      <p className="text-sm text-muted-foreground">No data</p>
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
                    {hypeAssessment?.underhyped?.map((item) => (
                      <div key={item.topic} className="p-2 rounded bg-green-50 dark:bg-green-950/30">
                        <div className="flex items-center justify-between mb-1">
                          <Badge variant="outline" className="capitalize text-xs">{item.topic}</Badge>
                          <span className="text-xs text-green-600 dark:text-green-400">
                            {Math.round(item.delta * 100)}%
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground">{item.reason}</p>
                      </div>
                    )) || (
                      <p className="text-sm text-muted-foreground">No data</p>
                    )}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Topics This Period */}
          <Card>
            <CardHeader>
              <CardTitle>Active Topics</CardTitle>
              <CardDescription>Claims by topic (14 days)</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {topics.slice(0, 10).map((topic) => (
                  <div key={topic.topic} className="flex items-center justify-between text-sm">
                    <Badge variant="outline" className="capitalize">{topic.topic}</Badge>
                    <span className="text-muted-foreground">{topic.claim_count} claims</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
