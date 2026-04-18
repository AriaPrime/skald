/**
 * Skald Database
 *
 * SQLite persistence for spec documents, chunks, plans, phases, and sessions.
 * Uses better-sqlite3 for proper file-level locking — multiple processes
 * (daemon, MCP server, CLI) can safely read and write simultaneously.
 */

import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import { embeddingToBuffer, bufferToEmbedding } from "./embeddings.js";
import type { SpecDocument, SpecChunk, Plan, Phase, BuildSession } from "./types.js";

export class SkaldDatabase {
  private db: Database.Database | null = null;
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  async init(): Promise<void> {
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");  // Write-Ahead Logging for concurrent reads
    this.db.pragma("busy_timeout = 5000"); // Wait up to 5s for locks
    this.createSchema();
  }

  private createSchema(): void {
    this.db!.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id            TEXT PRIMARY KEY,
        path          TEXT NOT NULL UNIQUE,
        title         TEXT,
        product       TEXT,
        subsystem     TEXT,
        status        TEXT DEFAULT 'draft',
        source_type   TEXT DEFAULT 'spec',
        supersedes    TEXT,
        date          TEXT,
        content_hash  TEXT,
        updated_at    INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id            TEXT PRIMARY KEY,
        doc_id        TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        heading       TEXT,
        heading_chain TEXT,
        content       TEXT NOT NULL,
        embedding     BLOB,
        updated_at    INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_doc_product ON documents(product);
      CREATE INDEX IF NOT EXISTS idx_doc_subsystem ON documents(subsystem);
      CREATE INDEX IF NOT EXISTS idx_doc_status ON documents(status);
      CREATE INDEX IF NOT EXISTS idx_chunk_doc ON chunks(doc_id);

      CREATE TABLE IF NOT EXISTS plans (
        id          TEXT PRIMARY KEY,
        product     TEXT NOT NULL UNIQUE,
        title       TEXT,
        description TEXT,
        updated_at  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS phases (
        id           TEXT PRIMARY KEY,
        plan_id      TEXT NOT NULL REFERENCES plans(id),
        phase_num    INTEGER NOT NULL,
        title        TEXT NOT NULL,
        description  TEXT,
        status       TEXT DEFAULT 'planned',
        spec_refs    TEXT,
        notes        TEXT,
        started_at   INTEGER,
        completed_at INTEGER,
        updated_at   INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_phase_plan ON phases(plan_id);
      CREATE INDEX IF NOT EXISTS idx_phase_status ON phases(status);

      CREATE TABLE IF NOT EXISTS sessions (
        id           TEXT PRIMARY KEY,
        phase_id     TEXT NOT NULL,
        plan_id      TEXT NOT NULL,
        phase_num    INTEGER NOT NULL,
        started_at   INTEGER NOT NULL,
        ended_at     INTEGER,
        duration_ms  INTEGER,
        notes        TEXT,
        status       TEXT DEFAULT 'active'
      );

      CREATE INDEX IF NOT EXISTS idx_session_phase ON sessions(phase_id);
      CREATE INDEX IF NOT EXISTS idx_session_status ON sessions(status);
    `);
  }

  // ─── Document Operations ─────────────────────────────────────────

  private _upsertDoc = this.lazy(() => this.db!.prepare(
    `INSERT OR REPLACE INTO documents (id, path, title, product, subsystem, status, source_type, supersedes, date, content_hash, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ));

  upsertDocument(doc: SpecDocument): void {
    this._upsertDoc().run(
      doc.id, doc.path, doc.title, doc.product, doc.subsystem, doc.status,
      doc.sourceType, doc.supersedes, doc.date, doc.contentHash, doc.updatedAt,
    );
  }

  getDocumentByPath(path: string): SpecDocument | null {
    const row = this.db!.prepare("SELECT * FROM documents WHERE path = ?").get(path) as any;
    return row ? this.rowToDocument(row) : null;
  }

  getDocumentById(id: string): SpecDocument | null {
    const row = this.db!.prepare("SELECT * FROM documents WHERE id = ?").get(id) as any;
    return row ? this.rowToDocument(row) : null;
  }

  findDocuments(filters: { subsystem?: string; product?: string; status?: string }): SpecDocument[] {
    const conditions: string[] = [];
    const params: any[] = [];
    if (filters.subsystem) { conditions.push("subsystem = ?"); params.push(filters.subsystem); }
    if (filters.product) { conditions.push("product = ?"); params.push(filters.product); }
    if (filters.status) { conditions.push("status = ?"); params.push(filters.status); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db!.prepare(`SELECT * FROM documents ${where}`).all(...params) as any[];
    return rows.map((r) => this.rowToDocument(r));
  }

  deleteDocumentChunks(docId: string): void {
    this.db!.prepare("DELETE FROM chunks WHERE doc_id = ?").run(docId);
  }

  private rowToDocument(row: any): SpecDocument {
    return {
      id: row.id,
      path: row.path,
      title: row.title,
      product: row.product,
      subsystem: row.subsystem,
      status: row.status,
      sourceType: row.source_type,
      supersedes: row.supersedes,
      date: row.date,
      contentHash: row.content_hash,
      updatedAt: row.updated_at,
    };
  }

  // ─── Chunk Operations ────────────────────────────────────────────

  private _upsertChunk = this.lazy(() => this.db!.prepare(
    `INSERT OR REPLACE INTO chunks (id, doc_id, heading, heading_chain, content, embedding, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ));

  insertChunk(chunk: SpecChunk): void {
    const embBlob = chunk.embedding ? embeddingToBuffer(chunk.embedding) : null;
    this._upsertChunk().run(
      chunk.id, chunk.docId, chunk.heading, chunk.headingChain, chunk.content, embBlob, chunk.updatedAt,
    );
  }

  getAllChunksWithEmbeddings(filters?: { status?: string; subsystem?: string; product?: string; sourceType?: string }): Array<SpecChunk & { docPath: string; docTitle: string; docStatus: string; docSubsystem: string | null; docProduct: string; docSourceType: string }> {
    const conditions: string[] = ["c.embedding IS NOT NULL"];
    const params: any[] = [];

    if (filters?.status) { conditions.push("d.status = ?"); params.push(filters.status); }
    if (filters?.subsystem) { conditions.push("d.subsystem = ?"); params.push(filters.subsystem); }
    if (filters?.product) { conditions.push("d.product = ?"); params.push(filters.product); }
    if (filters?.sourceType) { conditions.push("d.source_type = ?"); params.push(filters.sourceType); }

    const where = `WHERE ${conditions.join(" AND ")}`;
    const rows = this.db!.prepare(`
      SELECT c.*, d.path as doc_path, d.title as doc_title, d.status as doc_status,
             d.subsystem as doc_subsystem, d.product as doc_product, d.source_type as doc_source_type
      FROM chunks c JOIN documents d ON c.doc_id = d.id
      ${where}
    `).all(...params) as any[];

    return rows.map((row) => ({
      id: row.id,
      docId: row.doc_id,
      heading: row.heading,
      headingChain: row.heading_chain,
      content: row.content,
      embedding: row.embedding ? bufferToEmbedding(Buffer.from(row.embedding)) : null,
      updatedAt: row.updated_at,
      docPath: row.doc_path,
      docTitle: row.doc_title,
      docStatus: row.doc_status,
      docSubsystem: row.doc_subsystem,
      docProduct: row.doc_product,
      docSourceType: row.doc_source_type,
    }));
  }

  // ─── Plan Operations ──────────────────────────────────────────────

  upsertPlan(plan: Plan): void {
    this.db!.prepare(
      `INSERT OR REPLACE INTO plans (id, product, title, description, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run(plan.id, plan.product, plan.title, plan.description, plan.updatedAt);
  }

  getAllPlans(): Plan[] {
    const rows = this.db!.prepare("SELECT * FROM plans ORDER BY product").all() as any[];
    return rows.map((r) => ({
      id: r.id, product: r.product, title: r.title,
      description: r.description, updatedAt: r.updated_at,
    }));
  }

  getPlan(planId: string): Plan | null {
    const row = this.db!.prepare("SELECT * FROM plans WHERE id = ?").get(planId) as any;
    if (!row) return null;
    return { id: row.id, product: row.product, title: row.title, description: row.description, updatedAt: row.updated_at };
  }

  // ─── Phase Operations ─────────────────────────────────────────────

  upsertPhase(phase: Phase): void {
    this.db!.prepare(
      `INSERT OR REPLACE INTO phases (id, plan_id, phase_num, title, description, status, spec_refs, notes, started_at, completed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(phase.id, phase.planId, phase.phaseNum, phase.title, phase.description, phase.status, phase.specRefs, phase.notes, phase.startedAt, phase.completedAt, phase.updatedAt);
  }

  getPhases(planId: string): Phase[] {
    const rows = this.db!.prepare("SELECT * FROM phases WHERE plan_id = ? ORDER BY phase_num").all(planId) as any[];
    return rows.map((r) => this.rowToPhase(r));
  }

  getPhase(planId: string, phaseNum: number): Phase | null {
    const row = this.db!.prepare("SELECT * FROM phases WHERE plan_id = ? AND phase_num = ?").get(planId, phaseNum) as any;
    return row ? this.rowToPhase(row) : null;
  }

  updatePhaseStatus(planId: string, phaseNum: number, status: string, notes?: string): void {
    const now = Date.now();
    const updates: string[] = ["status = ?", "updated_at = ?"];
    const params: (string | number)[] = [status, now];

    if (status === "active") { updates.push("started_at = ?"); params.push(now); }
    else if (status === "completed") { updates.push("completed_at = ?"); params.push(now); }
    if (notes !== undefined) { updates.push("notes = ?"); params.push(notes); }

    params.push(planId, phaseNum);
    this.db!.prepare(`UPDATE phases SET ${updates.join(", ")} WHERE plan_id = ? AND phase_num = ?`).run(...params);
  }

  updatePhaseNotes(planId: string, phaseNum: number, notes: string): void {
    this.db!.prepare("UPDATE phases SET notes = ?, updated_at = ? WHERE plan_id = ? AND phase_num = ?")
      .run(notes, Date.now(), planId, phaseNum);
  }

  getAllPhasesGrouped(): Map<string, { plan: Plan; phases: Phase[] }> {
    const plans = this.getAllPlans();
    const grouped = new Map<string, { plan: Plan; phases: Phase[] }>();
    for (const plan of plans) {
      grouped.set(plan.id, { plan, phases: this.getPhases(plan.id) });
    }
    return grouped;
  }

  private rowToPhase(row: any): Phase {
    return {
      id: row.id, planId: row.plan_id, phaseNum: row.phase_num,
      title: row.title, description: row.description, status: row.status,
      specRefs: row.spec_refs, notes: row.notes,
      startedAt: row.started_at, completedAt: row.completed_at, updatedAt: row.updated_at,
    };
  }

  // ─── Session Operations ────────────────────────────────────────────

  startSession(planId: string, phaseNum: number): BuildSession {
    const now = Date.now();
    const phaseId = `${planId}_${phaseNum}`;
    const id = `${phaseId}_${now}`;
    this.db!.prepare(
      `INSERT INTO sessions (id, phase_id, plan_id, phase_num, started_at, status) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, phaseId, planId, phaseNum, now, "active");
    return { id, phaseId, planId, phaseNum, startedAt: now, endedAt: null, durationMs: null, notes: null, status: "active" };
  }

  endSession(sessionId: string, status: string, notes?: string): void {
    const now = Date.now();
    const row = this.db!.prepare("SELECT started_at FROM sessions WHERE id = ?").get(sessionId) as any;
    const durationMs = row ? now - row.started_at : null;
    this.db!.prepare(
      `UPDATE sessions SET ended_at = ?, duration_ms = ?, notes = ?, status = ? WHERE id = ?`
    ).run(now, durationMs, notes || null, status, sessionId);
  }

  getActiveSessions(): BuildSession[] {
    const rows = this.db!.prepare("SELECT * FROM sessions WHERE status = 'active' ORDER BY started_at DESC").all() as any[];
    return rows.map((r) => this.rowToSession(r));
  }

  getSessionsForPhase(phaseId: string): BuildSession[] {
    const rows = this.db!.prepare("SELECT * FROM sessions WHERE phase_id = ? ORDER BY started_at DESC").all(phaseId) as any[];
    return rows.map((r) => this.rowToSession(r));
  }

  getAllSessionStats(): Map<string, { count: number; totalMs: number; lastAt: number | null }> {
    const stats = new Map<string, { count: number; totalMs: number; lastAt: number | null }>();
    const rows = this.db!.prepare(
      `SELECT phase_id, COUNT(*) as cnt, COALESCE(SUM(duration_ms), 0) as total_ms, MAX(started_at) as last_at
       FROM sessions GROUP BY phase_id`
    ).all() as any[];
    for (const row of rows) {
      stats.set(row.phase_id, { count: row.cnt, totalMs: row.total_ms, lastAt: row.last_at });
    }
    return stats;
  }

  private rowToSession(row: any): BuildSession {
    return {
      id: row.id, phaseId: row.phase_id, planId: row.plan_id,
      phaseNum: row.phase_num, startedAt: row.started_at, endedAt: row.ended_at,
      durationMs: row.duration_ms, notes: row.notes, status: row.status,
    };
  }

  // ─── Stats ────────────────────────────────────────────────────────

  stats(): { documents: number; chunks: number; withEmbeddings: number } {
    const docs = (this.db!.prepare("SELECT COUNT(*) as c FROM documents").get() as any).c;
    const chunks = (this.db!.prepare("SELECT COUNT(*) as c FROM chunks").get() as any).c;
    const embedded = (this.db!.prepare("SELECT COUNT(*) as c FROM chunks WHERE embedding IS NOT NULL").get() as any).c;
    return { documents: docs, chunks, withEmbeddings: embedded };
  }

  // ─── Persistence ─────────────────────────────────────────────────

  async flush(): Promise<void> {
    // No-op: better-sqlite3 writes to disk immediately.
    // Kept for API compatibility with existing callers.
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  /** Lazy-init a prepared statement (created on first use, after db is open). */
  private lazy<T>(factory: () => T): () => T {
    let cached: T | null = null;
    return () => {
      if (!cached) cached = factory();
      return cached;
    };
  }
}
