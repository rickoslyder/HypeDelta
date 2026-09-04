import type { Metadata } from "next";
import Link from "next/link";
import { Activity, Target } from "lucide-react";

import { Pagination } from "@/components/ui/pagination";
import { PersistedPredictionRow } from "@/components/persisted-prediction-row";
import { getPersistedPredictions } from "@/lib/db";
import { predictionsHref } from "@/lib/persisted-predictions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Predictions | HypeDelta",
  description:
    "Persisted researcher predictions with durable status, timeframe, and source provenance.",
};

const STATUS_FILTERS = [
  { value: "", label: "All statuses" },
  { value: "pending", label: "Pending" },
  { value: "too-early", label: "Too early" },
  { value: "verified", label: "Verified" },
  { value: "falsified", label: "Falsified" },
  { value: "partially-verified", label: "Partially verified" },
] as const;

interface PredictionsPageProps {
  searchParams: Promise<{
    status?: string;
    topic?: string;
    page?: string;
    pageSize?: string;
  }>;
}

function coverageLabel(part: number, total: number, empty: string): string {
  if (total <= 0) return empty;
  return `${part}/${total}`;
}

export default async function PredictionsPage({ searchParams }: PredictionsPageProps) {
  const params = await searchParams;
  const result = await getPersistedPredictions({
    status: params.status,
    topic: params.topic,
    page: params.page,
    pageSize: params.pageSize,
  });
  const { items, total, page, pageSize, topicOptions, summary } = result;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const selectedStatus = params.status?.trim() || "";
  const selectedTopic = params.topic?.trim() || "";

  return (
    <div className="mx-auto w-full max-w-7xl px-5 py-10 sm:px-8 sm:py-14 lg:px-12">
      <header className="max-w-4xl">
        <div className="mb-5 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          <Target aria-hidden="true" className="size-4" />
          Persisted predictions
        </div>
        <h1 className="max-w-3xl text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
          Tracked predictions, as recorded.
        </h1>
        <p className="mt-5 max-w-2xl text-pretty text-base leading-7 text-muted-foreground sm:text-lg">
          Every row is a durable prediction. Target dates, outcomes, and next
          observables are shown only when stored. Null due dates display{" "}
          <span className="font-medium text-foreground">
            Target date not normalized
          </span>
          {" "}instead of an inferred calendar date.
        </p>
      </header>

      <section
        aria-label="Prediction summary"
        className="mt-10 grid border-y sm:grid-cols-2 lg:grid-cols-5"
      >
        <div className="border-b py-6 sm:border-r lg:border-b-0 lg:pr-6">
          <p className="text-3xl font-semibold tabular-nums">{summary.tracked}</p>
          <p className="mt-1 text-sm text-muted-foreground">Tracked</p>
          <p className="mt-3 text-xs text-muted-foreground">
            {summary.tracked === 0 ? "No predictions recorded" : "All persisted rows"}
          </p>
        </div>
        <div className="border-b py-6 sm:pl-6 lg:border-b-0 lg:border-r lg:px-6">
          <p className="text-3xl font-semibold tabular-nums">{summary.open}</p>
          <p className="mt-1 text-sm text-muted-foreground">Open</p>
          <p className="mt-3 text-xs text-muted-foreground">Pending or too early</p>
        </div>
        <div className="border-b py-6 sm:border-r sm:pr-6 lg:border-b-0 lg:px-6">
          <p className="text-3xl font-semibold tabular-nums">{summary.resolved}</p>
          <p className="mt-1 text-sm text-muted-foreground">Resolved</p>
          <p className="mt-3 text-xs text-muted-foreground">
            Verified, falsified, or partial
          </p>
        </div>
        <div className="border-b py-6 sm:border-b-0 sm:pl-6 lg:border-r lg:px-6">
          <p className="text-3xl font-semibold tabular-nums">
            {coverageLabel(summary.withTargetDate, summary.tracked, "0/0")}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">Target-date coverage</p>
          <p className="mt-3 text-xs text-muted-foreground">
            {summary.tracked === 0
              ? "No denominator"
              : `${summary.withTargetDate} have a stored due date`}
          </p>
        </div>
        <div className="py-6 lg:pl-6">
          <p className="text-3xl font-semibold tabular-nums">
            {coverageLabel(summary.withSourceAndQuote, summary.tracked, "0/0")}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">Source + quote evidence</p>
          <p className="mt-3 text-xs text-muted-foreground">
            {summary.tracked === 0
              ? "No denominator"
              : `${summary.withSourceAndQuote} have both`}
          </p>
        </div>
      </section>

      <section aria-label="Filters" className="mt-10 space-y-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Status
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {STATUS_FILTERS.map((filter) => {
              const href = predictionsHref({
                status: filter.value || null,
                topic: selectedTopic || null,
              });
              const active = selectedStatus === filter.value;
              return (
                <Link
                  key={filter.label}
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
                    active
                      ? "border-foreground bg-foreground text-background"
                      : "text-foreground/70 hover:text-foreground"
                  }`}
                >
                  {filter.label}
                </Link>
              );
            })}
          </div>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Topic
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link
              href={predictionsHref({ status: selectedStatus || null, topic: null })}
              aria-current={!selectedTopic ? "page" : undefined}
              className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
                !selectedTopic
                  ? "border-foreground bg-foreground text-background"
                  : "text-foreground/70 hover:text-foreground"
              }`}
            >
              All topics
            </Link>
            {topicOptions.map((topic) => {
              const active = selectedTopic === topic;
              return (
                <Link
                  key={topic}
                  href={predictionsHref({
                    status: selectedStatus || null,
                    topic,
                  })}
                  aria-current={active ? "page" : undefined}
                  className={`rounded-full border px-3 py-1.5 text-sm capitalize transition-colors ${
                    active
                      ? "border-foreground bg-foreground text-background"
                      : "text-foreground/70 hover:text-foreground"
                  }`}
                >
                  {topic}
                </Link>
              );
            })}
          </div>
        </div>
      </section>

      <section aria-labelledby="predictions-heading" className="mt-12">
        <div className="flex items-end justify-between border-b pb-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              <Activity aria-hidden="true" className="mr-1 inline size-3.5" />
              Corpus
            </p>
            <h2 id="predictions-heading" className="mt-2 text-2xl font-semibold">
              Predictions
            </h2>
          </div>
          <span className="font-mono text-xs text-muted-foreground">
            {total === 0 ? "0" : `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)}`}{" "}
            of {total}
          </span>
        </div>

        {items.length === 0 ? (
          <div className="py-16">
            <h3 className="text-xl font-semibold">
              {summary.tracked === 0
                ? "No persisted predictions"
                : "No predictions match these filters"}
            </h3>
            <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
              This page does not invent due dates, outcomes, or next observables.
              Empty results stay empty.
            </p>
          </div>
        ) : (
          <div>
            {items.map((item) => (
              <PersistedPredictionRow key={item.id} item={item} />
            ))}
          </div>
        )}

        <div className="mt-10">
          <Pagination
            currentPage={page}
            totalPages={totalPages}
            baseUrl="/predictions"
            searchParams={{
              status: selectedStatus || undefined,
              topic: selectedTopic || undefined,
            }}
          />
        </div>
      </section>
    </div>
  );
}
