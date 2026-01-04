import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function ResearchersLoading() {
  return (
    <div className="container max-w-screen-2xl py-8 px-4 md:px-6">
      <div className="mb-8">
        <Skeleton className="h-9 w-40 mb-2" />
        <Skeleton className="h-5 w-72" />
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {[...Array(9)].map((_, i) => (
          <Card key={i} className="h-full">
            <CardHeader>
              <div className="flex items-center gap-3">
                <Skeleton className="h-10 w-10 rounded-full" />
                <div>
                  <Skeleton className="h-5 w-24 mb-1" />
                  <Skeleton className="h-4 w-20" />
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <Skeleton className="h-4 w-16" />
                  <Skeleton className="h-4 w-8" />
                </div>
                <div className="flex items-center justify-between text-sm">
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-4 w-8" />
                </div>
                <Skeleton className="h-2 w-full" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
