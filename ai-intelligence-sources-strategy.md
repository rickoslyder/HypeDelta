# AI Intelligence Aggregator: Content Fetching & Parsing Strategy

## Source Type Matrix

| Source Type | Volume | Auth Required | Rate Limits | Freshness Need | Complexity |
|-------------|--------|---------------|-------------|----------------|------------|
| Twitter/X | High | Variable | Strict | Real-time | High |
| Substack | Medium | No | Generous | Daily | Low |
| YouTube | Medium | No | Moderate | Weekly | Medium |
| Personal Blogs | Low | No | None | Weekly | Low |
| Lab Blogs | Low | No | None | Weekly | Low |
| Podcasts | Low | No | None | Weekly | Medium |
| arXiv | Medium | No | Generous | Daily | Low |
| LessWrong/AF | Medium | No | Moderate | Daily | Low |

---

## 1. Twitter/X

### Source Disambiguation

```
┌─────────────────────────────────────────────────────────────┐
│                    TWITTER SOURCES                           │
├─────────────────────────────────────────────────────────────┤
│  Profile Types:                                              │
│  • Researchers (primary signal) - ~150 accounts             │
│  • Lab official accounts - ~15 accounts                     │
│  • Aggregator/news accounts - ~10 accounts                  │
│                                                              │
│  Content Types:                                              │
│  • Original tweets (highest value)                          │
│  • Quote tweets (context + opinion)                         │
│  • Threads (deep dives)                                     │
│  • Replies (debates, clarifications)                        │
└─────────────────────────────────────────────────────────────┘
```

### Fetching Strategy (Tiered)

**Tier 1: Nitter RSS (Primary - Free)**
```javascript
// nitter-fetcher.js
const NITTER_INSTANCES = [
  'nitter.poast.org',
  'nitter.privacydev.net',
  'nitter.woodland.cafe',
  'nitter.1d4.us',
  'nitter.net',
  'nitter.cz'
];

const TWITTER_HANDLES = [
  // S-Tier - check every 2 hours
  { handle: 'karpathy', tier: 's', checkInterval: 7200 },
  { handle: 'ylecun', tier: 's', checkInterval: 7200 },
  { handle: 'ch402', tier: 's', checkInterval: 7200 },
  { handle: 'fchollet', tier: 's', checkInterval: 7200 },
  // A-Tier - check every 6 hours
  { handle: 'DarioAmodei', tier: 'a', checkInterval: 21600 },
  { handle: 'sama', tier: 'a', checkInterval: 21600 },
  { handle: 'demishassabis', tier: 'a', checkInterval: 21600 },
  // ... etc
];

async function fetchNitterRSS(handle) {
  for (const instance of shuffleArray(NITTER_INSTANCES)) {
    try {
      const url = `https://${instance}/${handle}/rss`;
      const response = await fetch(url, { 
        timeout: 8000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RSS Reader)' }
      });
      
      if (response.ok) {
        const xml = await response.text();
        return { success: true, data: xml, instance };
      }
    } catch (e) {
      continue; // Try next instance
    }
  }
  return { success: false, handle };
}
```

**Tier 2: yt-dlp Fallback**
```bash
#!/bin/bash
# twitter-ytdlp-fallback.sh

HANDLE=$1
OUTPUT_DIR="/data/twitter/raw/${HANDLE}"

yt-dlp \
  --flat-playlist \
  --print-json \
  --playlist-end 50 \
  "https://twitter.com/${HANDLE}" \
  2>/dev/null | jq -s '.' > "${OUTPUT_DIR}/$(date +%Y%m%d).json"
```

**Tier 3: Playwright Session (Full Fidelity)**
```javascript
// twitter-playwright.js
import { chromium } from 'playwright';

async function scrapeTwitterProfile(handle, sessionDir = './twitter-session') {
  const browser = await chromium.launchPersistentContext(sessionDir, {
    headless: true,
    viewport: { width: 1280, height: 720 }
  });

  const page = await browser.newPage();
  await page.goto(`https://twitter.com/${handle}`, { waitUntil: 'networkidle' });
  
  // Scroll to load more tweets
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await page.waitForTimeout(randomDelay(1500, 3000));
  }

  const tweets = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('article[data-testid="tweet"]'))
      .map(tweet => {
        const textEl = tweet.querySelector('[data-testid="tweetText"]');
        const timeEl = tweet.querySelector('time');
        const linkEl = tweet.querySelector('a[href*="/status/"]');
        
        return {
          text: textEl?.innerText || '',
          timestamp: timeEl?.getAttribute('datetime'),
          url: linkEl?.href,
          isRetweet: !!tweet.querySelector('[data-testid="socialContext"]'),
          isQuote: !!tweet.querySelector('[data-testid="quoteTweet"]'),
          metrics: {
            replies: extractMetric(tweet, 'reply'),
            retweets: extractMetric(tweet, 'retweet'),
            likes: extractMetric(tweet, 'like')
          }
        };
      });
  });

  await browser.close();
  return tweets;
}

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
```

### Parsing Strategy

```javascript
// twitter-parser.js
const SIGNAL_PATTERNS = {
  // High-value content indicators
  predictions: [
    /\b(predict|expect|will happen|timeline|by 202\d)\b/i,
    /\b(my bet|I think we'll see|calling it now)\b/i
  ],
  hints: [
    /\b(working on|excited about|can't share yet|stay tuned)\b/i,
    /\b(we've been|internally|not public yet)\b/i
  ],
  critiques: [
    /\b(disagree|wrong|overhyped|actually|misconception)\b/i,
    /\b(this is wrong|people don't realize|hot take)\b/i
  ],
  papers: [
    /arxiv\.org\/abs\/\d+\.\d+/,
    /\b(new paper|our paper|just published)\b/i
  ],
  debates: [
    /\b(thread|🧵|1\/\d+)\b/i,
    /@\w+\s+(is wrong|disagrees|argues)/i
  ]
};

function parseTweet(tweet, authorMeta) {
  const signals = {};
  
  // Detect content type
  for (const [signalType, patterns] of Object.entries(SIGNAL_PATTERNS)) {
    signals[signalType] = patterns.some(p => p.test(tweet.text));
  }
  
  // Extract entities
  const entities = {
    mentions: tweet.text.match(/@\w+/g) || [],
    urls: tweet.text.match(/https?:\/\/[^\s]+/g) || [],
    arxivIds: tweet.text.match(/\d{4}\.\d{4,5}/g) || [],
    hashtags: tweet.text.match(/#\w+/g) || []
  };
  
  // Calculate signal score
  const signalScore = calculateSignalScore(tweet, signals, authorMeta);
  
  return {
    id: extractTweetId(tweet.url),
    author: authorMeta.handle,
    authorTier: authorMeta.tier,
    text: tweet.text,
    timestamp: tweet.timestamp,
    url: tweet.url,
    isThread: signals.debates && tweet.text.includes('1/'),
    isRetweet: tweet.isRetweet,
    isQuote: tweet.isQuote,
    signals,
    entities,
    signalScore,
    needsThreadExpansion: signals.debates,
    needsLLMExtraction: signalScore > 0.5
  };
}

function calculateSignalScore(tweet, signals, authorMeta) {
  let score = 0;
  
  // Author tier weight
  const tierWeights = { s: 1.5, a: 1.2, b: 1.0, c: 0.8 };
  score += tierWeights[authorMeta.tier] || 1.0;
  
  // Signal type weights
  if (signals.predictions) score += 0.8;
  if (signals.hints) score += 0.9;
  if (signals.critiques) score += 0.6;
  if (signals.papers) score += 0.7;
  if (signals.debates) score += 0.5;
  
  // Engagement weight (log scale)
  const engagement = tweet.metrics?.likes || 0;
  score += Math.log10(Math.max(engagement, 1)) * 0.1;
  
  // Length weight (longer = more substantive, usually)
  if (tweet.text.length > 200) score += 0.3;
  
  return Math.min(score / 5, 1); // Normalize to 0-1
}
```

### Storage Schema (Twitter)

```sql
-- tweets table
CREATE TABLE tweets (
  id TEXT PRIMARY KEY,
  author_handle TEXT NOT NULL,
  author_tier TEXT,
  text TEXT NOT NULL,
  timestamp TIMESTAMPTZ,
  url TEXT,
  is_thread BOOLEAN DEFAULT FALSE,
  is_retweet BOOLEAN DEFAULT FALSE,
  is_quote BOOLEAN DEFAULT FALSE,
  signal_score FLOAT,
  raw_json JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Extracted signals
  has_prediction BOOLEAN DEFAULT FALSE,
  has_hint BOOLEAN DEFAULT FALSE,
  has_critique BOOLEAN DEFAULT FALSE,
  has_paper_ref BOOLEAN DEFAULT FALSE,
  
  -- For vector search
  embedding vector(1536)
);

CREATE INDEX idx_tweets_author ON tweets(author_handle);
CREATE INDEX idx_tweets_timestamp ON tweets(timestamp DESC);
CREATE INDEX idx_tweets_signal_score ON tweets(signal_score DESC);
CREATE INDEX idx_tweets_embedding ON tweets USING ivfflat (embedding vector_cosine_ops);
```

---

## 2. Substacks / Newsletters

### Source Disambiguation

```
┌─────────────────────────────────────────────────────────────┐
│                   SUBSTACK SOURCES                           │
├─────────────────────────────────────────────────────────────┤
│  Type A: Native Substack (RSS at /feed)                     │
│  • Import AI, Interconnects, AI Snake Oil, etc.             │
│                                                              │
│  Type B: Ghost-hosted (RSS at /rss)                         │
│  • bounded-regret.ghost.io, etc.                            │
│                                                              │
│  Type C: Custom platforms (varies)                          │
│  • thegradient.pub (/feed), etc.                            │
│                                                              │
│  Type D: Email-only (requires forwarding setup)             │
│  • The Batch (deeplearning.ai) - scrape archive page        │
└─────────────────────────────────────────────────────────────┘
```

### Fetching Strategy

```javascript
// substack-fetcher.js
import Parser from 'rss-parser';

const SUBSTACK_SOURCES = [
  // Type A: Native Substack
  { 
    name: 'Import AI',
    url: 'https://importai.substack.com/feed',
    author: 'Jack Clark',
    tags: ['research', 'policy', 'weekly'],
    priority: 'high'
  },
  { 
    name: 'Interconnects',
    url: 'https://www.interconnects.ai/feed',
    author: 'Nathan Lambert',
    tags: ['rlhf', 'alignment', 'technical'],
    priority: 'high'
  },
  { 
    name: 'AI Snake Oil',
    url: 'https://www.aisnakeoil.com/feed',
    author: 'Narayanan & Kapoor',
    tags: ['critique', 'hype', 'academic'],
    priority: 'high'
  },
  {
    name: 'One Useful Thing',
    url: 'https://www.oneusefulthing.org/feed',
    author: 'Ethan Mollick',
    tags: ['applications', 'business', 'education'],
    priority: 'high'
  },
  {
    name: 'Ahead of AI',
    url: 'https://magazine.sebastianraschka.com/feed',
    author: 'Sebastian Raschka',
    tags: ['papers', 'technical', 'llm'],
    priority: 'high'
  },
  {
    name: 'AI Guide',
    url: 'https://aiguide.substack.com/feed',
    author: 'Melanie Mitchell',
    tags: ['conceptual', 'critique', 'understanding'],
    priority: 'medium'
  },
  {
    name: 'Gary Marcus',
    url: 'https://garymarcus.substack.com/feed',
    author: 'Gary Marcus',
    tags: ['critique', 'limitations', 'agi'],
    priority: 'high'
  },
  {
    name: 'Latent Space',
    url: 'https://www.latent.space/feed',
    author: 'swyx + Alessio',
    tags: ['engineering', 'agents', 'practical'],
    priority: 'high'
  },
  // Type B: Ghost
  {
    name: 'Bounded Regret',
    url: 'https://bounded-regret.ghost.io/rss/',
    author: 'Jacob Steinhardt',
    tags: ['safety', 'forecasting', 'technical'],
    priority: 'medium'
  },
  // Type C: Custom
  {
    name: 'The Gradient',
    url: 'https://thegradient.pub/feed/',
    author: 'Multiple',
    tags: ['research', 'interviews', 'academic'],
    priority: 'high'
  },
  {
    name: 'SemiAnalysis',
    url: 'https://www.semianalysis.com/feed',
    author: 'Dylan Patel',
    tags: ['hardware', 'chips', 'infrastructure'],
    priority: 'high'
  }
];

const parser = new Parser({
  customFields: {
    item: [
      ['content:encoded', 'fullContent'],
      ['dc:creator', 'author']
    ]
  }
});

async function fetchAllSubstacks() {
  const results = [];
  
  for (const source of SUBSTACK_SOURCES) {
    try {
      const feed = await parser.parseURL(source.url);
      
      for (const item of feed.items.slice(0, 10)) { // Last 10 posts
        results.push({
          source: source.name,
          sourceUrl: source.url,
          author: source.author,
          tags: source.tags,
          priority: source.priority,
          title: item.title,
          link: item.link,
          pubDate: item.pubDate || item.isoDate,
          content: item.fullContent || item.content || item.contentSnippet,
          guid: item.guid || item.link
        });
      }
    } catch (e) {
      console.error(`Failed to fetch ${source.name}: ${e.message}`);
    }
  }
  
  return results;
}
```

### Parsing Strategy

```javascript
// substack-parser.js
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

async function parseSubstackPost(post) {
  // Clean HTML content
  const dom = new JSDOM(post.content, { url: post.link });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();
  
  // Extract clean text
  const cleanText = article?.textContent || stripHtml(post.content);
  
  // Estimate reading time
  const wordCount = cleanText.split(/\s+/).length;
  const readingTime = Math.ceil(wordCount / 200);
  
  // Extract links and references
  const links = extractLinks(post.content);
  const arxivRefs = cleanText.match(/\d{4}\.\d{4,5}/g) || [];
  const twitterRefs = cleanText.match(/@\w+/g) || [];
  
  return {
    id: generateId(post.guid),
    source: post.source,
    author: post.author,
    title: post.title,
    url: post.link,
    publishedAt: new Date(post.pubDate),
    wordCount,
    readingTime,
    tags: post.tags,
    priority: post.priority,
    
    // Content
    rawHtml: post.content,
    cleanText,
    
    // Extracted entities
    links,
    arxivRefs,
    twitterRefs,
    
    // For LLM processing
    needsExtraction: true,
    extractionPrompt: buildExtractionPrompt(post.source)
  };
}

function buildExtractionPrompt(sourceName) {
  const prompts = {
    'Import AI': `Extract: (1) Key research papers discussed, (2) Policy developments, (3) Industry moves, (4) Jack Clark's commentary/predictions`,
    'Interconnects': `Extract: (1) RLHF/alignment insights, (2) Open-source model updates, (3) Technical claims about training, (4) Industry analysis`,
    'AI Snake Oil': `Extract: (1) Specific AI hype being debunked, (2) Evidence presented, (3) Counter-claims to mainstream narratives`,
    'Gary Marcus': `Extract: (1) Specific critiques of current AI, (2) Predictions/claims being challenged, (3) Alternative approaches suggested`,
    default: `Extract: (1) Main claims/arguments, (2) Predictions about AI, (3) Critiques of existing approaches, (4) Novel insights`
  };
  
  return prompts[sourceName] || prompts.default;
}
```

---

## 3. YouTube Channels

### Source Disambiguation

```
┌─────────────────────────────────────────────────────────────┐
│                   YOUTUBE SOURCES                            │
├─────────────────────────────────────────────────────────────┤
│  Type A: Paper Reviews (highest signal density)             │
│  • Yannic Kilcher, AI Explained, Two Minute Papers          │
│                                                              │
│  Type B: Long-form Interviews (need transcript)             │
│  • Lex Fridman, Dwarkesh Patel, Machine Learning Street Talk│
│                                                              │
│  Type C: Tutorials (lower priority for intel)               │
│  • Andrej Karpathy, 3Blue1Brown, StatQuest                  │
│                                                              │
│  Type D: News/Analysis                                      │
│  • AI Explained, Matthew Berman                             │
└─────────────────────────────────────────────────────────────┘
```

### Fetching Strategy

```javascript
// youtube-fetcher.js

const YOUTUBE_CHANNELS = [
  // Type A: Paper Reviews - check daily
  {
    name: 'Yannic Kilcher',
    channelId: 'UCZHmQk67mN31VnFPpr7n0pg',
    rssUrl: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCZHmQk67mN31VnFPpr7n0pg',
    type: 'paper_review',
    checkInterval: 86400, // daily
    needsTranscript: true,
    priority: 'high'
  },
  {
    name: 'AI Explained',
    channelId: 'UCNF_USPgmnHeGpzAyj_JGvQ',
    rssUrl: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCNF_USPgmnHeGpzAyj_JGvQ',
    type: 'analysis',
    checkInterval: 86400,
    needsTranscript: true,
    priority: 'high'
  },
  {
    name: 'Two Minute Papers',
    channelId: 'UCbfYPyITQ-7l4upoX8nvctg',
    rssUrl: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCbfYPyITQ-7l4upoX8nvctg',
    type: 'paper_review',
    checkInterval: 86400,
    needsTranscript: false, // Short enough to parse title/description
    priority: 'medium'
  },
  // Type B: Long-form Interviews
  {
    name: 'Lex Fridman',
    channelId: 'UCSHZKyawb77ixDdsGog4iWA',
    rssUrl: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCSHZKyawb77ixDdsGog4iWA',
    type: 'interview',
    checkInterval: 86400,
    needsTranscript: true,
    filterKeywords: ['AI', 'machine learning', 'OpenAI', 'Anthropic', 'DeepMind', 'AGI'],
    priority: 'high'
  },
  {
    name: 'Dwarkesh Patel',
    channelId: 'UC-K2grEOxsUJc6cxqVMDLsg',
    rssUrl: 'https://www.youtube.com/feeds/videos.xml?channel_id=UC-K2grEOxsUJc6cxqVMDLsg',
    type: 'interview',
    checkInterval: 86400,
    needsTranscript: true,
    priority: 'high'
  },
  {
    name: 'Machine Learning Street Talk',
    channelId: 'UCMLtBahI5DMrt0NPvDSoIRQ',
    rssUrl: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCMLtBahI5DMrt0NPvDSoIRQ',
    type: 'interview',
    checkInterval: 86400,
    needsTranscript: true,
    priority: 'high'
  },
  // Type C: Educational (lower priority for intel)
  {
    name: 'Andrej Karpathy',
    channelId: 'UCWN3xxRkmTPmbKwht9FuE5A',
    rssUrl: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCWN3xxRkmTPmbKwht9FuE5A',
    type: 'educational',
    checkInterval: 604800, // weekly
    needsTranscript: true,
    priority: 'medium'
  }
];

// RSS fetch for new videos
async function fetchYouTubeRSS(channel) {
  const parser = new Parser();
  const feed = await parser.parseURL(channel.rssUrl);
  
  return feed.items.map(item => ({
    channelName: channel.name,
    channelId: channel.channelId,
    videoId: extractVideoId(item.link),
    title: item.title,
    description: item.contentSnippet,
    publishedAt: item.pubDate,
    link: item.link,
    type: channel.type,
    needsTranscript: channel.needsTranscript,
    priority: channel.priority
  }));
}

// Transcript fetching via yt-dlp
async function fetchTranscript(videoId) {
  const { exec } = require('child_process');
  
  return new Promise((resolve, reject) => {
    exec(
      `yt-dlp --write-auto-sub --sub-lang en --skip-download --sub-format vtt -o "/tmp/%(id)s" "https://www.youtube.com/watch?v=${videoId}"`,
      async (error, stdout, stderr) => {
        if (error) {
          // Fallback: try to get from YouTube's timedtext API
          resolve(await fetchTranscriptFallback(videoId));
          return;
        }
        
        const vttPath = `/tmp/${videoId}.en.vtt`;
        const transcript = await parseVTT(vttPath);
        resolve(transcript);
      }
    );
  });
}

// Alternative: youtube-transcript library
async function fetchTranscriptFallback(videoId) {
  const { YoutubeTranscript } = require('youtube-transcript');
  
  try {
    const transcript = await YoutubeTranscript.fetchTranscript(videoId);
    return transcript.map(t => t.text).join(' ');
  } catch (e) {
    return null;
  }
}
```

### Parsing Strategy

```javascript
// youtube-parser.js

async function parseYouTubeVideo(video) {
  let transcript = null;
  
  if (video.needsTranscript) {
    transcript = await fetchTranscript(video.videoId);
  }
  
  // For interviews, identify the guest
  const guest = video.type === 'interview' 
    ? extractGuestFromTitle(video.title) 
    : null;
  
  // Check if AI-relevant (for channels like Lex Fridman that cover many topics)
  const isAIRelevant = checkAIRelevance(video.title, video.description, transcript);
  
  if (!isAIRelevant && video.type === 'interview') {
    return null; // Skip non-AI episodes
  }
  
  return {
    id: video.videoId,
    channel: video.channelName,
    channelId: video.channelId,
    type: video.type,
    title: video.title,
    description: video.description,
    url: video.link,
    publishedAt: new Date(video.publishedAt),
    priority: video.priority,
    
    // Content
    transcript,
    transcriptWordCount: transcript ? transcript.split(/\s+/).length : 0,
    
    // Metadata
    guest,
    isAIRelevant,
    
    // For LLM processing
    needsExtraction: !!transcript,
    extractionPrompt: buildVideoExtractionPrompt(video.type, guest)
  };
}

function extractGuestFromTitle(title) {
  // Common patterns: "Guest Name: Topic" or "Topic with Guest Name" or "#123 - Guest Name"
  const patterns = [
    /^(.+?):\s/,                    // "Ilya Sutskever: Deep Learning"
    /with\s+(.+?)(?:\s*[-–|]|$)/i,  // "AI with Demis Hassabis"
    /#\d+\s*[-–]\s*(.+?)(?:\s*[-–|]|$)/, // "#452 - Dario Amodei"
    /\|\s*(.+?)$/                   // "Topic | Guest Name"
  ];
  
  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (match) return match[1].trim();
  }
  
  return null;
}

function checkAIRelevance(title, description, transcript) {
  const keywords = [
    'AI', 'artificial intelligence', 'machine learning', 'deep learning',
    'neural network', 'LLM', 'GPT', 'transformer', 'OpenAI', 'Anthropic',
    'DeepMind', 'AGI', 'alignment', 'ChatGPT', 'Claude', 'Gemini'
  ];
  
  const text = `${title} ${description} ${transcript || ''}`.toLowerCase();
  return keywords.some(kw => text.includes(kw.toLowerCase()));
}

function buildVideoExtractionPrompt(type, guest) {
  if (type === 'interview' && guest) {
    return `Extract from this interview with ${guest}:
(1) Key claims about AI capabilities/progress
(2) Predictions with timelines
(3) Critiques of current approaches
(4) Hints about unpublished work
(5) Disagreements with mainstream views`;
  }
  
  if (type === 'paper_review') {
    return `Extract:
(1) Paper title and key contribution
(2) Reviewer's assessment (positive/negative/mixed)
(3) Implications for the field
(4) Limitations noted`;
  }
  
  return `Extract key claims, predictions, and insights about AI progress.`;
}
```

---

## 4. Personal & Lab Blogs

### Source Disambiguation

```
┌─────────────────────────────────────────────────────────────┐
│                      BLOG SOURCES                            │
├─────────────────────────────────────────────────────────────┤
│  Type A: RSS-enabled Personal Blogs                         │
│  • colah.github.io, lilianweng.github.io, karpathy.github.io│
│  • Usually have /feed, /atom.xml, or /rss.xml               │
│                                                              │
│  Type B: Lab Research Blogs (need scraping)                 │
│  • anthropic.com/research, openai.com/blog                  │
│  • deepmind.google/discover/blog, ai.meta.com/blog          │
│                                                              │
│  Type C: Static Sites (need sitemap/scraping)               │
│  • rodenybrooks.com, scottaaronson.blog                     │
└─────────────────────────────────────────────────────────────┘
```

### Fetching Strategy

```javascript
// blog-fetcher.js

const BLOG_SOURCES = [
  // Type A: RSS-enabled personal blogs
  {
    name: "Lil'Log",
    url: 'https://lilianweng.github.io',
    rssUrl: 'https://lilianweng.github.io/index.xml',
    author: 'Lilian Weng',
    type: 'personal',
    priority: 'high',
    tags: ['technical', 'tutorials', 'agents', 'rl']
  },
  {
    name: "colah's blog",
    url: 'https://colah.github.io',
    rssUrl: 'https://colah.github.io/rss.xml',
    author: 'Chris Olah',
    type: 'personal',
    priority: 'high',
    tags: ['interpretability', 'visualization', 'neural-nets']
  },
  {
    name: 'Jay Alammar',
    url: 'https://jalammar.github.io',
    rssUrl: 'https://jalammar.github.io/feed.xml',
    author: 'Jay Alammar',
    type: 'personal',
    priority: 'high',
    tags: ['visualization', 'transformers', 'educational']
  },
  {
    name: 'Sebastian Ruder',
    url: 'https://ruder.io',
    rssUrl: 'https://ruder.io/rss/index.rss',
    author: 'Sebastian Ruder',
    type: 'personal',
    priority: 'high',
    tags: ['nlp', 'transfer-learning', 'multilingual']
  },
  {
    name: 'Rodney Brooks',
    url: 'https://rodneybrooks.com',
    rssUrl: 'https://rodneybrooks.com/feed/',
    author: 'Rodney Brooks',
    type: 'personal',
    priority: 'high',
    tags: ['robotics', 'predictions', 'critique']
  },
  
  // Type B: Lab blogs (need specialized scraping)
  {
    name: 'Anthropic Research',
    url: 'https://www.anthropic.com/research',
    rssUrl: null, // No RSS
    type: 'lab',
    priority: 'high',
    scrapeConfig: {
      listSelector: 'article, .research-post, [class*="post"]',
      titleSelector: 'h1, h2, .title',
      linkSelector: 'a[href*="/research/"]',
      dateSelector: 'time, .date, [class*="date"]'
    },
    tags: ['safety', 'interpretability', 'constitutional-ai']
  },
  {
    name: 'OpenAI Blog',
    url: 'https://openai.com/blog',
    rssUrl: null,
    type: 'lab',
    priority: 'high',
    scrapeConfig: {
      listSelector: '[class*="post"], article',
      titleSelector: 'h1, h2',
      linkSelector: 'a[href*="/blog/"], a[href*="/index/"]'
    },
    tags: ['releases', 'research', 'policy']
  },
  {
    name: 'Google DeepMind Blog',
    url: 'https://deepmind.google/discover/blog/',
    rssUrl: null,
    type: 'lab',
    priority: 'high',
    tags: ['alphafold', 'gemini', 'research']
  },
  {
    name: 'Google AI Blog',
    url: 'https://ai.googleblog.com',
    rssUrl: 'https://ai.googleblog.com/feeds/posts/default',
    type: 'lab',
    priority: 'high',
    tags: ['research', 'products', 'technical']
  },
  {
    name: 'Meta AI Blog',
    url: 'https://ai.meta.com/blog/',
    rssUrl: null,
    type: 'lab',
    priority: 'high',
    tags: ['llama', 'open-source', 'research']
  }
];

// RSS fetching for Type A blogs
async function fetchBlogRSS(source) {
  if (!source.rssUrl) return null;
  
  const parser = new Parser();
  const feed = await parser.parseURL(source.rssUrl);
  
  return feed.items.map(item => ({
    source: source.name,
    author: source.author,
    title: item.title,
    url: item.link,
    publishedAt: item.pubDate,
    content: item.content || item.contentSnippet,
    tags: source.tags,
    priority: source.priority
  }));
}

// Scraping for Type B lab blogs
async function scrapeLabBlog(source) {
  const { chromium } = require('playwright');
  
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto(source.url, { waitUntil: 'networkidle' });
  
  const posts = await page.evaluate((config) => {
    const items = document.querySelectorAll(config.listSelector);
    return Array.from(items).slice(0, 20).map(item => {
      const titleEl = item.querySelector(config.titleSelector);
      const linkEl = item.querySelector(config.linkSelector);
      const dateEl = item.querySelector(config.dateSelector);
      
      return {
        title: titleEl?.textContent?.trim(),
        url: linkEl?.href,
        date: dateEl?.textContent?.trim() || dateEl?.getAttribute('datetime')
      };
    }).filter(p => p.title && p.url);
  }, source.scrapeConfig);
  
  await browser.close();
  
  return posts.map(p => ({
    source: source.name,
    title: p.title,
    url: p.url,
    publishedAt: p.date,
    tags: source.tags,
    priority: source.priority,
    needsFullFetch: true
  }));
}

// Full article fetching
async function fetchFullArticle(url) {
  const { JSDOM } = require('jsdom');
  const { Readability } = require('@mozilla/readability');
  
  const response = await fetch(url);
  const html = await response.text();
  
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();
  
  return {
    title: article?.title,
    content: article?.textContent,
    html: article?.content,
    wordCount: article?.textContent?.split(/\s+/).length || 0
  };
}
```

---

## 5. Podcasts

### Source Disambiguation

```
┌─────────────────────────────────────────────────────────────┐
│                   PODCAST SOURCES                            │
├─────────────────────────────────────────────────────────────┤
│  Type A: Has transcript service                             │
│  • Lex Fridman (lexfridman.com has transcripts)            │
│  • Dwarkesh (usually posts transcripts)                     │
│                                                              │
│  Type B: Audio-only (need Whisper transcription)           │
│  • AXRP, Latent Space, 80,000 Hours                        │
│                                                              │
│  Content Types:                                              │
│  • Research interviews (highest signal)                     │
│  • Industry discussions                                     │
│  • Technical deep-dives                                     │
└─────────────────────────────────────────────────────────────┘
```

### Fetching Strategy

```javascript
// podcast-fetcher.js

const PODCAST_SOURCES = [
  {
    name: 'Lex Fridman Podcast',
    rssUrl: 'https://lexfridman.com/feed/podcast/',
    transcriptSource: 'website', // lexfridman.com/EPISODE
    filterKeywords: ['AI', 'machine learning', 'OpenAI', 'Anthropic', 'DeepMind'],
    priority: 'high',
    tags: ['interviews', 'long-form']
  },
  {
    name: 'Dwarkesh Podcast',
    rssUrl: 'https://feeds.libsyn.com/468258/rss',
    transcriptSource: 'website', // Often posts on dwarkeshpatel.com
    priority: 'high',
    tags: ['interviews', 'technical', 'ai-focused']
  },
  {
    name: 'Machine Learning Street Talk',
    rssUrl: 'https://anchor.fm/s/1e4a0eac/podcast/rss',
    transcriptSource: 'whisper',
    priority: 'high',
    tags: ['technical', 'papers', 'debates']
  },
  {
    name: 'AXRP',
    rssUrl: 'https://axrp.net/feed.xml',
    transcriptSource: 'website', // axrp.net has transcripts
    priority: 'high',
    tags: ['safety', 'alignment', 'technical']
  },
  {
    name: 'Latent Space',
    rssUrl: 'https://api.substack.com/feed/podcast/1084089.rss',
    transcriptSource: 'whisper',
    priority: 'high',
    tags: ['engineering', 'agents', 'practical']
  },
  {
    name: '80,000 Hours',
    rssUrl: 'https://feeds.buzzsprout.com/802285.rss',
    transcriptSource: 'website', // 80000hours.org has transcripts
    filterKeywords: ['AI', 'artificial intelligence', 'alignment', 'safety'],
    priority: 'medium',
    tags: ['safety', 'careers', 'ea']
  },
  {
    name: 'The Cognitive Revolution',
    rssUrl: 'https://feeds.transistor.fm/the-cognitive-revolution-ai-builders-researchers-and-live-players',
    transcriptSource: 'whisper',
    priority: 'medium',
    tags: ['applications', 'interviews']
  }
];

async function fetchPodcastEpisodes(source) {
  const parser = new Parser();
  const feed = await parser.parseURL(source.rssUrl);
  
  let episodes = feed.items.map(item => ({
    source: source.name,
    title: item.title,
    url: item.link,
    audioUrl: item.enclosure?.url,
    publishedAt: item.pubDate,
    description: item.contentSnippet,
    duration: item.itunes?.duration,
    tags: source.tags,
    priority: source.priority,
    transcriptSource: source.transcriptSource
  }));
  
  // Filter by keywords if specified
  if (source.filterKeywords) {
    episodes = episodes.filter(ep => 
      source.filterKeywords.some(kw => 
        ep.title?.toLowerCase().includes(kw.toLowerCase()) ||
        ep.description?.toLowerCase().includes(kw.toLowerCase())
      )
    );
  }
  
  return episodes;
}

// Whisper transcription for audio-only podcasts
async function transcribeWithWhisper(audioUrl, episodeId) {
  const { exec } = require('child_process');
  const audioPath = `/tmp/podcast_${episodeId}.mp3`;
  const transcriptPath = `/tmp/podcast_${episodeId}.txt`;
  
  // Download audio
  await downloadFile(audioUrl, audioPath);
  
  // Transcribe with Whisper
  return new Promise((resolve, reject) => {
    exec(
      `whisper "${audioPath}" --model medium --output_format txt --output_dir /tmp/`,
      { maxBuffer: 1024 * 1024 * 100 }, // 100MB buffer for long transcripts
      (error) => {
        if (error) {
          reject(error);
          return;
        }
        
        const transcript = fs.readFileSync(transcriptPath, 'utf-8');
        
        // Cleanup
        fs.unlinkSync(audioPath);
        fs.unlinkSync(transcriptPath);
        
        resolve(transcript);
      }
    );
  });
}

// Fetch transcript from website (Lex Fridman style)
async function fetchWebsiteTranscript(episodeUrl, source) {
  // Different sources have different transcript locations
  const transcriptStrategies = {
    'Lex Fridman Podcast': async (url) => {
      // Lex posts transcripts on lexfridman.com/EPISODE-NUMBER
      const response = await fetch(url);
      const html = await response.text();
      const dom = new JSDOM(html);
      const transcript = dom.window.document.querySelector('.transcript, #transcript');
      return transcript?.textContent;
    },
    'AXRP': async (url) => {
      // AXRP has transcripts inline
      const response = await fetch(url);
      const html = await response.text();
      const dom = new JSDOM(html);
      const content = dom.window.document.querySelector('.post-content, article');
      return content?.textContent;
    }
  };
  
  const strategy = transcriptStrategies[source];
  if (strategy) {
    return await strategy(episodeUrl);
  }
  
  return null;
}
```

---

## 6. arXiv / Academic Sources

### Fetching Strategy

```javascript
// arxiv-fetcher.js

const ARXIV_CATEGORIES = [
  'cs.AI',    // Artificial Intelligence
  'cs.LG',    // Machine Learning
  'cs.CL',    // Computation and Language
  'cs.CV',    // Computer Vision
  'cs.NE',    // Neural and Evolutionary Computing
  'stat.ML'   // Statistics - Machine Learning
];

// Watch for papers from tracked authors
const TRACKED_AUTHORS = [
  'Yann LeCun',
  'Geoffrey Hinton',
  'Yoshua Bengio',
  'Ilya Sutskever',
  'Dario Amodei',
  'Chris Olah',
  // ... add all researchers from the list
];

async function fetchArxivPapers(daysBack = 7) {
  const papers = [];
  
  for (const category of ARXIV_CATEGORIES) {
    const url = `http://export.arxiv.org/api/query?` +
      `search_query=cat:${category}` +
      `&start=0&max_results=100` +
      `&sortBy=submittedDate&sortOrder=descending`;
    
    const response = await fetch(url);
    const xml = await response.text();
    
    const parsed = await parseArxivXML(xml);
    papers.push(...parsed);
  }
  
  // Filter for tracked authors
  const authorPapers = papers.filter(p => 
    p.authors.some(a => TRACKED_AUTHORS.includes(a))
  );
  
  // Filter for high-relevance keywords
  const keywordPapers = papers.filter(p => 
    hasHighRelevanceKeywords(p.title + ' ' + p.abstract)
  );
  
  return {
    authorPapers,
    keywordPapers,
    allPapers: papers
  };
}

function hasHighRelevanceKeywords(text) {
  const highRelevance = [
    'scaling law', 'emergent', 'alignment', 'RLHF',
    'chain-of-thought', 'in-context learning', 'instruction tuning',
    'constitutional AI', 'interpretability', 'mechanistic',
    'world model', 'reasoning', 'agent'
  ];
  
  return highRelevance.some(kw => 
    text.toLowerCase().includes(kw.toLowerCase())
  );
}

async function parseArxivXML(xml) {
  const { XMLParser } = require('fast-xml-parser');
  const parser = new XMLParser();
  const result = parser.parse(xml);
  
  const entries = result.feed.entry || [];
  
  return entries.map(entry => ({
    id: entry.id.split('/').pop(),
    title: entry.title.replace(/\s+/g, ' ').trim(),
    abstract: entry.summary.replace(/\s+/g, ' ').trim(),
    authors: Array.isArray(entry.author) 
      ? entry.author.map(a => a.name)
      : [entry.author.name],
    categories: Array.isArray(entry.category)
      ? entry.category.map(c => c['@_term'])
      : [entry.category['@_term']],
    publishedAt: entry.published,
    updatedAt: entry.updated,
    pdfUrl: entry.link.find(l => l['@_title'] === 'pdf')?.['@_href'],
    absUrl: entry.id
  }));
}
```

---

## 7. LessWrong / AI Alignment Forum

### Fetching Strategy

```javascript
// lesswrong-fetcher.js

const LW_GRAPHQL_ENDPOINT = 'https://www.lesswrong.com/graphql';
const AF_GRAPHQL_ENDPOINT = 'https://www.alignmentforum.org/graphql';

async function fetchLessWrongPosts(daysBack = 7) {
  const query = `
    query RecentPosts($after: Date) {
      posts(input: {
        terms: {
          after: $after
          view: "new"
          limit: 50
        }
      }) {
        results {
          _id
          title
          slug
          postedAt
          baseScore
          voteCount
          commentCount
          wordCount
          author {
            displayName
            username
          }
          tags {
            name
          }
          contents {
            html
          }
        }
      }
    }
  `;
  
  const afterDate = new Date();
  afterDate.setDate(afterDate.getDate() - daysBack);
  
  const response = await fetch(LW_GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      variables: { after: afterDate.toISOString() }
    })
  });
  
  const data = await response.json();
  return data.data.posts.results;
}

async function fetchAlignmentForumPosts(daysBack = 7) {
  // Same query structure, different endpoint
  const query = `
    query RecentAFPosts($after: Date) {
      posts(input: {
        terms: {
          after: $after
          view: "new"
          limit: 50
          af: true
        }
      }) {
        results {
          _id
          title
          slug
          postedAt
          baseScore
          voteCount
          commentCount
          wordCount
          author {
            displayName
          }
          tags {
            name
          }
          contents {
            html
          }
        }
      }
    }
  `;
  
  const afterDate = new Date();
  afterDate.setDate(afterDate.getDate() - daysBack);
  
  const response = await fetch(AF_GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      variables: { after: afterDate.toISOString() }
    })
  });
  
  const data = await response.json();
  return data.data.posts.results;
}

// Filter for high-signal posts
function filterHighSignalPosts(posts) {
  return posts.filter(post => {
    // High karma threshold
    if (post.baseScore >= 50) return true;
    
    // From known authors
    const knownAuthors = [
      'Eliezer Yudkowsky', 'Paul Christiano', 'Scott Alexander',
      'Evan Hubinger', 'John Wentworth', 'Neel Nanda'
    ];
    if (knownAuthors.includes(post.author.displayName)) return true;
    
    // Has relevant tags
    const relevantTags = ['AI', 'alignment', 'interpretability', 'safety'];
    if (post.tags?.some(t => relevantTags.includes(t.name))) return true;
    
    return false;
  });
}
```

---

## 8. Unified Orchestration

### Scheduler Configuration

```javascript
// scheduler.js

const schedule = require('node-schedule');

const FETCH_SCHEDULES = {
  // High-frequency sources
  twitter: {
    sTier: '*/2 * * * *',    // Every 2 hours
    aTier: '0 */6 * * *',    // Every 6 hours
    bTier: '0 0 * * *'       // Daily
  },
  
  // Medium-frequency
  substack: '0 6,18 * * *',   // Twice daily
  youtube: '0 */4 * * *',     // Every 4 hours
  arxiv: '0 8 * * *',         // Daily at 8am
  
  // Low-frequency
  blogs: '0 0 * * *',         // Daily
  podcasts: '0 0 * * 1',      // Weekly (Monday)
  lesswrong: '0 12 * * *'     // Daily at noon
};

async function runScheduler() {
  // Twitter S-Tier
  schedule.scheduleJob(FETCH_SCHEDULES.twitter.sTier, async () => {
    console.log('Fetching S-Tier Twitter accounts...');
    await fetchTwitterAccounts('s');
  });
  
  // Substacks
  schedule.scheduleJob(FETCH_SCHEDULES.substack, async () => {
    console.log('Fetching Substacks...');
    await fetchAllSubstacks();
  });
  
  // YouTube
  schedule.scheduleJob(FETCH_SCHEDULES.youtube, async () => {
    console.log('Fetching YouTube channels...');
    await fetchAllYouTubeChannels();
  });
  
  // ... etc
}
```

### Unified Storage Schema

```sql
-- PostgreSQL schema for all sources

-- Unified content table
CREATE TABLE content (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL, -- 'twitter', 'substack', 'youtube', etc.
  source_name TEXT NOT NULL,
  author TEXT,
  title TEXT,
  url TEXT NOT NULL,
  published_at TIMESTAMPTZ,
  fetched_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Content
  raw_content TEXT,
  clean_text TEXT,
  word_count INTEGER,
  
  -- Classification
  content_type TEXT, -- 'tweet', 'thread', 'article', 'video', 'paper'
  priority TEXT,
  tags TEXT[],
  
  -- Signals
  signal_score FLOAT,
  has_prediction BOOLEAN DEFAULT FALSE,
  has_hint BOOLEAN DEFAULT FALSE,
  has_critique BOOLEAN DEFAULT FALSE,
  has_paper_ref BOOLEAN DEFAULT FALSE,
  
  -- LLM extraction
  extracted_claims JSONB,
  extraction_status TEXT DEFAULT 'pending',
  
  -- Vector search
  embedding vector(1536),
  
  -- Metadata
  raw_json JSONB
);

-- Extracted claims table
CREATE TABLE claims (
  id SERIAL PRIMARY KEY,
  content_id TEXT REFERENCES content(id),
  claim_type TEXT, -- 'prediction', 'hint', 'critique', 'fact'
  claim_text TEXT NOT NULL,
  confidence FLOAT,
  topic TEXT,
  entities TEXT[],
  source_quote TEXT,
  extracted_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- For tracking
  verified BOOLEAN,
  verified_at TIMESTAMPTZ,
  outcome TEXT -- 'correct', 'incorrect', 'pending', 'unfalsifiable'
);

-- Topic consensus tracking
CREATE TABLE topic_consensus (
  id SERIAL PRIMARY KEY,
  topic TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Bull/bear sentiment
  lab_sentiment FLOAT, -- -1 to 1
  critic_sentiment FLOAT,
  hype_delta FLOAT, -- lab - critic
  
  -- Supporting claims
  bull_claim_ids INTEGER[],
  bear_claim_ids INTEGER[],
  
  -- Trend
  sentiment_7d_change FLOAT,
  sentiment_30d_change FLOAT
);

-- Indexes
CREATE INDEX idx_content_source ON content(source_type, source_name);
CREATE INDEX idx_content_published ON content(published_at DESC);
CREATE INDEX idx_content_signal ON content(signal_score DESC);
CREATE INDEX idx_content_type ON content(content_type);
CREATE INDEX idx_content_embedding ON content USING ivfflat (embedding vector_cosine_ops);

CREATE INDEX idx_claims_content ON claims(content_id);
CREATE INDEX idx_claims_type ON claims(claim_type);
CREATE INDEX idx_claims_topic ON claims(topic);
```

### LLM Extraction Pipeline

```javascript
// extraction-pipeline.js

const EXTRACTION_PROMPT = `You are analyzing content from AI researchers and commentators.

Content from: {source_name} by {author}
Content type: {content_type}
Published: {published_at}

<content>
{content}
</content>

Extract the following as JSON:

{
  "claims": [
    {
      "type": "prediction|hint|critique|fact|opinion",
      "text": "The extracted claim in clear, standalone language",
      "confidence": 0.0-1.0, // How confident the author seems
      "hedging": "none|mild|heavy",
      "timeline": "specific date or timeframe if mentioned",
      "topic": "scaling|reasoning|safety|agents|multimodal|infrastructure|...",
      "entities": ["mentioned companies, people, or models"],
      "source_quote": "The exact quote this was extracted from"
    }
  ],
  "overall_stance": "bullish|bearish|neutral|mixed",
  "key_topics": ["list of main topics discussed"],
  "novelty": 0.0-1.0, // How novel/surprising are the claims
  "summary": "2-3 sentence summary of the key points"
}

Focus on:
- Predictions about AI capabilities or timelines
- Hints about unpublished or upcoming work
- Critiques of current approaches or claims
- Disagreements with mainstream views
- Novel technical insights

Be conservative - only extract claims that are clearly stated or strongly implied.`;

async function extractClaims(content) {
  const prompt = EXTRACTION_PROMPT
    .replace('{source_name}', content.source_name)
    .replace('{author}', content.author)
    .replace('{content_type}', content.content_type)
    .replace('{published_at}', content.published_at)
    .replace('{content}', content.clean_text.slice(0, 12000)); // Token limit
  
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }]
  });
  
  try {
    const extraction = JSON.parse(response.content[0].text);
    return extraction;
  } catch (e) {
    console.error('Failed to parse extraction:', e);
    return null;
  }
}
```

---

## Rate Limiting & Error Handling

```javascript
// rate-limiter.js

const Bottleneck = require('bottleneck');

// Different limiters for different sources
const limiters = {
  twitter: new Bottleneck({
    maxConcurrent: 1,
    minTime: 2000 // 2 seconds between requests
  }),
  
  youtube: new Bottleneck({
    maxConcurrent: 3,
    minTime: 1000
  }),
  
  substack: new Bottleneck({
    maxConcurrent: 5,
    minTime: 500
  }),
  
  blogs: new Bottleneck({
    maxConcurrent: 10,
    minTime: 200
  }),
  
  llm: new Bottleneck({
    maxConcurrent: 5,
    minTime: 100
  })
};

// Retry logic with exponential backoff
async function fetchWithRetry(fn, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === maxRetries - 1) throw e;
      
      const delay = Math.pow(2, i) * 1000 + Math.random() * 1000;
      console.log(`Retry ${i + 1}/${maxRetries} after ${delay}ms: ${e.message}`);
      await sleep(delay);
    }
  }
}

// Circuit breaker for failing sources
const circuitBreakers = new Map();

function getCircuitBreaker(sourceId) {
  if (!circuitBreakers.has(sourceId)) {
    circuitBreakers.set(sourceId, {
      failures: 0,
      lastFailure: null,
      isOpen: false
    });
  }
  return circuitBreakers.get(sourceId);
}

function recordFailure(sourceId) {
  const cb = getCircuitBreaker(sourceId);
  cb.failures++;
  cb.lastFailure = Date.now();
  
  if (cb.failures >= 5) {
    cb.isOpen = true;
    console.log(`Circuit breaker OPEN for ${sourceId}`);
    
    // Reset after 30 minutes
    setTimeout(() => {
      cb.isOpen = false;
      cb.failures = 0;
      console.log(`Circuit breaker RESET for ${sourceId}`);
    }, 30 * 60 * 1000);
  }
}

function canFetch(sourceId) {
  const cb = getCircuitBreaker(sourceId);
  return !cb.isOpen;
}
```

---

## Quick Reference: Source → Method Matrix

| Source | Primary Method | Fallback | Auth | Rate Limit | Parse Complexity |
|--------|---------------|----------|------|------------|------------------|
| Twitter | Nitter RSS | yt-dlp → Playwright | No → Maybe | High | Medium |
| Substack | RSS Parser | Direct fetch | No | Low | Low |
| YouTube | RSS + yt-dlp | youtube-transcript | No | Medium | Medium |
| Personal Blogs | RSS Parser | Readability scrape | No | Low | Low |
| Lab Blogs | Playwright scrape | Direct fetch | No | Low | Medium |
| Podcasts | RSS + Whisper | Website transcripts | No | Low | High |
| arXiv | API | - | No | Low | Low |
| LessWrong | GraphQL API | - | No | Low | Low |
