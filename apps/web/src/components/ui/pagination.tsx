import Link from "next/link";
import { ChevronLeft, ChevronRight, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface PaginationProps {
  currentPage: number;
  totalPages: number;
  baseUrl: string;
  searchParams?: Record<string, string | undefined>;
}

export function Pagination({
  currentPage,
  totalPages,
  baseUrl,
  searchParams = {},
}: PaginationProps) {
  if (totalPages <= 1) return null;

  const buildUrl = (page: number) => {
    const params = new URLSearchParams();
    Object.entries(searchParams).forEach(([key, value]) => {
      if (value !== undefined && key !== "page") {
        params.set(key, value);
      }
    });
    params.set("page", page.toString());
    return `${baseUrl}?${params.toString()}`;
  };

  // Generate page numbers to show
  const getPageNumbers = () => {
    const pages: (number | "ellipsis")[] = [];
    const showEllipsisThreshold = 7;

    if (totalPages <= showEllipsisThreshold) {
      // Show all pages if total is small
      for (let i = 1; i <= totalPages; i++) {
        pages.push(i);
      }
    } else {
      // Always show first page
      pages.push(1);

      if (currentPage > 3) {
        pages.push("ellipsis");
      }

      // Show pages around current
      const start = Math.max(2, currentPage - 1);
      const end = Math.min(totalPages - 1, currentPage + 1);

      for (let i = start; i <= end; i++) {
        pages.push(i);
      }

      if (currentPage < totalPages - 2) {
        pages.push("ellipsis");
      }

      // Always show last page
      pages.push(totalPages);
    }

    return pages;
  };

  const pageNumbers = getPageNumbers();

  return (
    <nav
      role="navigation"
      aria-label="Pagination"
      className="flex items-center justify-center gap-1"
    >
      {/* Previous button */}
      <Button
        variant="outline"
        size="sm"
        asChild={currentPage > 1}
        disabled={currentPage <= 1}
        className="gap-1"
      >
        {currentPage > 1 ? (
          <Link href={buildUrl(currentPage - 1)}>
            <ChevronLeft className="h-4 w-4" />
            <span className="sr-only sm:not-sr-only">Previous</span>
          </Link>
        ) : (
          <>
            <ChevronLeft className="h-4 w-4" />
            <span className="sr-only sm:not-sr-only">Previous</span>
          </>
        )}
      </Button>

      {/* Page numbers */}
      <div className="hidden sm:flex items-center gap-1">
        {pageNumbers.map((page, i) =>
          page === "ellipsis" ? (
            <span
              key={`ellipsis-${i}`}
              className="flex h-9 w-9 items-center justify-center"
            >
              <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
            </span>
          ) : (
            <Button
              key={page}
              variant={currentPage === page ? "default" : "outline"}
              size="sm"
              asChild={currentPage !== page}
              className={cn(
                "h-9 w-9 p-0",
                currentPage === page && "pointer-events-none"
              )}
            >
              {currentPage !== page ? (
                <Link href={buildUrl(page)}>{page}</Link>
              ) : (
                <span>{page}</span>
              )}
            </Button>
          )
        )}
      </div>

      {/* Mobile page indicator */}
      <span className="sm:hidden text-sm text-muted-foreground px-2">
        Page {currentPage} of {totalPages}
      </span>

      {/* Next button */}
      <Button
        variant="outline"
        size="sm"
        asChild={currentPage < totalPages}
        disabled={currentPage >= totalPages}
        className="gap-1"
      >
        {currentPage < totalPages ? (
          <Link href={buildUrl(currentPage + 1)}>
            <span className="sr-only sm:not-sr-only">Next</span>
            <ChevronRight className="h-4 w-4" />
          </Link>
        ) : (
          <>
            <span className="sr-only sm:not-sr-only">Next</span>
            <ChevronRight className="h-4 w-4" />
          </>
        )}
      </Button>
    </nav>
  );
}
