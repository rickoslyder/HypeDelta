/**
 * Structured-output schemas for direct (non-agentic) model calls.
 *
 * These validate JSON returned by a model when we bypass the Agent SDK harness
 * and call a model API directly with a forced JSON response. Using zod here
 * replaces the regex JSON-scraping in agent-sdk-wrapper with strict validation.
 */

import { z } from 'zod';

/** A single content-filter assessment (mirrors FILTER_PROMPT's output shape). */
export const FilterAssessmentSchema = z.object({
  itemIndex: z.number().optional(),
  relevance: z.number().min(0).max(1),
  topic: z.string().default('general'),
  contentType: z.string().default('opinion'),
  isSubstantive: z.boolean().default(true),
  authorCategory: z.string().default('unknown'),
  brief: z.string().default(''),
});

export const FilterResponseSchema = z.object({
  assessments: z.array(FilterAssessmentSchema),
});

export type FilterAssessment = z.infer<typeof FilterAssessmentSchema>;
export type FilterResponse = z.infer<typeof FilterResponseSchema>;
