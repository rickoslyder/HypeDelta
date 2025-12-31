# AI Intelligence Aggregator: Content Fetching & Parsing Strategy

## Source Type Matrix

| Source Type | Primary Method | Fallback | Auth Required | Rate Limits | Content Structure |
|-------------|---------------|----------|---------------|-------------|-------------------|
| Twitter/X | Nitter RSS | yt-dlp / Playwright | No (Nitter) | Instance-dependent | Short-form, threads |
| Substack | Native RSS | Web scrape | No | Generous | Long-form articles |
| YouTube | yt-dlp + transcripts | Official API | No / API key | 10K/day (API) | Video transcripts |
| Personal Blogs | RSS/Atom | Trafilatura scrape | No | None | Long-form articles |
| Lab Blogs | RSS/Atom | Structured scrape | No | None | Research posts |
| Podcasts | RSS feeds | Transcript services | No | None | Audio → text |
| LessWrong/AF | GraphQL API | RSS | No | Generous | Long-form posts |
| arXiv | API + RSS | Direct scrape | No | 3 req/s | Paper abstracts |
| Bluesky | AT Protocol | RSS bridges | No | TBD | Short-form |

---

## 1. Twitter/X

### Strategy Priority
1. **Nitter RSS** (free, no auth, lowest friction)
2. **yt-dlp** (free, robust fallback)
3. **Playwright automation** (full fidelity, session-based)
4. **Direct GraphQL** (fragile, last resort)

### 1.1 Nitter RSS

**Feed URL Pattern:**
```
https://{instance}/{username}/rss
https://{instance}/{username}/with_replies/rss  # includes replies
https://{instance}/{username}/media/rss         # media only
```

**Working Instances (rotate through):**
```javascript
const NITTER_INSTANCES = [
  'nitter.poast.org',
  'nitter.privacydev.net',
  'nitter.woodland.cafe',
  'nitter.1d4.us',
  'nitter.lucabased.xyz',
  'nitter.esmailelbob.xyz'
];
```

**RSS Item Structure:**
```xml
<item>
  <title>@username: Tweet text truncated...</title>
  <dc:creator>@username</dc:creator>
  <description><![CDATA[Full tweet HTML with links, images]]></description>
  <pubDate>Mon, 23 Dec 2024 14:30:00 GMT</pubDate>
  <guid>https://twitter.com/username/status/1234567890</guid>
  <link>https://nitter.instance/username/status/1234567890</link>
</item>
```

**Parsing Strategy:**
```javascript
import Parser from 'rss-parser';
import { JSDOM } from 'jsdom';

async function parseNitterFeed(username) {
  const parser = new Parser({
    customFields: {
      item: ['dc:creator']
    }
  });
  
  for (const instance of NITTER_INSTANCES) {
    try {
      const feed = await parser.parseURL(
        `https://${instance}/${username}/rss`,
        { timeout: 5000 }
      );
      
      return feed.items.map(item => {
        const dom = new JSDOM(item.content);
        const text = dom.window.document.body.textContent.trim();
        
        // Extract tweet ID from guid
        const tweetId = item.guid.split('/status/')[1];
        
        // Detect if it's a thread (has "Show this thread" or self-replies)
        const isThread = item.content.includes('Show this thread');
        
        // Extract quoted tweet if present
        const quotedTweet = dom.window.document.querySelector('.quote');
        
        return {
          id: tweetId,
          author: username,
          text: text,
          html: item.content,
          publishedAt: new Date(item.pubDate),
          url: `https://twitter.com/${username}/status/${tweetId}`,
          isThread,
          hasQuote: !!quotedTweet,
          quotedText: quotedTweet?.textContent?.trim()
        };
      });
    } catch (e) {
      continue; // Try next instance
    }
  }
  throw new Error(`All Nitter instances failed for ${username}`);
}
```

### 1.2 yt-dlp Fallback

**Command:**
```bash
# Get recent tweets as JSON
yt-dlp --flat-playlist -j "https://twitter.com/karpathy" 2>/dev/null | head -50

# With full metadata
yt-dlp --dump-json --flat-playlist --playlist-end 50 "https://twitter.com/karpathy"
```

**Node.js Wrapper:**
```javascript
import { execSync } from 'child_process';

function fetchViaYtdlp(username, limit = 50) {
  try {
    const output = execSync(
      `yt-dlp --flat-playlist -j --playlist-end ${limit} "https://twitter.com/${username}" 2>/dev/null`,
      { maxBuffer: 10 * 1024 * 1024 }
    );
    
    return output
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const data = JSON.parse(line);
        return {
          id: data.id,
          author: username,
          text: data.title,
          publishedAt: data.timestamp ? new Date(data.timestamp * 1000) : null,
          url: data.webpage_url || `https://twitter.com/${username}/status/${data.id}`
        };
      });
  } catch (e) {
    return [];
  }
}
```

### 1.3 Playwright Full Fidelity (Threads, Context)

```javascript
import { chromium } from 'playwright';

async function scrapeTwitterProfile(username, sessionDir = './twitter-session') {
  const browser = await chromium.launchPersistentContext(sessionDir, {
    headless: true,
    viewport: { width: 1280, height: 800 }
  });
  
  const page = await browser.newPage();
  await page.goto(`https://twitter.com/${username}`, { waitUntil: 'networkidle' });
  
  // Scroll to load more tweets
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await page.waitForTimeout(1500);
  }
  
  const tweets = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('article[data-testid="tweet"]')).map(el => {
      const textEl = el.querySelector('[data-testid="tweetText"]');
      const timeEl = el.querySelector('time');
      const linkEl = el.querySelector('a[href*="/status/"]');
      
      // Get engagement metrics
      const metrics = el.querySelector('[role="group"]');
      const [replies, retweets, likes, views] = metrics 
        ? Array.from(metrics.querySelectorAll('[data-testid]')).map(m => m.textContent)
        : [null, null, null, null];
      
      return {
        text: textEl?.innerText || '',
        timestamp: timeEl?.getAttribute('datetime'),
        url: linkEl?.href,
        metrics: { replies, retweets, likes, views }
      };
    });
  });
  
  await browser.close();
  return tweets;
}
```

### Twitter Handle Registry

```javascript
// Organized by category for targeted scraping
const TWITTER_HANDLES = {
  anthropic: ['DarioAmodei', 'ch402', 'AmandaAskell', 'janleike', 'jackclarkSF', 'samsamoa'],
  openai: ['sama', 'karpathy', 'gaborat', 'polynoamial', 'maboriraeti', 'johnschulman2'],
  deepmind: ['demishassabis', 'ShaneLegg', 'JeffDean', 'OriolVinyalsML', 'denny_zhou'],
  meta: ['ylecun', 'hugo_larochelle'],
  xai: ['TheGregYang', 'jimmybyba', 'yuhuaiabwu'],
  mistral: ['arthurmensch', 'GusLample', 'tlacroix_'],
  cohere: ['aidangomez', 'jpineau', 'nickfrosst'],
  huggingface: ['ClementDelangue', 'Thom_Wolf', 'julien_c', '_lewtun', 'younesbelkada'],
  ai2: ['HannaHajishirzi', 'natolambert', 'yejin_choi', 'etzioni'],
  nvidia: ['DrJimFan', 'AnimaAnandkumar', 'sanjafidler'],
  critics: ['GaryMarcus', 'emilymbender', 'MelMitchell1', 'fchollet', 'timnitGebru', 'rodneyabrooks'],
  safety: ['yoshuabengio', 'ESYudkowsky'],
  independent: ['simonw', 'jeremyphoward', 'ID_AA_Carmack', 'drfeifei']
};
```

---

## 2. Substack

### Feed Discovery
All Substacks expose RSS at predictable URLs:
```
https://{subdomain}.substack.com/feed
```

### Substack Registry

```javascript
const SUBSTACKS = {
  // High-signal technical
  'importai': { url: 'https://importai.substack.com/feed', author: 'Jack Clark', tags: ['research', 'policy'] },
  'interconnects': { url: 'https://www.interconnects.ai/feed', author: 'Nathan Lambert', tags: ['rlhf', 'alignment', 'open-source'] },
  'sebastianraschka': { url: 'https://magazine.sebastianraschka.com/feed', author: 'Sebastian Raschka', tags: ['llm', 'research'] },
  'latent-space': { url: 'https://www.latent.space/feed', author: 'swyx & Alessio', tags: ['engineering', 'agents'] },
  
  // Safety & alignment
  'thezvi': { url: 'https://thezvi.substack.com/feed', author: 'Zvi Mowshowitz', tags: ['safety', 'policy'] },
  'astralcodexten': { url: 'https://www.astralcodexten.com/feed', author: 'Scott Alexander', tags: ['ai-adjacent', 'rationality'] },
  
  // Critics & skeptics
  'garymarcus': { url: 'https://garymarcus.substack.com/feed', author: 'Gary Marcus', tags: ['criticism', 'limitations'] },
  'aiguide': { url: 'https://aiguide.substack.com/feed', author: 'Melanie Mitchell', tags: ['criticism', 'understanding'] },
  'aisnakeoil': { url: 'https://www.aisnakeoil.com/feed', author: 'Narayanan & Kapoor', tags: ['hype', 'benchmarks'] },
  
  // Industry analysis
  'oneusefulthing': { url: 'https://www.oneusefulthing.org/feed', author: 'Ethan Mollick', tags: ['applications', 'business'] },
  'semianalysis': { url: 'https://www.semianalysis.com/feed', author: 'Dylan Patel', tags: ['hardware', 'chips'] },
  'hyperdimensional': { url: 'https://www.hyperdimensional.co/feed', author: 'Dean Ball', tags: ['policy', 'governance'] }
};
```

### Parsing Strategy

```javascript
import Parser from 'rss-parser';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';

async function parseSubstack(feedUrl, metadata) {
  const parser = new Parser();
  const feed = await parser.parseURL(feedUrl);
  
  return feed.items.map(item => {
    // Substack RSS includes full content in content:encoded
    const fullContent = item['content:encoded'] || item.content || '';
    
    // Extract clean text using Readability
    const dom = new JSDOM(fullContent);
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    
    // Estimate reading time
    const wordCount = article?.textContent?.split(/\s+/).length || 0;
    const readingTimeMin = Math.ceil(wordCount / 200);
    
    return {
      id: item.guid || item.link,
      title: item.title,
      author: metadata.author,
      url: item.link,
      publishedAt: new Date(item.pubDate),
      summary: item.contentSnippet?.slice(0, 500),
      fullText: article?.textContent,
      htmlContent: fullContent,
      wordCount,
      readingTimeMin,
      tags: metadata.tags,
      source: 'substack'
    };
  });
}
```

### Full Article Extraction (if RSS truncated)

```javascript
import { extract } from '@extractus/article-extractor';

async function fetchFullArticle(url) {
  const article = await extract(url);
  return {
    title: article.title,
    content: article.content,      // HTML
    text: article.textContent,     // Plain text
    author: article.author,
    publishedAt: article.published,
    image: article.image
  };
}
```

---

## 3. YouTube (Transcripts + Metadata)

### Strategy
1. **yt-dlp** for video metadata and URLs
2. **youtube-transcript-api** (Python) or **youtubei.js** (Node) for transcripts
3. **Whisper** fallback for videos without captions

### Channel Registry

```javascript
const YOUTUBE_CHANNELS = {
  // Researcher channels
  'karpathy': { id: 'UCWN3xxRkmTPmbKwht9FuE5A', tags: ['education', 'deep-dive'] },
  'yannic': { id: 'UCZHmQk67mN31hHzLZcVbrqQ', tags: ['papers', 'review'] },
  'twoMinutePapers': { id: 'UCbfYPyITQ-7l4upoX8nvctg', tags: ['papers', 'accessible'] },
  'aiExplained': { id: 'UCNF8IZbZB7O7hXx7aFOxweQ', tags: ['news', 'analysis'] },
  '3blue1brown': { id: 'UCYO_jab_esuFRV4b17AJtAw', tags: ['math', 'visualization'] },
  'mlst': { id: 'UCMLtBahI5DMrt0NPvDSoIRQ', tags: ['interviews', 'technical'] },
  
  // Interview/podcast channels
  'lexFridman': { id: 'UCSHZKyawb77ixDdsGog4iWA', tags: ['interviews', 'long-form'] },
  'dwarkesh': { id: 'UC85XdnvLGVyuOFdfx6vS1hw', tags: ['interviews', 'intellectual'] }
};
```

### Metadata + Transcript Fetching

```javascript
import { execSync } from 'child_process';
import { Innertube } from 'youtubei.js';

// Get recent videos from channel
async function getChannelVideos(channelId, limit = 20) {
  const output = execSync(
    `yt-dlp --flat-playlist -j --playlist-end ${limit} "https://www.youtube.com/channel/${channelId}/videos"`,
    { maxBuffer: 10 * 1024 * 1024 }
  );
  
  return output
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

// Fetch transcript using youtubei.js
async function getTranscript(videoId) {
  const yt = await Innertube.create();
  const info = await yt.getInfo(videoId);
  
  try {
    const transcriptData = await info.getTranscript();
    const segments = transcriptData.transcript.content.body.initialSegments;
    
    return segments.map(seg => ({
      text: seg.snippet.text,
      start: parseFloat(seg.startMs) / 1000,
      duration: parseFloat(seg.endMs) / 1000 - parseFloat(seg.startMs) / 1000
    }));
  } catch (e) {
    return null; // No transcript available
  }
}

// Combine into full pipeline
async function processYouTubeVideo(videoId) {
  const yt = await Innertube.create();
  const info = await yt.getInfo(videoId);
  const transcript = await getTranscript(videoId);
  
  return {
    id: videoId,
    title: info.basic_info.title,
    channel: info.basic_info.channel?.name,
    channelId: info.basic_info.channel?.id,
    description: info.basic_info.short_description,
    publishedAt: info.primary_info?.published?.text,
    duration: info.basic_info.duration,
    viewCount: info.basic_info.view_count,
    url: `https://youtube.com/watch?v=${videoId}`,
    transcript: transcript ? transcript.map(t => t.text).join(' ') : null,
    transcriptSegments: transcript,
    hasTranscript: !!transcript
  };
}
```

### Whisper Fallback (for videos without captions)

```python
# Python script for Whisper transcription
import whisper
import yt_dlp

def transcribe_video(video_url, model_size='base'):
    # Download audio only
    ydl_opts = {
        'format': 'bestaudio/best',
        'postprocessors': [{
            'key': 'FFmpegExtractAudio',
            'preferredcodec': 'mp3',
        }],
        'outtmpl': '/tmp/%(id)s.%(ext)s'
    }
    
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(video_url, download=True)
        audio_path = f"/tmp/{info['id']}.mp3"
    
    # Transcribe with Whisper
    model = whisper.load_model(model_size)
    result = model.transcribe(audio_path)
    
    return {
        'text': result['text'],
        'segments': result['segments'],
        'language': result['language']
    }
```

---

## 4. Personal Blogs & Lab Blogs

### RSS/Atom Detection Strategy

```javascript
import { JSDOM } from 'jsdom';

async function discoverFeed(blogUrl) {
  const response = await fetch(blogUrl);
  const html = await response.text();
  const dom = new JSDOM(html);
  
  // Check common feed link patterns
  const feedLinks = dom.window.document.querySelectorAll(
    'link[type="application/rss+xml"], link[type="application/atom+xml"], link[rel="alternate"][type*="xml"]'
  );
  
  if (feedLinks.length > 0) {
    return feedLinks[0].href;
  }
  
  // Try common paths
  const commonPaths = ['/feed', '/rss', '/atom.xml', '/feed.xml', '/rss.xml', '/index.xml'];
  for (const path of commonPaths) {
    try {
      const feedUrl = new URL(path, blogUrl).href;
      const feedRes = await fetch(feedUrl, { method: 'HEAD' });
      if (feedRes.ok) return feedUrl;
    } catch {}
  }
  
  return null;
}
```

### Blog Registry

```javascript
const BLOGS = {
  // Individual researchers
  'colah': { 
    url: 'https://colah.github.io',
    feed: 'https://colah.github.io/rss.xml',
    author: 'Chris Olah',
    tags: ['interpretability', 'visualization']
  },
  'karpathy': {
    url: 'https://karpathy.github.io',
    feed: null, // No RSS - needs scraping
    author: 'Andrej Karpathy',
    tags: ['deep-learning', 'education']
  },
  'lilianweng': {
    url: 'https://lilianweng.github.io',
    feed: 'https://lilianweng.github.io/index.xml',
    author: 'Lilian Weng',
    tags: ['rl', 'agents', 'safety']
  },
  'jalammar': {
    url: 'https://jalammar.github.io',
    feed: 'https://jalammar.github.io/feed.xml',
    author: 'Jay Alammar',
    tags: ['visualization', 'transformers']
  },
  'ruder': {
    url: 'https://ruder.io',
    feed: 'https://ruder.io/rss/index.rss',
    author: 'Sebastian Ruder',
    tags: ['nlp', 'transfer-learning']
  },
  'rodneybrooks': {
    url: 'https://rodneybrooks.com',
    feed: 'https://rodneybrooks.com/feed/',
    author: 'Rodney Brooks',
    tags: ['robotics', 'criticism', 'predictions']
  },
  'simonwillison': {
    url: 'https://simonwillison.net',
    feed: 'https://simonwillison.net/atom/everything/',
    author: 'Simon Willison',
    tags: ['llm', 'practical', 'tools']
  },
  
  // Lab blogs
  'anthropic': {
    url: 'https://www.anthropic.com/research',
    feed: null, // Needs scraping
    author: 'Anthropic',
    tags: ['safety', 'interpretability', 'constitutional-ai']
  },
  'openai': {
    url: 'https://openai.com/blog',
    feed: null, // Needs scraping
    author: 'OpenAI',
    tags: ['releases', 'research']
  },
  'deepmind': {
    url: 'https://deepmind.google/discover/blog',
    feed: null, // Needs scraping
    author: 'DeepMind',
    tags: ['research', 'alphafold', 'gemini']
  },
  'googleai': {
    url: 'https://ai.googleblog.com',
    feed: 'https://ai.googleblog.com/feeds/posts/default',
    author: 'Google AI',
    tags: ['research', 'products']
  },
  'meta-ai': {
    url: 'https://ai.meta.com/blog',
    feed: null, // Needs scraping
    author: 'Meta AI',
    tags: ['llama', 'open-source']
  }
};
```

### Web Scraping for Blogs Without RSS

```javascript
import { extract } from '@extractus/article-extractor';
import * as cheerio from 'cheerio';

// Generic blog post list scraper
async function scrapeBlogIndex(blogUrl, selectors) {
  const response = await fetch(blogUrl);
  const html = await response.text();
  const $ = cheerio.load(html);
  
  const posts = [];
  $(selectors.postContainer).each((i, el) => {
    posts.push({
      title: $(el).find(selectors.title).text().trim(),
      url: new URL($(el).find(selectors.link).attr('href'), blogUrl).href,
      date: $(el).find(selectors.date).text().trim(),
      summary: $(el).find(selectors.summary).text().trim()
    });
  });
  
  return posts;
}

// Site-specific selectors
const BLOG_SELECTORS = {
  anthropic: {
    postContainer: 'article, .research-post, [class*="post"]',
    title: 'h2, h3, [class*="title"]',
    link: 'a',
    date: 'time, [class*="date"]',
    summary: 'p, [class*="excerpt"]'
  },
  openai: {
    postContainer: '[class*="post"], article',
    title: 'h2, h3',
    link: 'a',
    date: 'time',
    summary: 'p'
  },
  karpathy: {
    // GitHub Pages Jekyll blog
    postContainer: '.post-link, article',
    title: 'h2 a, .post-title',
    link: 'a',
    date: '.post-meta, time',
    summary: '.post-excerpt'
  }
};

// Full article extraction
async function extractArticle(url) {
  try {
    const article = await extract(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AIResearchBot/1.0)'
      }
    });
    
    return {
      url,
      title: article.title,
      author: article.author,
      publishedAt: article.published ? new Date(article.published) : null,
      content: article.content,
      textContent: article.textContent,
      wordCount: article.textContent?.split(/\s+/).length || 0
    };
  } catch (e) {
    // Fallback to basic extraction
    return await fallbackExtract(url);
  }
}

// Trafilatura fallback (Python, more robust)
// Run as subprocess
async function trafilaturaExtract(url) {
  const { execSync } = require('child_process');
  try {
    const result = execSync(
      `trafilatura --json -u "${url}"`,
      { maxBuffer: 5 * 1024 * 1024 }
    );
    return JSON.parse(result.toString());
  } catch {
    return null;
  }
}
```

---

## 5. Podcasts

### Strategy
1. Fetch RSS feeds (all podcasts have them)
2. Extract episode metadata
3. Get transcripts where available (show notes, third-party services)
4. Whisper transcription for high-value episodes

### Podcast Registry

```javascript
const PODCASTS = {
  'lexFridman': {
    feed: 'https://lexfridman.com/feed/podcast/',
    tags: ['interviews', 'long-form'],
    transcriptSource: 'website' // lexfridman.com has transcripts
  },
  'dwarkesh': {
    feed: 'https://feeds.transistor.fm/the-lunar-society',
    tags: ['interviews', 'intellectual'],
    transcriptSource: 'youtube' // Also uploaded to YouTube
  },
  'latentSpace': {
    feed: 'https://feeds.simplecast.com/DGTlNKkk',
    tags: ['engineering', 'agents'],
    transcriptSource: 'latent.space' // Full transcripts on site
  },
  'mlst': {
    feed: 'https://feeds.buzzsprout.com/1101131.rss',
    tags: ['technical', 'interviews'],
    transcriptSource: 'youtube'
  },
  'gradient': {
    feed: 'https://feeds.transistor.fm/the-gradient-podcast',
    tags: ['research', 'academic'],
    transcriptSource: 'thegradient.pub'
  },
  'axrp': {
    feed: 'https://feeds.buzzsprout.com/1334027.rss',
    tags: ['safety', 'alignment'],
    transcriptSource: 'axrp.net'
  },
  '80000hours': {
    feed: 'https://80000hours.org/podcast/feed/',
    tags: ['safety', 'ea'],
    transcriptSource: 'website'
  },
  'cognitiveRevolution': {
    feed: 'https://feeds.transistor.fm/the-cognitive-revolution',
    tags: ['applications', 'business'],
    transcriptSource: 'website'
  }
};
```

### Podcast Parsing

```javascript
import Parser from 'rss-parser';

async function parsePodcastFeed(feedUrl, metadata) {
  const parser = new Parser({
    customFields: {
      item: [
        ['itunes:duration', 'duration'],
        ['itunes:episode', 'episode'],
        ['enclosure', 'audio']
      ]
    }
  });
  
  const feed = await parser.parseURL(feedUrl);
  
  return feed.items.map(item => ({
    id: item.guid,
    title: item.title,
    description: item.contentSnippet || item.content,
    publishedAt: new Date(item.pubDate),
    duration: item.duration,
    episodeNumber: item.episode,
    audioUrl: item.audio?.url || item.enclosure?.url,
    showNotesUrl: item.link,
    tags: metadata.tags,
    transcriptSource: metadata.transcriptSource
  }));
}

// Fetch transcript from show notes page
async function fetchPodcastTranscript(showNotesUrl, source) {
  if (source === 'website') {
    const article = await extract(showNotesUrl);
    // Many podcasts include full transcript in show notes
    if (article.textContent?.length > 5000) {
      return article.textContent;
    }
  }
  
  if (source === 'youtube') {
    // Find associated YouTube video and get transcript
    // (would need to search YouTube for episode title)
  }
  
  return null;
}
```

---

## 6. LessWrong / Alignment Forum

### GraphQL API

```javascript
const LESSWRONG_API = 'https://www.lesswrong.com/graphql';
const ALIGNMENTFORUM_API = 'https://www.alignmentforum.org/graphql';

async function fetchLWPosts(limit = 50, tags = ['ai']) {
  const query = `
    query GetPosts($limit: Int, $tagId: String) {
      posts(input: {
        terms: {
          limit: $limit
          tagId: $tagId
          sortedBy: "new"
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
          user {
            username
            displayName
          }
          contents {
            html
            wordCount
          }
          tags {
            name
            slug
          }
        }
      }
    }
  `;
  
  const response = await fetch(LESSWRONG_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      variables: { limit, tagId: 'ai' }
    })
  });
  
  const data = await response.json();
  return data.data.posts.results.map(post => ({
    id: post._id,
    title: post.title,
    author: post.user?.displayName || post.user?.username,
    url: `https://www.lesswrong.com/posts/${post._id}/${post.slug}`,
    publishedAt: new Date(post.postedAt),
    score: post.baseScore,
    votes: post.voteCount,
    comments: post.commentCount,
    wordCount: post.contents?.wordCount,
    htmlContent: post.contents?.html,
    tags: post.tags?.map(t => t.name),
    source: 'lesswrong'
  }));
}

// Fetch specific authors' posts
async function fetchAuthorPosts(username, site = 'lesswrong') {
  const baseUrl = site === 'lesswrong' ? LESSWRONG_API : ALIGNMENTFORUM_API;
  
  const query = `
    query GetUserPosts($username: String!) {
      user(input: { selector: { slug: $username } }) {
        result {
          posts {
            results {
              _id
              title
              slug
              postedAt
              baseScore
              contents { html wordCount }
            }
          }
        }
      }
    }
  `;
  
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { username } })
  });
  
  return (await response.json()).data.user.result.posts.results;
}
```

### RSS Fallback

```
https://www.lesswrong.com/feed.xml?view=curated
https://www.lesswrong.com/feed.xml?view=frontpage
https://www.alignmentforum.org/feed.xml
```

---

## 7. arXiv

### API + RSS

```javascript
const ARXIV_API = 'http://export.arxiv.org/api/query';

// Search for papers by author or topic
async function searchArxiv(query, maxResults = 50) {
  const params = new URLSearchParams({
    search_query: query,
    start: 0,
    max_results: maxResults,
    sortBy: 'submittedDate',
    sortOrder: 'descending'
  });
  
  const response = await fetch(`${ARXIV_API}?${params}`);
  const xml = await response.text();
  
  // Parse Atom feed
  const parser = new Parser();
  const feed = await parser.parseString(xml);
  
  return feed.items.map(item => ({
    id: item.id.split('/abs/')[1],
    title: item.title.replace(/\n/g, ' ').trim(),
    authors: item['author'] || [], // May need custom parsing
    abstract: item.summary?.replace(/\n/g, ' ').trim(),
    publishedAt: new Date(item.pubDate),
    updatedAt: new Date(item.updated),
    categories: item.categories || [],
    pdfUrl: item.id.replace('/abs/', '/pdf/') + '.pdf',
    url: item.id
  }));
}

// Monitor specific categories
const ARXIV_CATEGORIES = [
  'cs.AI',    // Artificial Intelligence
  'cs.LG',    // Machine Learning
  'cs.CL',    // Computation and Language
  'cs.CV',    // Computer Vision
  'stat.ML'   // Machine Learning (stat)
];

// RSS feeds for categories
function getArxivRSS(category) {
  return `http://export.arxiv.org/rss/${category}`;
}
```

---

## 8. Bluesky

### AT Protocol

```javascript
import { BskyAgent } from '@atproto/api';

async function fetchBskyPosts(handle) {
  const agent = new BskyAgent({ service: 'https://bsky.social' });
  
  // Public posts don't require auth
  const profile = await agent.getProfile({ actor: handle });
  const feed = await agent.getAuthorFeed({ 
    actor: handle,
    limit: 50 
  });
  
  return feed.data.feed.map(item => ({
    id: item.post.uri,
    author: item.post.author.handle,
    text: item.post.record.text,
    publishedAt: new Date(item.post.record.createdAt),
    likes: item.post.likeCount,
    reposts: item.post.repostCount,
    replies: item.post.replyCount,
    url: `https://bsky.app/profile/${item.post.author.handle}/post/${item.post.uri.split('/').pop()}`
  }));
}

// Bluesky handles for researchers
const BLUESKY_HANDLES = {
  'rodneybrooks': 'rodneyabrooks.bsky.social',
  'melaniemitchell': 'melaniemitchell.bsky.social',
  // Growing list as more migrate
};
```

---

## 9. Unified Fetch Orchestrator

```javascript
// Main orchestration layer
class AIIntelFetcher {
  constructor(config) {
    this.config = config;
    this.cache = new Map();
  }
  
  async fetchAll() {
    const results = {
      twitter: await this.fetchTwitter(),
      substacks: await this.fetchSubstacks(),
      youtube: await this.fetchYouTube(),
      blogs: await this.fetchBlogs(),
      podcasts: await this.fetchPodcasts(),
      lesswrong: await this.fetchLessWrong(),
      arxiv: await this.fetchArxiv(),
      bluesky: await this.fetchBluesky()
    };
    
    return this.normalize(results);
  }
  
  async fetchTwitter() {
    const allTweets = [];
    for (const [category, handles] of Object.entries(TWITTER_HANDLES)) {
      for (const handle of handles) {
        try {
          const tweets = await parseNitterFeed(handle);
          allTweets.push(...tweets.map(t => ({ ...t, category })));
        } catch (e) {
          console.error(`Failed to fetch @${handle}:`, e.message);
        }
        await sleep(1000); // Rate limit
      }
    }
    return allTweets;
  }
  
  async fetchSubstacks() {
    const allPosts = [];
    for (const [key, meta] of Object.entries(SUBSTACKS)) {
      try {
        const posts = await parseSubstack(meta.url, meta);
        allPosts.push(...posts);
      } catch (e) {
        console.error(`Failed to fetch ${key}:`, e.message);
      }
    }
    return allPosts;
  }
  
  // ... similar for other sources
  
  normalize(results) {
    // Convert all sources to unified schema
    const unified = [];
    
    for (const [source, items] of Object.entries(results)) {
      for (const item of items) {
        unified.push({
          id: `${source}:${item.id}`,
          source,
          sourceUrl: item.url,
          author: item.author,
          title: item.title || null,
          content: item.text || item.fullText || item.transcript,
          contentType: this.detectContentType(source, item),
          publishedAt: item.publishedAt,
          fetchedAt: new Date(),
          metadata: {
            category: item.category,
            tags: item.tags,
            metrics: item.metrics
          }
        });
      }
    }
    
    return unified;
  }
  
  detectContentType(source, item) {
    if (source === 'twitter') return 'short-form';
    if (source === 'youtube') return 'video-transcript';
    if (source === 'podcasts') return 'audio-transcript';
    if (source === 'arxiv') return 'paper-abstract';
    return 'long-form';
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

---

## 10. Storage Schema

```sql
-- PostgreSQL schema for content storage

CREATE TABLE sources (
  id SERIAL PRIMARY KEY,
  type VARCHAR(50) NOT NULL,  -- twitter, substack, youtube, etc.
  identifier VARCHAR(255) NOT NULL,  -- handle, feed URL, channel ID
  author_name VARCHAR(255),
  category VARCHAR(100),
  tags TEXT[],
  last_fetched TIMESTAMPTZ,
  fetch_frequency_hours INT DEFAULT 24,
  is_active BOOLEAN DEFAULT true,
  UNIQUE(type, identifier)
);

CREATE TABLE content (
  id SERIAL PRIMARY KEY,
  source_id INT REFERENCES sources(id),
  external_id VARCHAR(255) NOT NULL,  -- tweet ID, post slug, video ID
  url TEXT,
  title TEXT,
  content_text TEXT,
  content_html TEXT,
  content_type VARCHAR(50),  -- short-form, long-form, video-transcript, etc.
  author VARCHAR(255),
  published_at TIMESTAMPTZ,
  fetched_at TIMESTAMPTZ DEFAULT NOW(),
  word_count INT,
  metadata JSONB,
  UNIQUE(source_id, external_id)
);

-- For semantic search with pgvector
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE content_embeddings (
  id SERIAL PRIMARY KEY,
  content_id INT REFERENCES content(id) ON DELETE CASCADE,
  chunk_index INT DEFAULT 0,
  chunk_text TEXT,
  embedding vector(1536),  -- OpenAI ada-002 dimension
  UNIQUE(content_id, chunk_index)
);

CREATE INDEX ON content_embeddings USING ivfflat (embedding vector_cosine_ops);

-- Extracted claims/insights for downstream analysis
CREATE TABLE extracted_claims (
  id SERIAL PRIMARY KEY,
  content_id INT REFERENCES content(id),
  claim_text TEXT NOT NULL,
  claim_type VARCHAR(50),  -- prediction, opinion, fact, hint
  topic VARCHAR(100),
  confidence_score FLOAT,
  extracted_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB
);

CREATE INDEX ON extracted_claims(topic);
CREATE INDEX ON extracted_claims(claim_type);
CREATE INDEX ON content(published_at);
CREATE INDEX ON content(source_id, published_at);
```

---

## 11. Cron Schedule

```bash
# /etc/cron.d/ai-intel-fetcher

# Twitter: every 4 hours (respecting rate limits)
0 */4 * * * aibot /opt/ai-intel/fetch.js twitter >> /var/log/ai-intel/twitter.log 2>&1

# Substacks: twice daily (new posts are infrequent)
0 8,20 * * * aibot /opt/ai-intel/fetch.js substacks >> /var/log/ai-intel/substacks.log 2>&1

# YouTube: every 6 hours
0 */6 * * * aibot /opt/ai-intel/fetch.js youtube >> /var/log/ai-intel/youtube.log 2>&1

# Blogs: daily
0 6 * * * aibot /opt/ai-intel/fetch.js blogs >> /var/log/ai-intel/blogs.log 2>&1

# Podcasts: daily
0 7 * * * aibot /opt/ai-intel/fetch.js podcasts >> /var/log/ai-intel/podcasts.log 2>&1

# LessWrong/AF: every 12 hours
0 */12 * * * aibot /opt/ai-intel/fetch.js lesswrong >> /var/log/ai-intel/lesswrong.log 2>&1

# arXiv: daily (new submissions)
0 9 * * * aibot /opt/ai-intel/fetch.js arxiv >> /var/log/ai-intel/arxiv.log 2>&1

# Content extraction (process queue of full articles)
*/30 * * * * aibot /opt/ai-intel/extract.js >> /var/log/ai-intel/extract.log 2>&1

# Embedding generation (for new content)
0 * * * * aibot /opt/ai-intel/embed.js >> /var/log/ai-intel/embed.log 2>&1
```

---

## Next Steps

1. **Claim Extraction Pipeline** - LLM prompts for extracting predictions, opinions, hints from content
2. **Synthesis Layer** - Cross-referencing opposing views, tracking prediction accuracy
3. **Output Formats** - Weekly digest generation, topic dashboards, API endpoints
4. **MCP Server** - Expose as tools: `get_recent_claims(topic)`, `get_researcher_views(name)`, etc.
