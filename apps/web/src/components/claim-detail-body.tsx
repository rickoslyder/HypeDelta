import Link from "next/link";
import { ArrowUpRight, Calendar, User } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { claimDetailHref, researcherHref } from "@/lib/claim-href";
import type { LiveEvidenceCard } from "@/lib/live-evidence-ledger";

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

const statusLabel: Record<LiveEvidenceCard["presentationStatus"], string> = {
  "evidence-only": "Evidence only",
  pending: "Pending",
  overdue: "Overdue",
  verified: "Verified",
  falsified: "Falsified",
  "partially-verified": "Partially verified",
  "too-early": "Too early",
};

export function ClaimDetailBody({ claim }: { claim: LiveEvidenceCard }) {
  const extracted = formatDate(claim.extractedAt);
  const target = formatDate(claim.targetDate);

  return (
    <article className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        {claim.topic && (
          <Badge variant="outline" className="capitalize">
            {claim.topic}
          </Badge>
        )}
        {claim.claimType && (
          <Badge variant={claim.claimType === "prediction" ? "default" : "secondary"} className="capitalize">
            {claim.claimType}
          </Badge>
        )}
        {claim.stance && (
          <Badge variant="outline" className="capitalize">
            {claim.stance}
          </Badge>
        )}
        {claim.presentationStatus !== "evidence-only" && (
          <Badge variant={claim.presentationStatus === "overdue" ? "destructive" : "secondary"}>
            {statusLabel[claim.presentationStatus]}
          </Badge>
        )}
      </div>

      <h1 className="text-3xl font-bold tracking-tight">
        <Link href={claimDetailHref(claim.id)} className="hover:underline">
          {claim.claimText}
        </Link>
      </h1>

      {claim.originalQuote && (
        <blockquote className="border-l-2 border-muted pl-3 text-sm text-muted-foreground italic">
          {claim.originalQuote}
        </blockquote>
      )}

      <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
        {claim.authorHandle && (
          <Link href={researcherHref(claim.authorHandle)} className="inline-flex items-center gap-1 hover:underline">
            <User className="h-3 w-3" />
            {claim.authorName || claim.authorHandle}
          </Link>
        )}
        {extracted && (
          <span className="inline-flex items-center gap-1">
            <Calendar className="h-3 w-3" />
            {extracted}
          </span>
        )}
      </div>

      {claim.canonicalSourceUrl ? (
        <p>
          <a
            href={claim.canonicalSourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm font-medium underline decoration-border underline-offset-4 hover:decoration-foreground"
          >
            {claim.canonicalSourceUrl}
            <ArrowUpRight className="size-4" aria-hidden="true" />
          </a>
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">Source unavailable</p>
      )}

      {claim.presentationStatus !== "evidence-only" && (
        <section className="grid gap-px overflow-hidden rounded-lg border bg-border md:grid-cols-2">
          <div className="bg-background p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Outcome
            </p>
            <p className="mt-2 text-sm">
              {claim.outcomeEvidence ?? "No outcome evidence recorded."}
            </p>
            {claim.evidenceUrl && (
              <p className="mt-3">
                <a
                  href={claim.evidenceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-sm font-medium underline decoration-border underline-offset-4 hover:decoration-foreground"
                >
                  {claim.evidenceUrl}
                  <ArrowUpRight className="size-4" aria-hidden="true" />
                </a>
              </p>
            )}
          </div>
          <div className="bg-background p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Next observable
            </p>
            {claim.nextQuestion && (
              <p className="mt-2 text-sm font-medium">{claim.nextQuestion}</p>
            )}
            {claim.nextObservable && (
              <p className="mt-2 text-sm text-muted-foreground">{claim.nextObservable}</p>
            )}
            {target && (
              <p className="mt-3 font-mono text-[11px] text-muted-foreground">
                Target {target}
              </p>
            )}
            {!claim.nextQuestion && !claim.nextObservable && !target && (
              <p className="mt-2 text-sm text-muted-foreground">None recorded.</p>
            )}
          </div>
        </section>
      )}
    </article>
  );
}
