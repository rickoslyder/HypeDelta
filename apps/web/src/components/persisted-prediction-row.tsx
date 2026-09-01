import Link from "next/link";
import { ArrowUpRight, User } from "lucide-react";

import { claimDetailHref, researcherHref } from "@/lib/claim-href";
import type { PersistedPredictionItem } from "@/lib/persisted-predictions";

function formatMadeAt(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(parsed));
}

export function PersistedPredictionRow({ item }: { item: PersistedPredictionItem }) {
  const headline = item.predictionText || item.claimText || item.id;
  const madeAt = formatMadeAt(item.madeAt);

  return (
    <article className="border-b py-9 first:pt-8">
      <div className="flex flex-wrap items-center gap-3">
        {item.claimType && (
          <span className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            {item.claimType}
            {item.topic ? ` · ${item.topic}` : ""}
          </span>
        )}
        {item.status && (
          <span className="ml-auto rounded-full border px-2.5 py-1 text-xs font-medium capitalize">
            {item.status.replace(/-/g, " ")}
          </span>
        )}
      </div>

      <h3 className="mt-5 max-w-4xl text-xl font-semibold leading-8 tracking-tight sm:text-2xl">
        {item.claimId ? (
          <Link href={claimDetailHref(item.claimId)} className="hover:underline">
            {headline}
          </Link>
        ) : (
          headline
        )}
      </h3>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        {item.researcherSlug ? (
          <Link
            href={researcherHref(item.researcherSlug)}
            className="inline-flex items-center gap-1 hover:underline"
          >
            <User className="h-3 w-3" aria-hidden="true" />
            {item.researcherDisplayName || item.sourceLabel}
          </Link>
        ) : (
          <span className="inline-flex items-center gap-1">
            <User className="h-3 w-3" aria-hidden="true" />
            {item.sourceLabel}
          </span>
        )}
        {madeAt && <span>Made {madeAt}</span>}
      </div>

      <dl className="mt-6 grid gap-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Timeframe
          </dt>
          <dd className="mt-1">{item.timeframe ?? "Not recorded"}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Target date
          </dt>
          <dd className="mt-1">{item.targetDateLabel}</dd>
        </div>
        {item.outcome && (
          <div>
            <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Outcome
            </dt>
            <dd className="mt-1">{item.outcome}</dd>
          </div>
        )}
        {item.nextObservable && (
          <div>
            <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Next observable
            </dt>
            <dd className="mt-1">{item.nextObservable}</dd>
          </div>
        )}
      </dl>

      <div className="mt-6 min-w-0">
        <p className="mb-1 text-xs text-muted-foreground">Canonical source</p>
        {item.canonicalSourceUrl ? (
          <a
            href={item.canonicalSourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="group inline-flex items-start gap-2 text-sm font-medium text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground"
          >
            <span>
              {item.canonicalSourceUrl}
              <span className="sr-only"> (opens in a new tab)</span>
            </span>
            <ArrowUpRight
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            />
          </a>
        ) : (
          <p className="text-sm text-muted-foreground">Source unavailable</p>
        )}
      </div>
    </article>
  );
}
