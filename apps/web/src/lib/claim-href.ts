import { isHttpUrlIdentifier } from "@hypedelta/researcher-identity";

export function isValidClaimId(id: string): boolean {
  return /^[A-Za-z0-9._:-]{1,100}$/.test(id);
}

export function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function claimDetailHref(claimId: string): string {
  return `/claims/${encodeURIComponent(claimId)}`;
}

export function claimsTopicHref(topic: string, days?: number): string {
  const params = new URLSearchParams();
  params.set("topic", topic);
  if (days != null && Number.isFinite(Number(days))) {
    const safeDays = Math.max(1, Math.min(365, Math.floor(Number(days))));
    params.set("days", String(safeDays));
  }
  return `/claims?${params.toString()}`;
}

/** URL-safe researcher path segment. Feed URLs are never valid hrefs. */
export function researcherPathSegment(slug: string | null | undefined): string | null {
  const trimmed = String(slug ?? "").trim();
  if (!trimmed || isHttpUrlIdentifier(trimmed)) return null;
  return trimmed;
}

export function researcherHref(handle: string): string {
  const segment = researcherPathSegment(handle);
  if (!segment) return "/researchers";
  return `/researchers/${encodeURIComponent(segment)}`;
}

export function claimsFilterHref(
  current: Record<string, string | undefined>,
  patch: Record<string, string | undefined | null> = {},
): string {
  const merged: Record<string, string | undefined | null> = { ...current, ...patch };
  const params = new URLSearchParams();
  for (const key of ["q", "topic", "type", "days", "author", "page"]) {
    const value = merged[key];
    if (value == null || value === "") continue;
    if (key === "page" && String(value) === "1") continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `/claims?${query}` : "/claims";
}
