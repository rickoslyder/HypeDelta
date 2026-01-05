import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getSystemStatus } from "@/lib/db";
import {
  ArrowLeft,
  Database,
  Server,
  Clock,
  Shield,
  CheckCircle,
  XCircle,
  Info,
} from "lucide-react";

export const dynamic = "force-dynamic";

interface ConfigItem {
  label: string;
  value: string | number | boolean;
  description?: string;
  status?: "ok" | "warning" | "error";
}

async function getDatabaseInfo() {
  // Get database version and connection info
  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 5000,
  });

  try {
    const result = await pool.query(`
      SELECT
        version() as pg_version,
        current_database() as db_name,
        pg_size_pretty(pg_database_size(current_database())) as db_size,
        (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()) as connections
    `);
    await pool.end();
    return result.rows[0];
  } catch (error) {
    await pool.end();
    return null;
  }
}

export default async function SettingsPage() {
  const [status, dbInfo] = await Promise.all([
    getSystemStatus(),
    getDatabaseInfo(),
  ]);

  // Environment configuration (non-sensitive)
  const envConfig: ConfigItem[] = [
    {
      label: "Node Environment",
      value: process.env.NODE_ENV || "development",
      description: "Current runtime environment",
      status: process.env.NODE_ENV === "production" ? "ok" : "warning",
    },
    {
      label: "Database Connection",
      value: dbInfo ? "Connected" : "Error",
      description: dbInfo ? `${dbInfo.db_name} (${dbInfo.db_size})` : "Unable to connect",
      status: dbInfo ? "ok" : "error",
    },
    {
      label: "Database Connections",
      value: dbInfo?.connections || 0,
      description: "Active connections to database",
    },
    {
      label: "Admin Auth",
      value: process.env.ADMIN_PASSWORD ? "Configured" : "Not Set",
      description: "Admin authentication status",
      status: process.env.ADMIN_PASSWORD ? "ok" : "error",
    },
    {
      label: "Claude API",
      value: process.env.CLAUDE_CODE_OAUTH_TOKEN ? "Configured" : "Not Set",
      description: "Claude API token for claim extraction",
      status: process.env.CLAUDE_CODE_OAUTH_TOKEN ? "ok" : "warning",
    },
  ];

  // System configuration
  const systemConfig: ConfigItem[] = [
    {
      label: "Token TTL",
      value: "7 days",
      description: "Auth token expiration time",
    },
    {
      label: "Default Lookback",
      value: "14 days",
      description: "Default time range for claim queries",
    },
    {
      label: "Max Query Limit",
      value: 500,
      description: "Maximum results per query",
    },
    {
      label: "DB Pool Size",
      value: 20,
      description: "Maximum database connections in pool",
    },
  ];

  // Processing configuration
  const processingConfig: ConfigItem[] = [
    {
      label: "Synthesis Interval",
      value: "Weekly",
      description: "How often synthesis is generated",
    },
    {
      label: "Content Retention",
      value: "365 days",
      description: "How long content is retained",
    },
    {
      label: "Fetch Frequency",
      value: "Varies by source",
      description: "Individual sources have custom intervals",
    },
  ];

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
        <h1 className="text-3xl font-bold mb-2">Settings</h1>
        <p className="text-muted-foreground">
          System configuration and environment status.
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Environment Status */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Server className="h-5 w-5" />
              Environment
            </CardTitle>
            <CardDescription>
              Runtime environment and connection status
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {envConfig.map((item) => (
                <div key={item.label} className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{item.label}</span>
                      {item.status === "ok" && (
                        <CheckCircle className="h-3.5 w-3.5 text-green-500" />
                      )}
                      {item.status === "warning" && (
                        <Info className="h-3.5 w-3.5 text-yellow-500" />
                      )}
                      {item.status === "error" && (
                        <XCircle className="h-3.5 w-3.5 text-red-500" />
                      )}
                    </div>
                    {item.description && (
                      <p className="text-xs text-muted-foreground">{item.description}</p>
                    )}
                  </div>
                  <Badge variant={item.status === "error" ? "destructive" : "secondary"}>
                    {String(item.value)}
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Database Info */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Database className="h-5 w-5" />
              Database
            </CardTitle>
            <CardDescription>
              PostgreSQL database information
            </CardDescription>
          </CardHeader>
          <CardContent>
            {dbInfo ? (
              <div className="space-y-4">
                <div className="p-3 bg-muted rounded-md">
                  <p className="text-xs font-mono text-muted-foreground break-all">
                    {dbInfo.pg_version?.split(",")[0] || "PostgreSQL"}
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-sm text-muted-foreground">Database</p>
                    <p className="font-medium">{dbInfo.db_name}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Size</p>
                    <p className="font-medium">{dbInfo.db_size}</p>
                  </div>
                </div>
                <div className="border-t pt-4">
                  <p className="text-sm font-medium mb-2">Table Statistics</p>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Sources</span>
                      <span>{status.sources.total}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Content</span>
                      <span>{status.content.total_content}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Claims</span>
                      <span>{status.claims.total}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Syntheses</span>
                      <span>{status.synthesis.count}</span>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-destructive">
                <XCircle className="h-4 w-4" />
                <span>Unable to connect to database</span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* System Configuration */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5" />
              System Configuration
            </CardTitle>
            <CardDescription>
              Default system settings
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {systemConfig.map((item) => (
                <div key={item.label} className="flex items-start justify-between">
                  <div>
                    <span className="text-sm font-medium">{item.label}</span>
                    {item.description && (
                      <p className="text-xs text-muted-foreground">{item.description}</p>
                    )}
                  </div>
                  <Badge variant="outline">{String(item.value)}</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Processing Configuration */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5" />
              Processing
            </CardTitle>
            <CardDescription>
              Content processing settings
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {processingConfig.map((item) => (
                <div key={item.label} className="flex items-start justify-between">
                  <div>
                    <span className="text-sm font-medium">{item.label}</span>
                    {item.description && (
                      <p className="text-xs text-muted-foreground">{item.description}</p>
                    )}
                  </div>
                  <Badge variant="outline">{String(item.value)}</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Information */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Info className="h-5 w-5 text-blue-500" />
            Configuration Notes
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p>
            Settings are configured via environment variables. To modify:
          </p>
          <ul className="list-disc list-inside space-y-1 ml-2">
            <li>Update environment variables in your deployment configuration</li>
            <li>Restart the application for changes to take effect</li>
            <li>Database connection pool settings require a restart</li>
          </ul>
          <p className="mt-4">
            For local development, create a <code className="px-1 py-0.5 bg-muted rounded">.env.local</code> file
            with the required variables.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
