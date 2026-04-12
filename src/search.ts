/**
 * Skald Search
 *
 * Semantic search over indexed spec chunks using cosine similarity.
 * Reuses embedding infrastructure from @vessel/memory.
 */

import { EmbeddingService, cosineSimilarity } from "./embeddings.js";
import { SkaldDatabase } from "./database.js";
import type { SearchResult, SearchOptions, SpecDocument } from "./types.js";
import { readFile } from "fs/promises";
import { join } from "path";

export class SkaldSearch {
  constructor(
    private db: SkaldDatabase,
    private embeddings: EmbeddingService,
  ) {}

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const limit = options?.limit ?? 10;
    const statusFilter = options?.status; // no default — search across all statuses

    // Embed the query
    const queryResult = await this.embeddings.embed(query);
    const queryVec = queryResult.embedding;

    // Load all chunks with embeddings, optionally filtered
    const chunks = this.db.getAllChunksWithEmbeddings({
      status: statusFilter,
      subsystem: options?.subsystem,
      product: options?.product,
      sourceType: options?.sourceType,
    });

    // Score each chunk
    const scored: Array<{ chunk: (typeof chunks)[0]; similarity: number }> = [];
    for (const chunk of chunks) {
      if (!chunk.embedding) continue;
      const sim = cosineSimilarity(queryVec, chunk.embedding);
      if (sim > 0.3) {
        scored.push({ chunk, similarity: sim });
      }
    }

    // Sort by similarity descending
    scored.sort((a, b) => b.similarity - a.similarity);

    // Return top-K
    return scored.slice(0, limit).map(({ chunk, similarity }) => ({
      path: chunk.docPath,
      title: chunk.docTitle,
      heading: chunk.heading,
      headingChain: chunk.headingChain,
      snippet: chunk.content.slice(0, 500),
      similarity,
      status: chunk.docStatus,
      subsystem: chunk.docSubsystem,
      product: chunk.docProduct,
      sourceType: chunk.docSourceType,
    }));
  }

  /**
   * Get the canonical (current) spec for a subsystem.
   * Errors if zero or multiple documents claim status: current.
   */
  getCanonical(subsystem: string, product?: string): { doc: SpecDocument; error?: string } | { doc?: never; error: string } {
    const docs = this.db.findDocuments({
      subsystem: subsystem.toLowerCase(),
      product: product?.toLowerCase(),
      status: "current",
    });

    if (docs.length === 0) {
      return { error: `No document with status 'current' found for subsystem '${subsystem}'${product ? ` in product '${product}'` : ""}.` };
    }

    if (docs.length > 1) {
      const paths = docs.map((d) => d.path).join("\n  - ");
      return { error: `Multiple documents claim status 'current' for subsystem '${subsystem}':\n  - ${paths}\nResolve by setting all but one to 'superseded' in their frontmatter.` };
    }

    return { doc: docs[0] };
  }

  /**
   * Read the full text of a spec file given its relative path.
   */
  async readSpec(specDirs: string[], relPath: string): Promise<string | null> {
    for (const dir of specDirs) {
      try {
        return await readFile(join(dir, relPath), "utf-8");
      } catch {
        continue;
      }
    }
    return null;
  }

  /**
   * Lint: find conflicts and issues in the index.
   */
  lint(): Array<{ type: string; message: string }> {
    const issues: Array<{ type: string; message: string }> = [];

    // Find subsystems with multiple "current" docs
    const currentDocs = this.db.findDocuments({ status: "current" });
    const bySubsystem = new Map<string, SpecDocument[]>();
    for (const doc of currentDocs) {
      if (!doc.subsystem) continue;
      const key = `${doc.product}/${doc.subsystem}`;
      if (!bySubsystem.has(key)) bySubsystem.set(key, []);
      bySubsystem.get(key)!.push(doc);
    }

    for (const [key, docs] of bySubsystem) {
      if (docs.length > 1) {
        issues.push({
          type: "dual-current",
          message: `Multiple 'current' docs for ${key}: ${docs.map((d) => d.path).join(", ")}`,
        });
      }
    }

    // Find supersedes references that point to non-existent files
    const allDocs = this.db.findDocuments({});
    const allPaths = new Set(allDocs.map((d) => d.path));
    for (const doc of allDocs) {
      if (doc.supersedes) {
        // Check if any document's path ends with the supersedes value
        const found = allDocs.some(
          (d) => d.path.endsWith(doc.supersedes!) || d.path.endsWith(doc.supersedes!.replace(/\.md$/, ".md")),
        );
        if (!found) {
          issues.push({
            type: "orphan-supersedes",
            message: `${doc.path} claims to supersede '${doc.supersedes}' but no matching document found`,
          });
        }
      }
    }

    return issues;
  }
}
