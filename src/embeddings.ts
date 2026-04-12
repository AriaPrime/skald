/**
 * Skald Embeddings
 *
 * Self-contained embedding service and vector math.
 * Extracted from @vessel/memory so Skald can stand alone as its own repo.
 * Uses OpenAI text-embedding-3-small.
 */

import OpenAI from "openai";

// ─── Types ───────────────────────────────────────────────────────────

export interface EmbeddingConfig {
  apiKey: string;
  model?: string;
  dimensions?: number;
  batchSize?: number;
}

export interface EmbeddingResult {
  embedding: Float32Array;
  model: string;
  tokensUsed: number;
}

// ─── Embedding Service ───────────────────────────────────────────────

export class EmbeddingService {
  private client: OpenAI;
  private model: string;
  private dimensions: number;
  private batchSize: number;

  constructor(config: EmbeddingConfig) {
    this.client = new OpenAI({ apiKey: config.apiKey });
    this.model = config.model ?? "text-embedding-3-small";
    this.dimensions = config.dimensions ?? 1536;
    this.batchSize = config.batchSize ?? 100;
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: text,
      dimensions: this.dimensions,
    });
    return {
      embedding: new Float32Array(response.data[0].embedding),
      model: response.model,
      tokensUsed: response.usage.total_tokens,
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    const results: EmbeddingResult[] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const response = await this.client.embeddings.create({
        model: this.model,
        input: batch,
        dimensions: this.dimensions,
      });
      const sorted = [...response.data].sort((a, b) => a.index - b.index);
      for (const item of sorted) {
        results.push({
          embedding: new Float32Array(item.embedding),
          model: response.model,
          tokensUsed: Math.ceil(response.usage.total_tokens / batch.length),
        });
      }
    }
    return results;
  }
}

// ─── Vector Math ─────────────────────────────────────────────────────

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const mag = Math.sqrt(normA) * Math.sqrt(normB);
  return mag === 0 ? 0 : dot / mag;
}

// ─── Serialization ───────────────────────────────────────────────────

export function embeddingToBuffer(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer.slice(embedding.byteOffset, embedding.byteOffset + embedding.byteLength));
}

export function bufferToEmbedding(buffer: Buffer): Float32Array {
  const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return new Float32Array(ab);
}
