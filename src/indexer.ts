/**
 * Skald Indexer
 *
 * Walks spec directories, parses frontmatter, chunks markdown by headings,
 * generates embeddings, and stores everything in SQLite.
 */

import { readdir, readFile, stat } from "fs/promises";
import { join, extname, relative, basename } from "path";
import { createHash } from "crypto";
import matter from "gray-matter";
import { EmbeddingService } from "./embeddings.js";
import { SkaldDatabase } from "./database.js";
import type { SpecDocument, SpecChunk, SpecFrontmatter } from "./types.js";

const SKIP_DIRS = new Set(["node_modules", "design-languages-v1", ".git", "dist", "Codebase"]);
const MIN_FILE_SIZE = 50;
const MIN_CHUNK_SIZE = 30;

// ─── File Walking ──────────────────────────────────────────────────

async function walkMarkdown(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkMarkdown(fullPath)));
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
      results.push(fullPath);
    }
  }
  return results;
}

// ─── Hashing ───────────────────────────────────────────────────────

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

// ─── Markdown Chunking ─────────────────────────────────────────────

interface Chunk {
  heading: string | null;
  headingChain: string | null;
  content: string;
}

function chunkMarkdown(content: string): Chunk[] {
  const lines = content.split("\n");
  const chunks: Chunk[] = [];
  let currentHeading: string | null = null;
  let headingStack: string[] = [];
  let buffer: string[] = [];

  function flushBuffer() {
    const text = buffer.join("\n").trim();
    if (text.length >= MIN_CHUNK_SIZE) {
      chunks.push({
        heading: currentHeading,
        headingChain: headingStack.length > 0 ? headingStack.join(" > ") : null,
        content: text,
      });
    }
    buffer = [];
  }

  for (const line of lines) {
    const headingMatch = line.match(/^(#{2,3})\s+(.+)$/);
    if (headingMatch) {
      flushBuffer();
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();
      currentHeading = text;

      // Maintain heading stack for chain
      if (level === 2) {
        headingStack = [text];
      } else if (level === 3) {
        headingStack = headingStack.length > 0 ? [headingStack[0], text] : [text];
      }
      buffer.push(line);
    } else {
      buffer.push(line);
    }
  }
  flushBuffer();

  // If no headings found, treat entire content as one chunk
  if (chunks.length === 0 && content.trim().length >= MIN_CHUNK_SIZE) {
    chunks.push({ heading: null, headingChain: null, content: content.trim() });
  }

  return chunks;
}

// ─── Indexer ───────────────────────────────────────────────────────

export interface IndexResult {
  filesScanned: number;
  filesIndexed: number;
  filesSkipped: number;
  chunksCreated: number;
  embeddingsGenerated: number;
  errors: Array<{ path: string; error: string }>;
}

export async function indexDirectory(
  specDir: string,
  db: SkaldDatabase,
  embeddings: EmbeddingService,
  options?: { verbose?: boolean },
): Promise<IndexResult> {
  const verbose = options?.verbose ?? false;
  const result: IndexResult = {
    filesScanned: 0,
    filesIndexed: 0,
    filesSkipped: 0,
    chunksCreated: 0,
    embeddingsGenerated: 0,
    errors: [],
  };

  const files = await walkMarkdown(specDir);
  result.filesScanned = files.length;

  if (verbose) console.log(`Found ${files.length} markdown files in ${specDir}`);

  // Process files and collect chunks needing embeddings
  const pendingEmbeddings: Array<{ chunk: SpecChunk; text: string }> = [];

  for (const filePath of files) {
    try {
      const content = await readFile(filePath, "utf-8");
      if (content.length < MIN_FILE_SIZE) {
        result.filesSkipped++;
        continue;
      }

      const relPath = relative(specDir, filePath);
      const contentHash = sha256(content);

      // Check if already indexed with same content
      const existing = db.getDocumentByPath(relPath);
      if (existing && existing.contentHash === contentHash) {
        result.filesSkipped++;
        if (verbose) console.log(`  [skip] ${relPath} (unchanged)`);
        continue;
      }

      // Parse frontmatter
      const parsed = matter(content);
      const fm = parsed.data as SpecFrontmatter;
      const body = parsed.content;

      // Extract title from frontmatter or first H1
      const title = fm.title || extractTitle(body) || basename(filePath, ".md");

      const docId = sha256(relPath);
      const fileStat = await stat(filePath);

      // gray-matter auto-converts date strings to Date objects — normalize back to string
      let dateStr: string | null = null;
      if (fm.date instanceof Date) {
        dateStr = fm.date.toISOString().split("T")[0];
      } else if (typeof fm.date === "string") {
        dateStr = fm.date;
      }

      const doc: SpecDocument = {
        id: docId,
        path: relPath,
        title,
        product: fm.product || inferProduct(relPath),
        subsystem: fm.subsystem || null,
        status: fm.status || "draft",
        sourceType: fm.source_type || "spec",
        supersedes: fm.supersedes || null,
        date: dateStr,
        contentHash,
        updatedAt: fileStat.mtimeMs,
      };

      db.upsertDocument(doc);

      // Delete old chunks for this document
      if (existing) {
        db.deleteDocumentChunks(docId);
      }

      // Chunk the markdown body
      const chunks = chunkMarkdown(body);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const chunkId = `${docId}_${sha256(chunk.heading || String(i))}`;

        const specChunk: SpecChunk = {
          id: chunkId,
          docId,
          heading: chunk.heading,
          headingChain: chunk.headingChain,
          content: chunk.content,
          embedding: null,
          updatedAt: Date.now(),
        };

        // Prepare text for embedding: title + heading context + content
        const embeddingText = [title, chunk.headingChain, chunk.content.slice(0, 2000)]
          .filter(Boolean)
          .join("\n");

        pendingEmbeddings.push({ chunk: specChunk, text: embeddingText });
      }

      result.filesIndexed++;
      if (verbose) console.log(`  [index] ${relPath} (${chunks.length} chunks)`);
    } catch (err: any) {
      const msg = err?.message || err?.toString() || String(err);
      result.errors.push({ path: filePath, error: msg });
      if (verbose) console.error(`  [error] ${filePath}: ${msg}`);
      if (verbose && err?.stack) console.error(`    ${err.stack.split("\n").slice(1, 3).join("\n    ")}`);
    }
  }

  // Generate embeddings in batches
  if (pendingEmbeddings.length > 0) {
    if (verbose) console.log(`\nGenerating embeddings for ${pendingEmbeddings.length} chunks...`);

    const texts = pendingEmbeddings.map((p) => p.text);
    try {
      const embResults = await embeddings.embedBatch(texts);

      for (let i = 0; i < pendingEmbeddings.length; i++) {
        pendingEmbeddings[i].chunk.embedding = embResults[i].embedding;
        db.insertChunk(pendingEmbeddings[i].chunk);
        result.chunksCreated++;
        result.embeddingsGenerated++;
      }
    } catch (err: any) {
      // Fall back to storing chunks without embeddings
      console.error(`Embedding generation failed: ${err.message}`);
      console.error("Storing chunks without embeddings (search will be limited).");
      for (const pe of pendingEmbeddings) {
        db.insertChunk(pe.chunk);
        result.chunksCreated++;
      }
    }
  }

  await db.flush();
  return result;
}

// ─── Helpers ───────────────────────────────────────────────────────

function extractTitle(content: string): string | null {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

function inferProduct(relPath: string): string {
  const parts = relPath.split(/[\\/]/);
  return (parts[0] || "unknown").toLowerCase();
}
