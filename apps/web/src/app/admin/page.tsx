import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getSystemStatus, getSources, getContentStats } from "@/lib/db";
import {
  Activity,
  Database,
  FileText,
  Users,
  Settings,
  Play,
  RefreshCw,
  CheckCircle,
  AlertCircle,
  Clock,
} from "lucide-react";

export const dynamic = "force-dynamic";

export default async function AdminDashboardPage() {
  const [status, sources, contentStats] = await Promise.all([
    getSystemStatus(),
    getSources(),
    getContentStats(),
  ]);

  const activeSources = sources.filter((s) => s.is_active);
  const inactiveSources = sources.filter((s) => !s.is_active);

  return (
    <div className="container max-w-screen-2xl py-8 px-4 md:px-6">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Admin Dashboard</h1>
        <p className="text-muted-foreground">
          System overview and quick actions for HypeDelta.
        </p>
      </div>

      {/* Quick Actions */}
      <div className="grid gap-4 md:grid-cols-3 mb-8">
        <Link href="/admin/operations">
          <Card className="hover:bg-accent transition-colors cursor-pointer h-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Play className="h-5 w-5" />
                Operations
              </CardTitle>
              <CardDescription>
                Trigger fetch, process, and synthesis operations.
              </CardDescription>
            </CardHeader>
          </Card>
        </Link>
        <Link href="/admin/sources">
          <Card className="hover:bg-accent transition-colors cursor-pointer h-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="h-5 w-5" />
                Sources
              </CardTitle>
              <CardDescription>
                Manage researcher sources and feeds.
              </CardDescription>
            </CardHeader>
          </Card>
        </Link>
        <Card className="opacity-60">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings className="h-5 w-5" />
              Settings
            </CardTitle>
            <CardDescription>
              System configuration (coming soon).
            </CardDescription>
          </CardHeader>
        </Card>
      </div>

      {/* System Health */}
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

      <div className="grid gap-6 md:grid-cols-2">
        {/* Content Pipeline Status */}
        <Card>
          <CardHeader>
            <CardTitle>Content Pipeline</CardTitle>
            <CardDescription>Current processing status</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <CheckCircle className="h-4 w-4 text-green-500" />
                  <span className="text-sm">Processed</span>
                </div>
                <Badge variant="secondary">{contentStats.processed_content}</Badge>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Clock className="h-4 w-4 text-yellow-500" />
                  <span className="text-sm">Pending</span>
                </div>
                <Badge variant="secondary">{contentStats.unprocessed_content}</Badge>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Database className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm">Total Content</span>
                </div>
                <Badge variant="secondary">{contentStats.total_content}</Badge>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <RefreshCw className="h-4 w-4 text-blue-500" />
                  <span className="text-sm">Last 24h</span>
                </div>
                <Badge variant="secondary">{contentStats.content_last_24h}</Badge>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Sources Overview */}
        <Card>
          <CardHeader>
            <CardTitle>Sources Overview</CardTitle>
            <CardDescription>Active researchers being tracked</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm">Active Sources</span>
                <Badge variant="default">{activeSources.length}</Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm">Inactive Sources</span>
                <Badge variant="secondary">{inactiveSources.length}</Badge>
              </div>
              <div className="border-t pt-4">
                <p className="text-sm font-medium mb-2">By Category:</p>
                <div className="space-y-2">
                  {Object.entries(
                    sources.reduce((acc, s) => {
                      const cat = s.category || "other";
                      acc[cat] = (acc[cat] || 0) + 1;
                      return acc;
                    }, {} as Record<string, number>)
                  ).map(([category, count]) => (
                    <div key={category} className="flex items-center justify-between text-sm">
                      <span className="capitalize text-muted-foreground">{category.replace("_", " ")}</span>
                      <span>{count}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Recent Activity */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Recent Synthesis</CardTitle>
          <CardDescription>Last generated digest</CardDescription>
        </CardHeader>
        <CardContent>
          {status.synthesis.latest ? (
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">Weekly Digest</p>
                <p className="text-sm text-muted-foreground">
                  Generated on {new Date(status.synthesis.latest).toLocaleDateString("en-US", {
                    weekday: "long",
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                  })}
                </p>
              </div>
              <Link
                href="/digest"
                className="text-sm text-primary hover:underline"
              >
                View Digest →
              </Link>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No synthesis has been run yet. Go to Operations to trigger one.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
