import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getSources } from "@/lib/db";
import { ArrowLeft, Users, Building2, CheckCircle, ExternalLink, RefreshCw } from "lucide-react";
import { SourceToggle } from "@/components/source-toggle";

export const dynamic = "force-dynamic";

export default async function SourcesPage() {
  const sources = await getSources();

  // Group by category
  const byCategory = sources.reduce((acc, source) => {
    const cat = source.category || "other";
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(source);
    return acc;
  }, {} as Record<string, typeof sources>);

  const categoryOrder = ["lab-researcher", "critic", "independent", "other"];
  const sortedCategories = Object.entries(byCategory).sort(
    ([a], [b]) => categoryOrder.indexOf(a) - categoryOrder.indexOf(b)
  );

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
        <h1 className="text-3xl font-bold mb-2">Sources</h1>
        <p className="text-muted-foreground">
          Manage researcher sources being tracked by the system.
        </p>
      </div>

      {/* Summary stats */}
      <div className="grid gap-4 md:grid-cols-4 mb-8">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Sources</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{sources.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-green-500" />
              Active
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{sources.filter((s) => s.is_active).length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Building2 className="h-4 w-4 text-blue-500" />
              Lab Researchers
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{byCategory["lab-researcher"]?.length || 0}</div>
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
            <div className="text-2xl font-bold">{byCategory.critic?.length || 0}</div>
          </CardContent>
        </Card>
      </div>

      {/* Sources by category */}
      <div className="space-y-8">
        {sortedCategories.map(([category, categorySources]) => (
          <Card key={category}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 capitalize">
                {category === "lab-researcher" && <Building2 className="h-5 w-5 text-blue-500" />}
                {category === "critic" && <Users className="h-5 w-5 text-orange-500" />}
                {category === "independent" && <Users className="h-5 w-5 text-green-500" />}
                {category.replace("_", " ")}
              </CardTitle>
              <CardDescription>
                {categorySources.length} sources
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {categorySources.map((source) => (
                  <div
                    key={source.id}
                    className={`p-4 rounded-lg border ${
                      source.is_active ? "bg-background" : "bg-muted/50 opacity-60"
                    }`}
                  >
                    <div className="flex items-start justify-between mb-2">
                      <div>
                        <p className="font-medium">@{source.identifier}</p>
                        {source.author_name && (
                          <p className="text-sm text-muted-foreground">{source.author_name}</p>
                        )}
                      </div>
                      <SourceToggle
                        sourceId={source.id}
                        isActive={source.is_active}
                        identifier={source.identifier}
                      />
                    </div>

                    <div className="flex flex-wrap gap-1 mb-3">
                      <Badge variant="outline" className="text-xs capitalize">
                        {source.type}
                      </Badge>
                      {source.fetch_frequency_hours && (
                        <Badge variant="outline" className="text-xs">
                          Every {source.fetch_frequency_hours}h
                        </Badge>
                      )}
                    </div>

                    {source.tags && source.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mb-3">
                        {source.tags.map((tag) => (
                          <Badge key={tag} variant="secondary" className="text-xs">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    )}

                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      {source.type === "twitter" && (
                        <a
                          href={`https://twitter.com/${source.identifier}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 hover:underline"
                        >
                          <ExternalLink className="h-3 w-3" />
                          Twitter
                        </a>
                      )}
                    </div>

                    {source.last_fetched && (
                      <p className="text-xs text-muted-foreground mt-2">
                        Last fetched: {new Date(source.last_fetched).toLocaleDateString()}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Info about source management */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RefreshCw className="h-5 w-5 text-blue-500" />
            Source Management
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          <p className="mb-3">
            Toggle the switch next to each source to activate or deactivate it.
            Inactive sources will not be fetched during operations.
          </p>
          <p>
            To add new sources, use the CLI:
          </p>
          <pre className="mt-2 p-3 bg-muted rounded-md text-xs">
            npm run add-source -- --identifier="username" --type="twitter" --category="lab-researcher"
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}
