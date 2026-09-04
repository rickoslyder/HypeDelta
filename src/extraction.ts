/**
 * Shared claim-extraction helpers.
 * originalQuote/contentId remain fail-closed. Never log source bodies.
 */
import { z } from 'zod';

/**
 * Live extractClaims chunking caps (deterministic, overlap-capable).
 * Source bodies are sent to the model only; never logged.
 *
 * - EXTRACTION_CHUNK_SIZE: max characters per provider prompt chunk
 * - EXTRACTION_CHUNK_OVERLAP: characters repeated between adjacent chunks
 * - EXTRACTION_MAX_CHUNKS: max chunks per content item
 * - EXTRACTION_MAX_TOTAL_CHARS: max source characters considered per item
 * - EXTRACTION_MAX_PROVIDER_CALLS: max provider calls per extractClaims invocation
 */
export const EXTRACTION_CONTENT_LIMIT = 6000;
export const EXTRACTION_CHUNK_SIZE = EXTRACTION_CONTENT_LIMIT;
export const EXTRACTION_CHUNK_OVERLAP = 500;
export const EXTRACTION_MAX_CHUNKS = 4;
export const EXTRACTION_MAX_TOTAL_CHARS =
  EXTRACTION_CHUNK_SIZE + (EXTRACTION_MAX_CHUNKS - 1) * (EXTRACTION_CHUNK_SIZE - EXTRACTION_CHUNK_OVERLAP);
export const EXTRACTION_MAX_PROVIDER_CALLS = EXTRACTION_MAX_CHUNKS * 10;

const nonblankText = z.string().trim().min(1);

/** Runtime schema at the live extractor boundary. */
export const LiveExtractedClaimSchema = z.object({
  contentId: z.number().int().positive(),
  claimText: nonblankText,
  originalQuote: nonblankText,
}).passthrough();

export type LiveExtractedClaim = z.infer<typeof LiveExtractedClaimSchema>;

export function chunkExtractionContent(text: string): string[] {
  const bounded = text.slice(0, EXTRACTION_MAX_TOTAL_CHARS);
  if (bounded.length === 0) return [''];
  const chunks: string[] = [];
  const step = EXTRACTION_CHUNK_SIZE - EXTRACTION_CHUNK_OVERLAP;
  let start = 0;
  while (chunks.length < EXTRACTION_MAX_CHUNKS && start < bounded.length) {
    chunks.push(bounded.slice(start, start + EXTRACTION_CHUNK_SIZE));
    if (start + EXTRACTION_CHUNK_SIZE >= bounded.length) break;
    start += step;
  }
  return chunks;
}

function parseJsonValue(output: string): unknown | undefined {
  try {
    return JSON.parse(output);
  } catch { /* fall through */ }
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch { /* fall through */ }
  }
  const objectMatch = output.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch { /* fall through */ }
  }
  return undefined;
}

export function parseLiveExtractClaimsOutput(
  raw: string | null | undefined,
  allowedContentIds: Set<number>,
): {
  agentOutputs: number;
  claims: LiveExtractedClaim[];
  rejectedClaims: number;
  failedClosed: boolean;
} {
  const fail = (agentOutputs: number) => ({
    agentOutputs,
    claims: [] as LiveExtractedClaim[],
    rejectedClaims: agentOutputs,
    failedClosed: true,
  });
  if (raw == null || raw.trim() === '') return fail(0);
  const parsed = parseJsonValue(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail(0);
  const claimsRaw = (parsed as { claims?: unknown }).claims;
  if (!Array.isArray(claimsRaw)) return fail(0);
  const agentOutputs = claimsRaw.length;
  const parsedClaims: LiveExtractedClaim[] = [];
  const seenExact = new Set<string>();
  const textToQuote = new Map<string, string>();
  const quoteToText = new Map<string, string>();
  for (const item of claimsRaw) {
    const result = LiveExtractedClaimSchema.safeParse(item);
    if (!result.success) return fail(agentOutputs);
    const claim = result.data;
    if (!allowedContentIds.has(claim.contentId)) return fail(agentOutputs);
    const exactKey = `${claim.contentId}\u0000${claim.claimText}\u0000${claim.originalQuote}`;
    if (seenExact.has(exactKey)) return fail(agentOutputs);
    seenExact.add(exactKey);
    const textKey = `${claim.contentId}\u0000${claim.claimText}`;
    const quoteKey = `${claim.contentId}\u0000${claim.originalQuote}`;
    const prevQuote = textToQuote.get(textKey);
    if (prevQuote !== undefined && prevQuote !== claim.originalQuote) return fail(agentOutputs);
    const prevText = quoteToText.get(quoteKey);
    if (prevText !== undefined && prevText !== claim.claimText) return fail(agentOutputs);
    textToQuote.set(textKey, claim.originalQuote);
    quoteToText.set(quoteKey, claim.claimText);
    parsedClaims.push(claim);
  }
  return { agentOutputs, claims: parsedClaims, rejectedClaims: 0, failedClosed: false };
}

function dedupeExtractedClaims(claims: LiveExtractedClaim[]): LiveExtractedClaim[] {
  const seen = new Set<string>();
  const out: LiveExtractedClaim[] = [];
  for (const claim of claims) {
    const key = `${claim.contentId}\u0000${claim.claimText}\u0000${claim.originalQuote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(claim);
  }
  return out;
}

/** Exact duplicates keep one; conflicting mappings across responses are dropped as a set. */
export function mergeAdmittedClaims(claims: LiveExtractedClaim[]): LiveExtractedClaim[] {
  const deduped = dedupeExtractedClaims(claims);
  const textToQuotes = new Map<string, Set<string>>();
  const quoteToTexts = new Map<string, Set<string>>();
  for (const claim of deduped) {
    const textKey = `${claim.contentId}\u0000${claim.claimText}`;
    const quoteKey = `${claim.contentId}\u0000${claim.originalQuote}`;
    const quotes = textToQuotes.get(textKey) ?? new Set<string>();
    quotes.add(claim.originalQuote);
    textToQuotes.set(textKey, quotes);
    const texts = quoteToTexts.get(quoteKey) ?? new Set<string>();
    texts.add(claim.claimText);
    quoteToTexts.set(quoteKey, texts);
  }
  const conflictText = new Set<string>();
  const conflictQuote = new Set<string>();
  for (const [key, quotes] of textToQuotes) {
    if (quotes.size > 1) conflictText.add(key);
  }
  for (const [key, texts] of quoteToTexts) {
    if (texts.size > 1) conflictQuote.add(key);
  }
  return deduped.filter((claim) => {
    const textKey = `${claim.contentId}\u0000${claim.claimText}`;
    const quoteKey = `${claim.contentId}\u0000${claim.originalQuote}`;
    return !conflictText.has(textKey) && !conflictQuote.has(quoteKey);
  });
}

export function buildLiveExtractPrompt(entry: {
  contentId: number;
  author?: string;
  content: string;
  topic?: unknown;
  authorCategory?: unknown;
}): string {
  return `You are a claim extractor for AI research content. Extract claims and return ONLY a JSON object.

Content items:
${JSON.stringify([{
    idx: 0,
    contentId: entry.contentId,
    author: entry.author,
    content: entry.content,
    topic: entry.topic,
    authorCategory: entry.authorCategory,
  }], null, 2)}

For each claim found, extract. contentId and originalQuote are required for every returned claim:
- contentId: required server-selected source content ID from the input (do not invent)
- claimText: the actual claim in clear language (nonblank)
- claimType: fact|prediction|hint|opinion|critique
- topic: from source or inferred
- stance: bullish|bearish|neutral (on AI progress)
- bullishness: 0.0-1.0
- confidence: 0.0-1.0 (how confident author seems)
- timeframe: near-term|medium-term|long-term|null
- evidenceProvided: strong|moderate|weak|appeal-to-authority
- quoteworthiness: 0.0-1.0
- originalQuote: required exact nonblank non-empty verbatim contiguous source span copied from that input content (never paraphrase)
- author: from source
- authorCategory: from source

Extract MULTIPLE claims per source when warranted. Focus on predictions, research hints, and substantive opinions.

IMPORTANT: Return ONLY valid JSON, no markdown. Format:
{"claims": [{"contentId": 123, "claimText": "...", "claimType": "prediction", "originalQuote": "exact span", ...}]}`;
}
