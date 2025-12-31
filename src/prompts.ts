/**
 * Extraction & Synthesis Prompts
 * 
 * These prompts are designed for:
 * - GLM 4.7: Bulk filtering, classification (faster, cheaper)
 * - Claude Opus 4.5: Nuanced extraction, synthesis (higher reasoning)
 */

import type { RawContent, FilteredContent, TopicSynthesis, HypeAssessment } from './types';

// ============================================================================
// FILTER PROMPTS (GLM 4.7)
// ============================================================================

export const FILTER_PROMPT = (items: RawContent[]) => `You are a content filter for an AI research intelligence system. Your job is to assess each piece of content for relevance and classify it.

## Content to Assess

${items.map((item, idx) => `
### Item ${idx}
- **Source**: ${item.source} (${item.sourceType})
- **Author**: ${item.author}
- **Published**: ${item.publishedAt}
- **Content**:
${item.content?.slice(0, 2000) || '[No content]'}
`).join('\n---\n')}

## Your Task

For each item, assess:

1. **relevance** (0.0-1.0): How relevant is this to understanding AI research progress, capabilities, limitations, or field direction?
   - 0.0-0.3: Not relevant (personal updates, off-topic, promotional noise)
   - 0.3-0.6: Tangentially relevant (general tech news, adjacent topics)
   - 0.6-0.8: Relevant (discusses AI research, capabilities, or field)
   - 0.8-1.0: Highly relevant (substantive claims, predictions, research insights)

2. **topic**: Primary topic category. Choose ONE:
   - scaling: Scaling laws, compute, training efficiency
   - reasoning: LLM reasoning, chain-of-thought, planning capabilities
   - agents: AI agents, tool use, autonomy
   - safety: AI safety, alignment, control
   - interpretability: Mechanistic interpretability, understanding models
   - multimodal: Vision, audio, video models
   - rlhf: RLHF, preference learning, Constitutional AI
   - robotics: Embodied AI, robotics
   - benchmarks: Evals, benchmarks, capability measurement
   - infrastructure: Training infra, chips, hardware
   - policy: AI policy, regulation, governance
   - general: General AI commentary
   - other: Doesn't fit above categories

3. **contentType**: What kind of content is this?
   - prediction: Makes claims about future AI capabilities/timelines
   - research-hint: Hints at ongoing/unpublished research
   - opinion: Expresses opinion on AI progress/direction
   - factual: Reports factual information about released work
   - critique: Critiques AI capabilities or claims
   - meta: Meta-commentary on the field
   - noise: Not substantive

4. **isSubstantive** (boolean): Does this contain actual claims, arguments, or insights (vs. just links, reactions, or platitudes)?

5. **authorCategory**: Classify the author:
   - lab-researcher: Works at major AI lab (Anthropic, OpenAI, DeepMind, Meta AI, etc.)
   - critic: Known AI skeptic/critic with credentials
   - academic: University researcher
   - independent: Independent researcher/commentator
   - journalist: AI journalist
   - unknown: Cannot determine

## Response Format

Return JSON only:

{
  "assessments": [
    {
      "itemIndex": 0,
      "relevance": 0.85,
      "topic": "reasoning",
      "contentType": "research-hint",
      "isSubstantive": true,
      "authorCategory": "lab-researcher",
      "brief": "One sentence summary"
    },
    // ... for each item
  ]
}`;

// ============================================================================
// EXTRACTION PROMPTS (Claude Opus 4.5)
// ============================================================================

export const CLAIM_EXTRACTION_PROMPT = (items: FilteredContent[]) => `You are an expert analyst extracting structured intelligence from AI research content. Your goal is to identify and structure claims, predictions, hints, and opinions.

## Content to Analyze

${items.map((item, idx) => `
### Item ${idx}
- **Author**: ${item.author} (${item.authorCategory})
- **Source**: ${item.source}
- **Topic**: ${item.topic}
- **Published**: ${item.publishedAt}
- **Full Content**:
${item.content}
`).join('\n---\n')}

## Extraction Guidelines

For each piece of content, extract ALL substantive claims. A claim is any assertion that:
- States something as true about AI capabilities, limitations, or progress
- Predicts future developments
- Hints at unreleased work
- Expresses a positioned opinion on the field's direction
- Critiques others' claims or work

For each claim, capture:

1. **claimText**: The claim in clear, standalone form. Paraphrase if needed for clarity.

2. **claimType**: 
   - fact: Assertion about current state ("GPT-4 can do X")
   - prediction: Forward-looking ("By 2026, we'll have...")
   - hint: Implies unreleased work ("We've been seeing interesting results with...")
   - opinion: Positioned take ("I think scaling is/isn't sufficient")
   - critique: Challenges others ("Marcus is wrong because...")
   - question: Genuine uncertainty expressed ("I'm not sure if...")

3. **topic**: Primary topic (use same categories as filter)

4. **stance**: The directional stance:
   - bullish: Optimistic about AI progress/capabilities
   - bearish: Skeptical/pessimistic about AI progress
   - neutral: Balanced or factual without clear stance

5. **bullishness**: Float from 0.0 (maximally bearish) to 1.0 (maximally bullish)

6. **confidence**: How confident does the author seem? (0.0-1.0)
   - Look for hedging language: "might", "could", "I think", "possibly" → lower confidence
   - Look for certainty: "will", "definitely", "it's clear that" → higher confidence

7. **timeframe**: If a prediction, what timeframe?
   - near-term: < 1 year
   - medium-term: 1-3 years
   - long-term: 3-10 years
   - unspecified: No clear timeframe
   - null: Not a prediction

8. **targetEntity**: Who/what is this claim about?
   - self: The author's own work/company
   - competitor: Another lab/researcher
   - field: AI field generally
   - specific-model: A specific model (name it)
   - specific-capability: A specific capability
   - null: Not applicable

9. **evidenceProvided**: Does the claim include evidence/reasoning?
   - strong: Cites data, papers, or detailed reasoning
   - moderate: Some reasoning but not rigorous
   - weak: Assertion without support
   - appeal-to-authority: "Trust me, I work on this"

10. **quoteworthiness**: Is this claim notable enough to potentially quote in a digest? (0.0-1.0)

11. **relatedTo**: List any specific people, papers, models, or companies mentioned

## Response Format

Return JSON only:

{
  "extractions": [
    {
      "sourceIndex": 0,
      "claims": [
        {
          "claimText": "The claim in clear form",
          "claimType": "prediction",
          "topic": "reasoning",
          "stance": "bullish",
          "bullishness": 0.8,
          "confidence": 0.7,
          "timeframe": "medium-term",
          "targetEntity": "field",
          "evidenceProvided": "moderate",
          "quoteworthiness": 0.6,
          "relatedTo": ["o1", "chain-of-thought"],
          "originalQuote": "Brief relevant quote from source if notable"
        }
      ]
    }
  ]
}

## Important Notes

- Extract MULTIPLE claims from a single piece of content if present
- Don't over-extract - only substantive, meaningful claims
- A tweet saying "Interesting paper" is NOT a claim
- Look for IMPLICIT claims too ("We've made a lot of progress" implies capability gains)
- Pay attention to who is speaking - lab researchers hinting at their own work is high signal
- Critics often make claims by contradiction ("X is wrong, therefore Y")`;

// ============================================================================
// SYNTHESIS PROMPTS (Claude Opus 4.5)
// ============================================================================

export const TOPIC_SYNTHESIS_PROMPT = (
  topic: string, 
  labClaims: any[], 
  criticClaims: any[],
  independentClaims: any[]
) => `You are synthesizing the current state of discourse on "${topic}" in AI research.

## Lab Researcher Claims (from people at Anthropic, OpenAI, DeepMind, Meta AI, etc.)

${labClaims.map(c => `- **${c.author}**: ${c.claimText} [${c.claimType}, confidence: ${c.confidence}]`).join('\n')}

## Critic/Skeptic Claims (from credentialed skeptics like Marcus, Chollet, Mitchell, Bender, etc.)

${criticClaims.map(c => `- **${c.author}**: ${c.claimText} [${c.claimType}, confidence: ${c.confidence}]`).join('\n')}

## Independent Researcher Claims

${independentClaims.map(c => `- **${c.author}**: ${c.claimText} [${c.claimType}, confidence: ${c.confidence}]`).join('\n')}

## Your Task

Synthesize these claims into a coherent picture of the discourse on "${topic}":

1. **labConsensus**: What do lab researchers generally agree on? (2-3 sentences)

2. **criticConsensus**: What do critics generally agree on? (2-3 sentences)

3. **agreements**: What do BOTH sides agree on? (list of strings)

4. **disagreements**: Where do they fundamentally disagree? (list of objects with {point, labPosition, criticPosition})

5. **emergingNarratives**: What new narratives or framings are emerging? (list of strings)

6. **predictions**: Notable predictions made (list of {text, author, confidence, timeframe})

7. **evidenceQuality**: Overall quality of evidence cited (0.0-1.0)

8. **synthesisNarrative**: A balanced 2-paragraph synthesis of where things stand on this topic

## Response Format

Return JSON only:

{
  "topic": "${topic}",
  "labConsensus": "...",
  "criticConsensus": "...",
  "agreements": ["point1", "point2"],
  "disagreements": [
    {
      "point": "Whether scaling alone leads to AGI",
      "labPosition": "Many believe continued scaling will yield AGI-like capabilities",
      "criticPosition": "Fundamental architectural changes needed beyond scaling"
    }
  ],
  "emergingNarratives": ["narrative1", "narrative2"],
  "predictions": [
    {
      "text": "Prediction text",
      "author": "Author name",
      "confidence": 0.7,
      "timeframe": "medium-term"
    }
  ],
  "evidenceQuality": 0.6,
  "synthesisNarrative": "Two paragraphs..."
}`;

export const HYPE_ASSESSMENT_PROMPT = (syntheses: TopicSynthesis[]) => `You are assessing the overall hype landscape in AI based on synthesized topic analyses.

## Topic Syntheses

${syntheses.map(s => `
### ${s.topic}
- **Lab Consensus**: ${s.labConsensus}
- **Critic Consensus**: ${s.criticConsensus}
- **Hype Delta**: ${s.hypeDelta.delta.toFixed(2)} (lab sentiment: ${s.hypeDelta.labSentiment.toFixed(2)}, critic sentiment: ${s.hypeDelta.criticSentiment.toFixed(2)})
- **Key Disagreements**: ${s.keyDisagreements.map(d => d.point).join('; ')}
`).join('\n---\n')}

## Your Task

Assess which topics are overhyped, underhyped, or accurately assessed:

### Overhyped (lab enthusiasm exceeds warranted confidence)
- Topics where lab researchers make strong claims that critics have substantively challenged
- Where evidence quality is low but confidence is high
- Where predictions have repeatedly failed

### Underhyped (critic skepticism may be excessive)
- Topics where real progress has been made but critics haven't updated
- Where evidence is strong but narrative hasn't caught up
- Where lab hints suggest unreleased capabilities

### Accurately Assessed
- Topics where lab and critic views are relatively aligned
- Where claims match observable evidence
- Where predictions have been reasonably accurate

For each topic, provide:
- **score**: -1.0 (severely underhyped) to +1.0 (severely overhyped), 0 = accurate
- **reasoning**: Why you assessed it this way (2-3 sentences)
- **keyEvidence**: Specific claims or facts supporting your assessment

Also provide:
- **overallFieldSentiment**: 0.0-1.0, how bullish is the field overall right now?
- **summary**: A paragraph summarizing the current hype landscape

## Response Format

Return JSON only:

{
  "overhypedTopics": [
    {
      "topic": "topic-name",
      "score": 0.7,
      "reasoning": "Why overhyped",
      "keyEvidence": ["evidence1", "evidence2"]
    }
  ],
  "underhypedTopics": [...],
  "accuratelyAssessedTopics": [...],
  "overallFieldSentiment": 0.75,
  "summary": "Paragraph summary..."
}`;

export const DIGEST_PROMPT = (
  syntheses: TopicSynthesis[], 
  hypeAssessment: HypeAssessment
) => `You are writing a weekly AI intelligence digest for a sophisticated technical audience. They want signal, not noise - substantive insights about where the field actually is, what's been overhyped, and what's worth paying attention to.

## This Week's Topic Syntheses

${syntheses.map(s => `
### ${s.topic}
${s.synthesisNarrative}

**Notable predictions this week:**
${s.notablePredictions.map(p => `- ${p.author}: "${p.text}" (confidence: ${p.confidence}, timeframe: ${p.timeframe})`).join('\n')}

**Key disagreements:**
${s.keyDisagreements.map(d => `- ${d.point}`).join('\n')}
`).join('\n---\n')}

## Hype Assessment

${hypeAssessment.summary}

**Overhyped**: ${hypeAssessment.overhypedTopics.map(t => t.topic).join(', ')}
**Underhyped**: ${hypeAssessment.underhypedTopics.map(t => t.topic).join(', ')}
**Field sentiment**: ${(hypeAssessment.overallFieldSentiment * 100).toFixed(0)}% bullish

## Write the Digest

Write a markdown digest with the following structure:

## 🎯 TL;DR
- 3-5 bullet points of the most important takeaways this week

## 📊 Hype Check
Brief assessment of what's overhyped and underhyped, with specific evidence.

## 🔬 Research Signals
What lab researchers are hinting at or claiming. Notable predictions tracked.

## 🤔 Critic Corner  
What skeptics are saying and why. Substantive critiques worth considering.

## ⚡ Key Debates
The most important ongoing disagreements in the field.

## 🔮 Predictions Tracker
Notable predictions made this week, with confidence levels.

## 📌 Worth Watching
Topics or threads that may become important in coming weeks.

---

Guidelines:
- Be direct and opinionated but fair
- Call out hype when warranted, but also acknowledge genuine progress
- Use specific examples and quotes where impactful
- Don't hedge excessively - take positions
- Write for experts who don't need basics explained
- Keep it under 1500 words`;

// ============================================================================
// SPECIALIZED PROMPTS
// ============================================================================

export const PREDICTION_TRACKING_PROMPT = (predictions: any[]) => `You are tracking AI predictions to assess their accuracy.

## Predictions to Evaluate

${predictions.map(p => `
### Prediction by ${p.author} (${p.madeAt})
"${p.text}"
- **Timeframe**: ${p.timeframe}
- **Original confidence**: ${p.confidence}
- **Topic**: ${p.topic}
`).join('\n---\n')}

## Your Task

For each prediction, assess:

1. **status**: 
   - verified: Clearly came true
   - falsified: Clearly did not come true
   - partially-verified: Partially accurate
   - too-early: Not enough time has passed
   - unfalsifiable: Cannot be objectively assessed
   - ambiguous: Prediction was too vague to evaluate

2. **evidence**: What evidence supports your assessment?

3. **accuracyScore**: If verifiable, how accurate was it? (0.0-1.0)

4. **notes**: Any relevant context

Return JSON array of assessments.`;

export const ARGUMENT_MAPPING_PROMPT = (criticContent: any) => `You are mapping the argument structure of an AI critic's position.

## Content
**Author**: ${criticContent.author}
**Source**: ${criticContent.source}

${criticContent.content}

## Map the Argument

Extract the logical structure:

1. **mainThesis**: The central claim being made

2. **premises**: List of supporting premises/assumptions

3. **evidence**: Specific evidence or examples cited

4. **targetClaims**: What specific claims/positions is this critiquing?

5. **concessions**: What does the critic concede or acknowledge?

6. **weaknesses**: What are potential weaknesses in this argument?

7. **steelmanResponse**: What would a strong response from the other side look like?

Return as structured JSON.`;

export const HINT_DETECTION_PROMPT = (content: any) => `You are detecting hints about unreleased AI research or capabilities.

## Content
**Author**: ${content.author} (${content.affiliation})
**Source**: ${content.source}

${content.content}

## Detect Hints

Lab researchers often hint at work before publication. Look for:

1. **Vague progress claims**: "We've been seeing interesting results with..."
2. **Deflection with smile**: "I can't say much, but..."  
3. **Future tense confidence**: "You'll see that..." / "This will become clear..."
4. **Unusual excitement**: Disproportionate enthusiasm about a topic
5. **Specific denials**: Sometimes denying something calls attention to it
6. **Timeline hints**: "In the coming months..."
7. **Capability hedging**: "Current models can't do X yet" (implying future ones might)

For each detected hint:

1. **hintText**: The relevant quote/passage
2. **impliedCapability**: What capability or result is being hinted at?
3. **confidence**: How confident are you this is a real hint? (0.0-1.0)
4. **timeframe**: When might this be revealed?
5. **domain**: What area of AI (reasoning, multimodal, safety, etc.)

Return JSON array. Return empty array if no credible hints detected.`;

export default {
  FILTER_PROMPT,
  CLAIM_EXTRACTION_PROMPT,
  TOPIC_SYNTHESIS_PROMPT,
  HYPE_ASSESSMENT_PROMPT,
  DIGEST_PROMPT,
  PREDICTION_TRACKING_PROMPT,
  ARGUMENT_MAPPING_PROMPT,
  HINT_DETECTION_PROMPT
};
