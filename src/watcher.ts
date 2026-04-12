/**
 * Skald Spec Drift Watch
 *
 * Watches spec directories for file changes and re-indexes on the fly.
 * Detects dual-current conflicts and notifies via callback.
 */

import { watch, type FSWatcher } from "fs";
import { readFile, stat } from "fs/promises";
import { join, extname, relative, basename } from "path";
import { createHash } from "crypto";
import matter from "gray-matter";
import { SkaldDatabase } from "./database.js";
import { EmbeddingService } from "./embeddings.js";
import type { SpecDocument } from "./types.js";

const SKIP_DIRS = new Set(["node_modules", "design-languages-v1", ".git", "dist", "Codebase"]);
const MIN_FILE_SIZE = 50;

export interface WatcherConfig {
  specDirs: string[];
  db: SkaldDatabase;
  embeddings: EmbeddingService;
  onConflict?: (message: string) => void;
  onReindex?: (path: string, action: string) => void;
  debounceMs?: number;
}

export class SpecWatcher {
  private watchers: FSWatcher[] = [];
  private config: WatcherConfig;
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private debounceMs: number;

  constructor(config: WatcherConfig) {
    this.config = config;
    this.debounceMs = config.debounceMs ?? 2000;
  }

  start(): void {
    for (const dir of this.config.specDirs) {
      const watcher = watch(dir, { recursive: true }, (event, filename) => {
        if (!filename) return;
        if (!filename.endsWith(".md")) return;

        // Skip excluded directories
        const parts = filename.split(/[\\/]/);
        if (parts.some((p) => SKIP_DIRS.has(p))) return;

        const fullPath = join(dir, filename);
        this.debouncedReindex(dir, fullPath, filename);
      });

      this.watchers.push(watcher);
      console.log(`[skald-watch] Watching ${dir}`);
    }
  }

  stop(): void {
    for (const w of this.watchers) {
      w.close();
    }
    this.watchers = [];
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    console.log("[skald-watch] Stopped");
  }

  private debouncedReindex(specDir: string, fullPath: string, filename: string): void {
    const key = fullPath;
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(
      key,
      setTimeout(() => {
        this.debounceTimers.delete(key);
        this.reindexFile(specDir, fullPath, filename).catch((err) => {
          console.error(`[skald-watch] Error reindexing ${filename}: ${err.message}`);
        });
      }, this.debounceMs),
    );
  }

  private async reindexFile(specDir: string, fullPath: string, filename: string): Promise<void> {
    const relPath = relative(specDir, fullPath);

    // Check if file still exists (might have been deleted)
    let content: string;
    try {
      content = await readFile(fullPath, "utf-8");
    } catch {
      // File was deleted — could remove from index, but for now just log
      this.config.onReindex?.(relPath, "deleted");
      return;
    }

    if (content.length < MIN_FILE_SIZE) return;

    const contentHash = createHash("sha256").update(content).digest("hex").slice(0, 16);

    // Check if content actually changed
    const existing = this.config.db.getDocumentByPath(relPath);
    if (existing && existing.contentHash === contentHash) return;

    // Parse frontmatter
    const parsed = matter(content);
    const fm = parsed.data;
    const body = parsed.content;

    // Extract title
    const titleMatch = body.match(/^#\s+(.+)$/m);
    const title = fm.title || (titleMatch ? titleMatch[1].trim() : basename(fullPath, ".md"));

    // Normalize date
    let dateStr: string | null = null;
    if (fm.date instanceof Date) dateStr = fm.date.toISOString().split("T")[0];
    else if (typeof fm.date === "string") dateStr = fm.date;

    const docId = createHash("sha256").update(relPath).digest("hex").slice(0, 16);
    const fileStat = await stat(fullPath);

    const doc: SpecDocument = {
      id: docId,
      path: relPath,
      title,
      product: fm.product || relPath.split(/[\\/]/)[0]?.toLowerCase() || "unknown",
      subsystem: fm.subsystem || null,
      status: fm.status || "draft",
      sourceType: fm.source_type || "spec",
      supersedes: fm.supersedes || null,
      date: dateStr,
      contentHash,
      updatedAt: fileStat.mtimeMs,
    };

    this.config.db.upsertDocument(doc);

    // Re-chunk and re-embed
    if (existing) {
      this.config.db.deleteDocumentChunks(docId);
    }

    const chunks = chunkMarkdown(body);
    const texts = chunks.map((c) => [title, c.headingChain, c.content.slice(0, 2000)].filter(Boolean).join("\n"));

    try {
      const embedResults = await this.config.embeddings.embedBatch(texts);
      for (let i = 0; i < chunks.length; i++) {
        const chunkId = `${docId}_${createHash("sha256").update(chunks[i].heading || String(i)).digest("hex").slice(0, 16)}`;
        this.config.db.insertChunk({
          id: chunkId,
          docId,
          heading: chunks[i].heading,
          headingChain: chunks[i].headingChain,
          content: chunks[i].content,
          embedding: embedResults[i].embedding,
          updatedAt: Date.now(),
        });
      }
    } catch {
      // Embed failed — store chunks without embeddings
      for (let i = 0; i < chunks.length; i++) {
        const chunkId = `${docId}_${createHash("sha256").update(chunks[i].heading || String(i)).digest("hex").slice(0, 16)}`;
        this.config.db.insertChunk({
          id: chunkId,
          docId,
          heading: chunks[i].heading,
          headingChain: chunks[i].headingChain,
          content: chunks[i].content,
          embedding: null,
          updatedAt: Date.now(),
        });
      }
    }

    await this.config.db.flush();
    this.config.onReindex?.(relPath, existing ? "updated" : "added");

    // Check for conflicts after reindex
    this.checkConflicts(doc);
  }

  private checkConflicts(doc: SpecDocument): void {
    if (doc.status !== "current" || !doc.subsystem) return;

    const peers = this.config.db.findDocuments({
      product: doc.product,
      subsystem: doc.subsystem,
      status: "current",
    });

    if (peers.length > 1) {
      const paths = peers.map((d) => d.path).join(", ");
      const msg = `Dual-current conflict: ${doc.product}/${doc.subsystem} has ${peers.length} documents claiming 'current': ${paths}`;
      console.warn(`[skald-watch] ${msg}`);
      this.config.onConflict?.(msg);
    }
  }
}

// ─── Markdown Chunking (duplicated from indexer for standalone use) ──

function chunkMarkdown(content: string): Array<{ heading: string | null; headingChain: string | null; content: string }> {
  const lines = content.split("\n");
  const chunks: Array<{ heading: string | null; headingChain: string | null; content: string }> = [];
  let currentHeading: string | null = null;
  let headingStack: string[] = [];
  let buffer: string[] = [];

  function flush() {
    const text = buffer.join("\n").trim();
    if (text.length >= 30) {
      chunks.push({
        heading: currentHeading,
        headingChain: headingStack.length > 0 ? headingStack.join(" > ") : null,
        content: text,
      });
    }
    buffer = [];
  }

  for (const line of lines) {
    const m = line.match(/^(#{2,3})\s+(.+)$/);
    if (m) {
      flush();
      currentHeading = m[2].trim();
      if (m[1].length === 2) headingStack = [currentHeading];
      else headingStack = headingStack.length > 0 ? [headingStack[0], currentHeading] : [currentHeading];
      buffer.push(line);
    } else {
      buffer.push(line);
    }
  }
  flush();

  if (chunks.length === 0 && content.trim().length >= 30) {
    chunks.push({ heading: null, headingChain: null, content: content.trim() });
  }

  return chunks;
}
