import type { Metadata } from "next";
import Link from "next/link";
import {
  Activity,
  ArrowUpRight,
  CheckCircle2,
  Clock3,
  FileCheck2,
  ShieldCheck,
} from "lucide-react";

import { claimDetailHref } from "@/lib/claim-href";
import { getLiveEvidenceLedger } from "@/lib/db";
import { type LiveEvidenceCard } from "@/lib/live-evidence-ledger";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Evidence ledger | HypeDelta",
  description:
    "A live evidence ledger connecting claims to primary sources, outcomes, and observable follow-ups.",
};

const statusLabels: Record<LiveEvidenceCard["presentationStatus"], string> = {
  "evidence-only": "Evidence only",
  pending: "Pending",
  overdue: "Overdue",
  verified: "Verified",
  falsified: "Falsified",
  "partially-verified": "Partially verified",
  "too-early": "Too early",
};

const statusStyles: Record<LiveEvidenceCard["presentationStatus"], string> = {
  "evidence-only":
    "border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300",
  pending:
    "border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300",
  overdue:
    "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/70 dark:bg-amber-950/40 dark:text-amber-300",
  verified:
    "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/70 dark:bg-emerald-950/40 dark:text-emerald-300",
  falsified:
    "border-red-200 bg-red-50 text-red-800 dark:border-red-900/70 dark:bg-red-950/40 dark:text-red-300",
  "partially-verified":
    "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/70 dark:bg-amber-950/40 dark:text-amber-300",
  "too-early":
    "border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300",
};

function formatDate(value: string | null): string | null {
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

export default async function ReliabilityPage() {
  const { cards, summary } = await getLiveEvidenceLedger({ limit: 20 });

  return (
    <div className="mx-auto w-full max-w-7xl px-5 py-10 sm:px-8 sm:py-14 lg:px-12">
      <header className="max-w-4xl">
        <div className="mb-5 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          <Activity aria-hidden="true" className="size-4" />
          Live evidence ledger
        </div>
        <h1 className="max-w-3xl text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
          Evidence ledger, claim reliability.
        </h1>
        <p className="mt-5 max-w-2xl text-pretty text-base leading-7 text-muted-foreground sm:text-lg">
          Global corpus counts cover every admitted claim. Selected cards below
          are a prediction-first slice with a canonical source URL and a
          verbatim quote. Prediction outcomes and next observables are shown
          only when a durable prediction row exists.
        </p>
      </header>

      <section
        aria-label="Global admitted corpus"
        className="mt-10 grid border-y sm:grid-cols-2 lg:grid-cols-4"
      >
        <div className="border-b py-6 sm:border-r lg:border-b-0 lg:pr-8">
          <p className="text-3xl font-semibold tabular-nums">
            {summary.admittedCount}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">Admitted claims</p>
          <p className="mt-3 text-xs text-muted-foreground">
            Global admitted corpus · source + verbatim quote required
          </p>
        </div>
        <div className="border-b py-6 sm:pl-8 lg:border-b-0 lg:border-r lg:pr-8">
          <p className="text-3xl font-semibold tabular-nums">
            {summary.quoteBackedCount}/{summary.admittedCount || 0}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">Quote coverage</p>
          <p className="mt-3 text-xs text-muted-foreground">
            Of the global admitted corpus
          </p>
        </div>
        <div className="border-b py-6 sm:border-b-0 sm:border-r lg:pl-8 lg:pr-8">
          <p className="text-3xl font-semibold tabular-nums">
            {summary.openPredictionCount}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">Open predictions</p>
          <p className="mt-3 text-xs text-muted-foreground">
            {summary.overdueCount} overdue · {summary.admittedPredictionCount} admitted predictions
          </p>
        </div>
        <div className="py-6 sm:pl-8">
          <p className="text-3xl font-semibold tabular-nums">
            {summary.resolvedCount}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">Resolved outcomes</p>
          <p className="mt-3 text-xs text-muted-foreground">
            {summary.evidenceOnlyCount} evidence-only claims
          </p>
        </div>
      </section>

      <div className="mt-12 grid gap-12 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start">
        <section aria-labelledby="claims-heading">
          <div className="flex items-end justify-between border-b pb-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Selected rows
              </p>
              <h2 id="claims-heading" className="mt-2 text-2xl font-semibold">
                Live admitted claims
              </h2>
              <p className="mt-2 max-w-xl text-sm text-muted-foreground">
                Prediction-first selection: admitted prediction rows appear
                before evidence-only rows, then newest first.
              </p>
            </div>
            <span className="hidden font-mono text-xs text-muted-foreground sm:block">
              n={cards.length} selected rows
            </span>
          </div>

          {cards.length === 0 ? (
            <div className="py-16">
              <h3 className="text-xl font-semibold">No admitted live claims</h3>
              <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
                A card is admitted only when it has a nonblank canonical source
                URL (claim source_url, falling back to content.url) and a
                verbatim original quote. This page does not substitute example
                data for an empty ledger.
              </p>
            </div>
          ) : (
            <div>
              {cards.map((card, index) => {
                const extracted = formatDate(card.extractedAt);
                const target = formatDate(card.targetDate);
                return (
                  <article
                    key={card.id}
                    id={card.id}
                    className="border-b py-9 first:pt-8"
                  >
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="font-mono text-xs text-muted-foreground">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                        {card.claimType ?? "claim"}
                        {card.topic ? ` · ${card.topic}` : ""}
                      </span>
                      <span
                        className={`ml-auto rounded-full border px-2.5 py-1 text-xs font-medium ${statusStyles[card.presentationStatus]}`}
                      >
                        {statusLabels[card.presentationStatus]}
                      </span>
                    </div>

                    <h3 className="mt-5 max-w-4xl text-xl font-semibold leading-8 tracking-tight sm:text-2xl">
                      <Link href={claimDetailHref(card.id)} className="hover:underline">
                        {card.claimText}
                      </Link>
                    </h3>

                    {card.authorHandle && (
                      <p className="mt-3 text-sm text-muted-foreground">
                        @{card.authorHandle}
                        {card.authorName ? ` · ${card.authorName}` : ""}
                      </p>
                    )}

                    <div className="mt-6 border-l-2 border-foreground/15 pl-5">
                      <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                        Original quote
                      </p>
                      <p className="mt-2 text-sm leading-6 text-foreground/85 italic">
                        {card.originalQuote}
                      </p>
                    </div>

                    {card.presentationStatus !== "evidence-only" && (
                      <div className="mt-7 grid gap-px overflow-hidden rounded-lg border bg-border md:grid-cols-2">
                        <div className="bg-background p-5">
                          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                            <CheckCircle2 aria-hidden="true" className="size-4" />
                            Outcome so far
                          </div>
                          <p className="mt-3 text-sm leading-6 text-foreground/85">
                            {card.outcomeEvidence ?? "No outcome evidence recorded."}
                          </p>
                          {card.evidenceUrl && (
                            <p className="mt-3">
                              <a
                                href={card.evidenceUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-sm font-medium underline decoration-border underline-offset-4 hover:decoration-foreground"
                              >
                                {card.evidenceUrl}
                                <ArrowUpRight
                                  aria-hidden="true"
                                  className="size-4 shrink-0 text-muted-foreground"
                                />
                              </a>
                            </p>
                          )}
                        </div>
                        <div className="bg-background p-5">
                          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                            <Clock3 aria-hidden="true" className="size-4" />
                            Next observable
                          </div>
                          {card.nextQuestion && (
                            <p className="mt-3 text-sm font-medium leading-6">
                              {card.nextQuestion}
                            </p>
                          )}
                          {card.nextObservable && (
                            <p className="mt-2 text-sm leading-6 text-muted-foreground">
                              {card.nextObservable}
                            </p>
                          )}
                          {target && (
                            <p className="mt-3 font-mono text-[11px] text-muted-foreground">
                              Target {target}
                            </p>
                          )}
                          {!card.nextQuestion && !card.nextObservable && !target && (
                            <p className="mt-3 text-sm leading-6 text-muted-foreground">
                              None recorded.
                            </p>
                          )}
                        </div>
                      </div>
                    )}

                    <div className="mt-6 flex items-start gap-3">
                      <FileCheck2
                        aria-hidden="true"
                        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                      />
                      <div className="min-w-0">
                        <p className="mb-1 text-xs text-muted-foreground">
                          Canonical source
                          {extracted ? ` / ${extracted}` : ""}
                        </p>
                        {card.canonicalSourceUrl ? (
                          <a
                            href={card.canonicalSourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="group inline-flex items-start gap-2 text-sm font-medium text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground"
                          >
                            <span>
                              {card.canonicalSourceUrl}
                              <span className="sr-only"> (opens in a new tab)</span>
                            </span>
                            <ArrowUpRight
                              aria-hidden="true"
                              className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
                            />
                          </a>
                        ) : (
                          <p className="text-sm text-muted-foreground">Source unavailable</p>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <aside className="border-t pt-6 lg:sticky lg:top-28 lg:border-t-0 lg:border-l lg:pl-7 lg:pt-0">
          <div className="flex items-center gap-2">
            <ShieldCheck aria-hidden="true" className="size-5" />
            <h2 className="font-semibold">Admission rules</h2>
          </div>
          <ol className="mt-5 space-y-5 text-sm leading-6 text-muted-foreground">
            <li>
              <span className="font-mono text-xs text-foreground">01</span>
              <p className="mt-1">
                Every displayed claim has a canonical source URL and a verbatim quote.
              </p>
            </li>
            <li>
              <span className="font-mono text-xs text-foreground">02</span>
              <p className="mt-1">
                Live card ids are extracted claim ids. Quotes, outcomes, and dates are never invented.
              </p>
            </li>
            <li>
              <span className="font-mono text-xs text-foreground">03</span>
              <p className="mt-1">
                Overdue requires an unresolved prediction and a non-null target
                date before now. Pending or too-early rows with no due date stay
                open.
              </p>
            </li>
            <li>
              <span className="font-mono text-xs text-foreground">04</span>
              <p className="mt-1">
                Non-prediction claims stay evidence-only — no fabricated next observable.
              </p>
            </li>
            <li>
              <span className="font-mono text-xs text-foreground">05</span>
              <p className="mt-1">
                Selected cards use prediction-first ordering. Coverage numbers
                are the global admitted corpus, not this selected slice.
              </p>
            </li>
          </ol>
          <div className="mt-7 border-t pt-5 text-xs leading-5 text-muted-foreground">
            <p>
              Global corpus counts come from the whole admitted ledger. Selected
              rows are a prediction-first slice, not the coverage denominator.
              An empty ledger stays empty.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
