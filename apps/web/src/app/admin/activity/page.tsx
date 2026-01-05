import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getSynthesisHistory, getContentStats } from "@/lib/db";
import {
  ArrowLeft,
  Activity,
  FileText,
  Sparkles,
  Clock,
  CheckCircle,
  TrendingUp,
  Database,
} from "lucide-react";
import pg from "pg";

const { Pool } = pg;

export const dynamic = "force-dynamic";

interface ActivityItem {
  id: string;
  type: "fetch" | "process" | "synthesis";
  timestamp: string;
  details: string;
  count?: number;
}

async function getRecentActivity(): Promise<ActivityItem[]> {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
  });

  try {
    // Get recent content fetches (grouped by hour)
    const fetchActivity = await pool.query(`
      SELECT
        date_trunc('hour', fetched_at) as hour,
        COUNT(*) as count
      FROM content
      WHERE fetched_at > NOW() - INTERVAL '7 days'
      GROUP BY date_trunc('hour', fetched_at)
      ORDER BY hour DESC
      LIMIT 20
    `);

    // Get recent processing activity (grouped by hour)
    const processActivity = await pool.query(`
      SELECT
        date_trunc('hour', processed_at) as hour,
        COUNT(*) as count
      FROM content
      WHERE processed_at IS NOT NULL
        AND processed_at > NOW() - INTERVAL '7 days'
      GROUP BY date_trunc('hour', processed_at)
      ORDER BY hour DESC
      LIMIT 20
    `);

    // Get recent claim extractions (grouped by hour)
    const claimActivity = await pool.query(`
      SELECT
        date_trunc('hour', extracted_at) as hour,
        COUNT(*) as count
      FROM extracted_claims
      WHERE extracted_at > NOW() - INTERVAL '7 days'
      GROUP BY date_trunc('hour', extracted_at)
      ORDER BY hour DESC
      LIMIT 20
    `);

    // Get recent syntheses
    const synthesisActivity = await pool.query(`
      SELECT
        id,
        generated_at,
        lookback_days
      FROM synthesis_results
      WHERE generated_at > NOW() - INTERVAL '30 days'
      ORDER BY generated_at DESC
      LIMIT 10
    `);

    await pool.end();

    const activities: ActivityItem[] = [];

    // Add fetch activities
    for (const row of fetchActivity.rows) {
      activities.push({
        id: `fetch-${row.hour}`,
        type: "fetch",
        timestamp: row.hour,
        details: `Fetched ${row.count} content items`,
        count: parseInt(row.count, 10),
      });
    }

    // Add claim extraction activities
    for (const row of claimActivity.rows) {
      activities.push({
        id: `claims-${row.hour}`,
        type: "process",
        timestamp: row.hour,
        details: `Extracted ${row.count} claims`,
        count: parseInt(row.count, 10),
      });
    }

    // Add synthesis activities
    for (const row of synthesisActivity.rows) {
      activities.push({
        id: `synthesis-${row.id}`,
        type: "synthesis",
        timestamp: row.generated_at,
        details: `Generated synthesis (${row.lookback_days} day lookback)`,
      });
    }

    // Sort by timestamp descending
    activities.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return activities.slice(0, 50);
  } catch (error) {
    console.error("Error fetching activity:", error);
    await pool.end();
    return [];
  }
}

async function getDailyStats() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
  });

  try {
    const result = await pool.query(`
      SELECT
        date_trunc('day', extracted_at)::date as day,
        COUNT(*) as claims
      FROM extracted_claims
      WHERE extracted_at > NOW() - INTERVAL '14 days'
      GROUP BY date_trunc('day', extracted_at)::date
      ORDER BY day DESC
    `);

    await pool.end();
    return result.rows;
  } catch (error) {
    await pool.end();
    return [];
  }
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffHours < 1) {
    return "Just now";
  } else if (diffHours < 24) {
    return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
  } else if (diffDays < 7) {
    return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
  } else {
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
}

export default async function ActivityPage() {
  const [activity, contentStats, dailyStats, syntheses] = await Promise.all([
    getRecentActivity(),
    getContentStats(),
    getDailyStats(),
    getSynthesisHistory(5),
  ]);

  const getActivityIcon = (type: ActivityItem["type"]) => {
    switch (type) {
      case "fetch":
        return <Database className="h-4 w-4 text-blue-500" />;
      case "process":
        return <Sparkles className="h-4 w-4 text-purple-500" />;
      case "synthesis":
        return <TrendingUp className="h-4 w-4 text-green-500" />;
    }
  };

  const getActivityBadge = (type: ActivityItem["type"]) => {
    switch (type) {
      case "fetch":
        return <Badge variant="outline" className="text-blue-600">Fetch</Badge>;
      case "process":
        return <Badge variant="outline" className="text-purple-600">Process</Badge>;
      case "synthesis":
        return <Badge variant="outline" className="text-green-600">Synthesis</Badge>;
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
        <h1 className="text-3xl font-bold mb-2">Activity Log</h1>
        <p className="text-muted-foreground">
          Recent system operations and processing activity.
        </p>
      </div>

      {/* Quick Stats */}
      <div className="grid gap-4 md:grid-cols-4 mb-8">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Content Today</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{contentStats.content_last_24h}</div>
            <p className="text-xs text-muted-foreground">items fetched</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Processing Queue</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{contentStats.unprocessed_content}</div>
            <p className="text-xs text-muted-foreground">pending items</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Processed</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{contentStats.processed_content}</div>
            <p className="text-xs text-muted-foreground">all time</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Syntheses</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{syntheses.length}</div>
            <p className="text-xs text-muted-foreground">last 30 days</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Activity Feed */}
        <Card className="md:col-span-1">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5" />
              Recent Activity
            </CardTitle>
            <CardDescription>
              Last 50 operations across all types
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3 max-h-[500px] overflow-y-auto">
              {activity.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No recent activity
                </p>
              ) : (
                activity.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-start gap-3 p-3 rounded-lg border bg-background hover:bg-muted/50 transition-colors"
                  >
                    <div className="mt-0.5">{getActivityIcon(item.type)}</div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        {getActivityBadge(item.type)}
                        <span className="text-xs text-muted-foreground">
                          {formatTimestamp(item.timestamp)}
                        </span>
                      </div>
                      <p className="text-sm">{item.details}</p>
                    </div>
                    {item.count && (
                      <Badge variant="secondary" className="shrink-0">
                        {item.count}
                      </Badge>
                    )}
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>

        {/* Daily Claims Chart */}
        <Card className="md:col-span-1">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Claims Per Day
            </CardTitle>
            <CardDescription>
              Claims extracted over the last 14 days
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {dailyStats.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No data available
                </p>
              ) : (
                dailyStats.map((day) => {
                  const count = parseInt(day.claims, 10);
                  const maxCount = Math.max(...dailyStats.map((d) => parseInt(d.claims, 10)));
                  const percentage = maxCount > 0 ? (count / maxCount) * 100 : 0;

                  return (
                    <div key={day.day} className="flex items-center gap-3">
                      <span className="text-xs text-muted-foreground w-20 shrink-0">
                        {new Date(day.day).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                        })}
                      </span>
                      <div className="flex-1 h-6 bg-muted rounded-sm overflow-hidden">
                        <div
                          className="h-full bg-primary/60 rounded-sm transition-all"
                          style={{ width: `${percentage}%` }}
                        />
                      </div>
                      <span className="text-sm font-medium w-10 text-right">{count}</span>
                    </div>
                  );
                })
              )}
            </div>
          </CardContent>
        </Card>

        {/* Recent Syntheses */}
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5" />
              Recent Syntheses
            </CardTitle>
            <CardDescription>
              Generated digest summaries
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {syntheses.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No syntheses generated yet
                </p>
              ) : (
                syntheses.map((synthesis) => (
                  <div
                    key={synthesis.id}
                    className="flex items-center justify-between p-4 rounded-lg border bg-background"
                  >
                    <div className="flex items-center gap-3">
                      <CheckCircle className="h-5 w-5 text-green-500" />
                      <div>
                        <p className="font-medium">
                          Weekly Digest
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {synthesis.lookback_days} day lookback period
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="text-right">
                        <p className="text-sm font-medium">
                          {new Date(synthesis.generated_at).toLocaleDateString("en-US", {
                            weekday: "short",
                            month: "short",
                            day: "numeric",
                          })}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(synthesis.generated_at).toLocaleTimeString("en-US", {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </p>
                      </div>
                      <Link
                        href="/digest"
                        className="text-sm text-primary hover:underline"
                      >
                        View →
                      </Link>
                    </div>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
