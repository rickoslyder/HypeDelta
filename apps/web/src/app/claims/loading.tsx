import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function ClaimsLoading() {
  return (
    <div className="container max-w-screen-2xl py-8 px-4 md:px-6">
      <div className="mb-8">
        <Skeleton className="h-9 w-48 mb-2" />
        <Skeleton className="h-5 w-96" />
      </div>

      {/* Filters skeleton */}
      <Card className="mb-6">
        <CardHeader>
          <Skeleton className="h-5 w-24" />
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-4">
            <div className="space-y-2">
              <Skeleton className="h-4 w-12" />
              <div className="flex gap-1">
                {[...Array(6)].map((_, i) => (
                  <Skeleton key={i} className="h-6 w-16" />
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Skeleton className="h-4 w-12" />
              <div className="flex gap-1">
                {[...Array(4)].map((_, i) => (
                  <Skeleton key={i} className="h-6 w-16" />
                ))}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Results count skeleton */}
      <Skeleton className="h-4 w-32 mb-4" />

      {/* Claims list skeleton */}
      <div className="space-y-4">
        {[...Array(5)].map((_, i) => (
          <Card key={i}>
            <CardContent className="pt-6">
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Skeleton className="h-5 w-20" />
                  <Skeleton className="h-5 w-16" />
                  <Skeleton className="h-5 w-14" />
                </div>
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
                <div className="flex gap-4">
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-3 w-20" />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
