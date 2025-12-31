/**
 * Embedding Service
 * 
 * Supports multiple embedding providers:
 * - Ollama (local, free) - for development or cost optimization
 * - OpenAI (ada-002 or text-embedding-3-small)
 * - Voyage AI (specialized for retrieval)
 */

// ============================================================================
// TYPES
// ============================================================================

interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  dimension: number;
}

interface EmbeddingServiceConfig {
  provider: 'ollama' | 'openai' | 'voyage';
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

// ============================================================================
// EMBEDDING SERVICE
// ============================================================================

export class EmbeddingService implements EmbeddingProvider {
  private provider: EmbeddingProvider;
  public dimension: number;
  
  constructor(config: EmbeddingServiceConfig | string = 'ollama') {
    // Handle string shorthand
    if (typeof config === 'string') {
      config = { provider: config as any };
    }
    
    switch (config.provider) {
      case 'ollama':
        this.provider = new OllamaEmbeddings(config);
        this.dimension = 768; // nomic-embed-text default
        break;
      case 'openai':
        this.provider = new OpenAIEmbeddings(config);
        this.dimension = config.model?.includes('3-large') ? 3072 : 1536;
        break;
      case 'voyage':
        this.provider = new VoyageEmbeddings(config);
        this.dimension = 1024;
        break;
      default:
        throw new Error(`Unknown embedding provider: ${config.provider}`);
    }
  }
  
  async embed(text: string): Promise<number[]> {
    // Truncate very long texts
    const truncated = text.slice(0, 8000);
    return this.provider.embed(truncated);
  }
  
  async embedBatch(texts: string[]): Promise<number[][]> {
    const truncated = texts.map(t => t.slice(0, 8000));
    return this.provider.embedBatch(truncated);
  }
}

// ============================================================================
// OLLAMA (Local)
// ============================================================================

class OllamaEmbeddings implements EmbeddingProvider {
  private baseUrl: string;
  private model: string;
  public dimension: number;
  
  constructor(config: EmbeddingServiceConfig) {
    // Use OLLAMA_URL env var for Docker, fallback to localhost for local dev
    this.baseUrl = config.baseUrl || process.env.OLLAMA_URL || 'http://localhost:11434';
    this.model = config.model || 'nomic-embed-text';
    this.dimension = 768; // nomic-embed-text
    
    // Adjust dimension for other models
    if (this.model.includes('mxbai')) this.dimension = 1024;
    if (this.model.includes('all-minilm')) this.dimension = 384;
  }
  
  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt: text
      })
    });
    
    if (!response.ok) {
      throw new Error(`Ollama error: ${await response.text()}`);
    }
    
    const data = await response.json();
    return data.embedding;
  }
  
  async embedBatch(texts: string[]): Promise<number[][]> {
    // Ollama doesn't support batch, so we parallelize with concurrency limit
    const CONCURRENCY = 5;
    const results: number[][] = [];
    
    for (let i = 0; i < texts.length; i += CONCURRENCY) {
      const batch = texts.slice(i, i + CONCURRENCY);
      const embeddings = await Promise.all(batch.map(t => this.embed(t)));
      results.push(...embeddings);
    }
    
    return results;
  }
}

// ============================================================================
// OPENAI
// ============================================================================

class OpenAIEmbeddings implements EmbeddingProvider {
  private apiKey: string;
  private model: string;
  public dimension: number;
  
  constructor(config: EmbeddingServiceConfig) {
    this.apiKey = config.apiKey || process.env.OPENAI_API_KEY || '';
    this.model = config.model || 'text-embedding-3-small';
    this.dimension = this.model.includes('3-large') ? 3072 : 1536;
  }
  
  async embed(text: string): Promise<number[]> {
    const embeddings = await this.embedBatch([text]);
    return embeddings[0];
  }
  
  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        input: texts
      })
    });
    
    if (!response.ok) {
      throw new Error(`OpenAI error: ${await response.text()}`);
    }
    
    const data = await response.json();
    return data.data
      .sort((a: any, b: any) => a.index - b.index)
      .map((item: any) => item.embedding);
  }
}

// ============================================================================
// VOYAGE AI
// ============================================================================

class VoyageEmbeddings implements EmbeddingProvider {
  private apiKey: string;
  private model: string;
  public dimension: number;
  
  constructor(config: EmbeddingServiceConfig) {
    this.apiKey = config.apiKey || process.env.VOYAGE_API_KEY || '';
    this.model = config.model || 'voyage-3';
    this.dimension = 1024;
  }
  
  async embed(text: string): Promise<number[]> {
    const embeddings = await this.embedBatch([text]);
    return embeddings[0];
  }
  
  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        input_type: 'document'
      })
    });
    
    if (!response.ok) {
      throw new Error(`Voyage error: ${await response.text()}`);
    }
    
    const data = await response.json();
    return data.data.map((item: any) => item.embedding);
  }
}

// ============================================================================
// SEMANTIC SEARCH UTILITIES
// ============================================================================

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must have same length');
  }
  
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function euclideanDistance(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must have same length');
  }
  
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += (a[i] - b[i]) ** 2;
  }
  
  return Math.sqrt(sum);
}

// ============================================================================
// CHUNKING UTILITIES
// ============================================================================

export interface Chunk {
  text: string;
  index: number;
  startChar: number;
  endChar: number;
}

export function chunkText(
  text: string, 
  options: {
    maxChunkSize?: number;
    overlap?: number;
    splitOn?: 'sentence' | 'paragraph' | 'fixed';
  } = {}
): Chunk[] {
  const { 
    maxChunkSize = 500, 
    overlap = 50,
    splitOn = 'paragraph' 
  } = options;
  
  const chunks: Chunk[] = [];
  
  if (splitOn === 'paragraph') {
    const paragraphs = text.split(/\n\n+/);
    let currentChunk = '';
    let startChar = 0;
    let chunkIndex = 0;
    
    for (const para of paragraphs) {
      if (currentChunk.length + para.length > maxChunkSize && currentChunk.length > 0) {
        chunks.push({
          text: currentChunk.trim(),
          index: chunkIndex++,
          startChar,
          endChar: startChar + currentChunk.length
        });
        
        // Start new chunk with overlap
        const overlapText = currentChunk.slice(-overlap);
        startChar = startChar + currentChunk.length - overlap;
        currentChunk = overlapText;
      }
      
      currentChunk += (currentChunk ? '\n\n' : '') + para;
    }
    
    if (currentChunk.trim()) {
      chunks.push({
        text: currentChunk.trim(),
        index: chunkIndex,
        startChar,
        endChar: startChar + currentChunk.length
      });
    }
  } else if (splitOn === 'sentence') {
    // Simple sentence splitting
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    let currentChunk = '';
    let startChar = 0;
    let chunkIndex = 0;
    
    for (const sentence of sentences) {
      if (currentChunk.length + sentence.length > maxChunkSize && currentChunk.length > 0) {
        chunks.push({
          text: currentChunk.trim(),
          index: chunkIndex++,
          startChar,
          endChar: startChar + currentChunk.length
        });
        
        startChar = startChar + currentChunk.length;
        currentChunk = '';
      }
      
      currentChunk += sentence;
    }
    
    if (currentChunk.trim()) {
      chunks.push({
        text: currentChunk.trim(),
        index: chunkIndex,
        startChar,
        endChar: startChar + currentChunk.length
      });
    }
  } else {
    // Fixed size chunks
    for (let i = 0; i < text.length; i += maxChunkSize - overlap) {
      chunks.push({
        text: text.slice(i, i + maxChunkSize),
        index: chunks.length,
        startChar: i,
        endChar: Math.min(i + maxChunkSize, text.length)
      });
    }
  }
  
  return chunks;
}

// ============================================================================
// BATCH EMBEDDING WITH PROGRESS
// ============================================================================

export async function embedWithProgress(
  service: EmbeddingService,
  texts: string[],
  onProgress?: (completed: number, total: number) => void
): Promise<number[][]> {
  const BATCH_SIZE = 20;
  const results: number[][] = [];
  
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const embeddings = await service.embedBatch(batch);
    results.push(...embeddings);
    
    if (onProgress) {
      onProgress(Math.min(i + BATCH_SIZE, texts.length), texts.length);
    }
  }
  
  return results;
}
