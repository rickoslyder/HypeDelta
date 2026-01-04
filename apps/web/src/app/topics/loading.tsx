import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function TopicsLoading() {
  return (
    <div className="container max-w-screen-2xl py-8 px-4 md:px-6">
      <div className="mb-8">
        <Skeleton className="h-9 w-32 mb-2" />
        <Skeleton className="h-5 w-80" />
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {[...Array(6)].map((_, i) => (
          <Card key={i} className="h-full">
            <CardHeader>
              <div className="flex items-center justify-between">
                <Skeleton className="h-6 w-24" />
                <Skeleton className="h-5 w-20" />
              </div>
              <Skeleton className="h-4 w-36 mt-1" />
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-4 w-8" />
                </div>
                <div className="flex items-center justify-between">
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-4 w-8" />
                </div>
                <div className="space-y-1">
                  <div className="flex justify-between">
                    <Skeleton className="h-3 w-24" />
                    <Skeleton className="h-3 w-12" />
                  </div>
                  <Skeleton className="h-2 w-full" />
                </div>
                <div className="space-y-1">
                  <div className="flex justify-between">
                    <Skeleton className="h-3 w-16" />
                    <Skeleton className="h-3 w-12" />
                  </div>
                  <Skeleton className="h-2 w-full" />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
