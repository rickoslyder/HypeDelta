import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getClaims, getClaimFacets } from "@/lib/db";
import { FreshnessBanner } from "@/components/freshness-banner";
import { Pagination } from "@/components/ui/pagination";
import { SearchInput } from "@/components/search-input";
import { claimDetailHref, claimsFilterHref, researcherHref } from "@/lib/claim-href";
import { authorRoleToSide } from "@hypedelta/author-side";
import { MessageSquare, Calendar, User, ExternalLink, X } from "lucide-react";
import Link from "next/link";

export const dynamic = "force-dynamic";

// Format relative time (e.g., "2 days ago", "3 hours ago")
function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 30) {
    return date.toLocaleDateString();
  } else if (diffDays > 0) {
    return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
  } else if (diffHours > 0) {
    return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
  } else if (diffMins > 0) {
    return `${diffMins} minute${diffMins === 1 ? "" : "s"} ago`;
  } else {
    return "Just now";
  }
}

const ITEMS_PER_PAGE = 20;

interface ClaimsPageProps {
  searchParams: Promise<{
    topic?: string;
    author?: string;
    type?: string;
    days?: string;
    page?: string;
    q?: string;
  }>;
}

export default async function ClaimsPage({ searchParams }: ClaimsPageProps) {
  const params = await searchParams;
  const days = parseInt(params.days || "30");
  const currentPage = Math.max(1, parseInt(params.page || "1"));
  const offset = (currentPage - 1) * ITEMS_PER_PAGE;

  const { claims, total } = await getClaims({
    topic: params.topic,
    author: params.author,
    claimType: params.type,
    search: params.q,
    days,
    limit: ITEMS_PER_PAGE,
    offset,
  });
  const facets = await getClaimFacets({
    search: params.q,
    days,
    author: params.author,
  });
  const filterState = {
    q: params.q,
    topic: params.topic,
    type: params.type,
    days: params.days,
    author: params.author,
  };

  const totalPages = Math.ceil(total / ITEMS_PER_PAGE);

  const uniqueTopics = facets.topics;
  const uniqueTypes = facets.types;

  return (
    <div>
      <FreshnessBanner />
    <div className="w-full px-4 md:px-8 lg:px-12 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Claims Browser</h1>
        <p className="text-muted-foreground">
          Search and filter through extracted claims from AI researchers.
        </p>
      </div>

      {/* Search and Filters */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-lg">Search & Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-4">
            {/* Text search */}
            <div className="w-full sm:w-80">
              <SearchInput
                placeholder="Search claims..."
                paramName="q"
              />
            </div>

            {/* Topic filter */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Topic</label>
              <div className="flex flex-wrap gap-1">
                <Link href={claimsFilterHref(filterState, { topic: null })}>
                  <Badge
                    variant={!params.topic ? "default" : "outline"}
                    className="cursor-pointer"
                  >
                    All
                  </Badge>
                </Link>
                {uniqueTopics.slice(0, 8).map((topic) => (
                  <Link key={topic} href={claimsFilterHref(filterState, { topic, page: null })}>
                    <Badge
                      variant={params.topic === topic ? "default" : "outline"}
                      className="cursor-pointer capitalize"
                    >
                      {topic}
                    </Badge>
                  </Link>
                ))}
              </div>
            </div>

            {/* Type filter */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Type</label>
              <div className="flex flex-wrap gap-1">
                <Link href={claimsFilterHref(filterState, { type: null })}>
                  <Badge
                    variant={!params.type ? "default" : "outline"}
                    className="cursor-pointer"
                  >
                    All
                  </Badge>
                </Link>
                {uniqueTypes.map((type) => (
                  <Link
                    key={type}
                    href={claimsFilterHref(filterState, { type, page: null })}
                  >
                    <Badge
                      variant={params.type === type ? "default" : "outline"}
                      className="cursor-pointer capitalize"
                    >
                      {type}
                    </Badge>
                  </Link>
                ))}
              </div>
            </div>

            {/* Days filter */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Time Range</label>
              <div className="flex gap-1">
                {[7, 14, 30, 90].map((d) => (
                  <Link
                    key={d}
                    href={claimsFilterHref(filterState, { days: String(d), page: null })}
                  >
                    <Badge
                      variant={days === d ? "default" : "outline"}
                      className="cursor-pointer"
                    >
                      {d}d
                    </Badge>
                  </Link>
                ))}
              </div>
            </div>

            {/* Reset Filters */}
            {(params.topic || params.type || params.days || params.q) && (
              <div className="flex items-end">
                <Link href="/claims">
                  <Button variant="ghost" size="sm" className="text-muted-foreground">
                    <X className="h-4 w-4 mr-1" />
                    Reset All
                  </Button>
                </Link>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Results count */}
      <p className="text-sm text-muted-foreground mb-4">
        Showing {offset + 1}-{Math.min(offset + claims.length, total)} of {total} claims
        {params.q && ` matching "${params.q}"`}
        {params.topic && ` in topic "${params.topic}"`}
        {params.type && ` of type "${params.type}"`}
      </p>

      {/* Claims list */}
      <div className="space-y-4">
        {claims.map((claim) => (
          <Card key={claim.id}>
            <CardContent className="pt-6">
              <div className="flex flex-col gap-3">
                {/* Header with badges */}
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="capitalize">
                    {claim.topic}
                  </Badge>
                  <Badge
                    variant={
                      claim.claim_type === "prediction"
                        ? "default"
                        : claim.claim_type === "opinion"
                        ? "secondary"
                        : "outline"
                    }
                    className="capitalize"
                  >
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
                    >
                      {claim.bullishness > 0.6
                        ? "Bullish"
                        : claim.bullishness < 0.4
                        ? "Bearish"
                        : "Neutral"}
                    </Badge>
                  )}
                  {claim.author_category && (
                    <Badge
                      variant="outline"
                      className={
                        authorRoleToSide(claim.author_category) === "lab"
                          ? "border-blue-500 text-blue-600"
                          : authorRoleToSide(claim.author_category) === "critic"
                          ? "border-orange-500 text-orange-600"
                          : "border-gray-400 text-gray-600"
                      }
                    >
                      {claim.author_category.replace("-", " ")}
                    </Badge>
                  )}
                </div>

                {/* Claim content */}
                <p className="text-sm leading-relaxed">
                  <Link href={claimDetailHref(claim.id)} className="hover:underline">
                    {claim.claim_text}
                  </Link>
                </p>

                {/* Supporting quote if available */}
                {claim.supporting_quote && (
                  <blockquote className="border-l-2 border-muted pl-3 text-sm text-muted-foreground italic">
                    "{claim.supporting_quote}"
                  </blockquote>
                )}

                {/* Metadata */}
                <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                  {claim.researcher_slug || (claim.author_handle && claim.author_handle !== "null") ? (
                    <div className="flex items-center gap-1">
                      <User className="h-3 w-3" />
                      <Link
                        href={researcherHref(claim.researcher_slug || claim.author_handle || "")}
                        className="hover:underline"
                      >
                        {claim.researcher_display_name || claim.author_handle}
                      </Link>
                    </div>
                  ) : claim.author_category ? (
                    <div className="flex items-center gap-1">
                      <User className="h-3 w-3" />
                      <span className="capitalize">{claim.author_category.replace("-", " ")}</span>
                    </div>
                  ) : null}
                  <div className="flex items-center gap-1">
                    <Calendar className="h-3 w-3" />
                    <span>{formatRelativeTime(new Date(claim.extracted_at))}</span>
                  </div>
                  {claim.confidence && (
                    <span>Confidence: {Math.round(claim.confidence * 100)}%</span>
                  )}
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
            </CardContent>
          </Card>
        ))}
      </div>

      {claims.length === 0 && (
        <div className="flex flex-col items-center justify-center min-h-[300px] text-center">
          <MessageSquare className="h-12 w-12 text-muted-foreground mb-4" />
          <h2 className="text-xl font-semibold mb-2">No Claims Found</h2>
          <p className="text-muted-foreground">
            {params.q || params.topic || params.type
              ? "Try adjusting your search or filters."
              : "Process some content to see claims appear here."}
          </p>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-8">
          <Pagination
            currentPage={currentPage}
            totalPages={totalPages}
            baseUrl="/claims"
            searchParams={{
              q: params.q,
              topic: params.topic,
              type: params.type,
              days: params.days,
            }}
          />
        </div>
      )}
    </div>
    </div>
  );
}
