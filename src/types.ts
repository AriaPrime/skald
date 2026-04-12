/**
 * Skald Types
 *
 * Shared type definitions for the spec index.
 */

export interface SpecFrontmatter {
  title?: string;
  product?: string;
  subsystem?: string;
  status?: string;
  source_type?: string;
  version?: number;
  supersedes?: string;
  date?: string;
  flags?: string[];
}

export interface SpecDocument {
  id: string;
  path: string;
  title: string;
  product: string;
  subsystem: string | null;
  status: string;
  sourceType: string;
  supersedes: string | null;
  date: string | null;
  contentHash: string;
  updatedAt: number;
}

export interface SpecChunk {
  id: string;
  docId: string;
  heading: string | null;
  headingChain: string | null;
  content: string;
  embedding: Float32Array | null;
  updatedAt: number;
}

export interface SearchResult {
  path: string;
  title: string;
  heading: string | null;
  headingChain: string | null;
  snippet: string;
  similarity: number;
  status: string;
  subsystem: string | null;
  product: string;
  sourceType: string;
}

export interface SearchOptions {
  subsystem?: string;
  product?: string;
  status?: string;
  sourceType?: string;
  limit?: number;
}

export interface SkaldConfig {
  specDirs: string[];
  dbPath: string;
  openaiApiKey: string;
}

// ─── Plans ─────────────────────────────────────────────────────────

export interface Plan {
  id: string;
  product: string;
  title: string;
  description: string | null;
  updatedAt: number;
}

export interface Phase {
  id: string;
  planId: string;
  phaseNum: number;
  title: string;
  description: string | null;
  status: string; // planned | active | completed | skipped
  specRefs: string | null;
  notes: string | null;
  startedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
}

// ─── Sessions ──────────────────────────────────────────────────────

export interface BuildSession {
  id: string;
  phaseId: string;       // plan_id + "_" + phase_num
  planId: string;
  phaseNum: number;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  notes: string | null;
  status: string;        // active | completed | abandoned
}
