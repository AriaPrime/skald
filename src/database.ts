/**
 * Skald Database
 *
 * SQLite persistence for spec documents and chunks with embeddings.
 * Uses sql.js (pure JS, same as @vessel/core) for portability.
 */

import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname } from "path";
import { embeddingToBuffer, bufferToEmbedding } from "./embeddings.js";
import type { SpecDocument, SpecChunk, Plan, Phase } from "./types.js";

export class SkaldDatabase {
  private db: SqlJsDatabase | null = null;
  private dbPath: string;
  private dirty = false;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  async init(): Promise<void> {
    const SQL = await initSqlJs();

    try {
      const buffer = await readFile(this.dbPath);
      this.db = new SQL.Database(buffer);
    } catch {
      this.db = new SQL.Database();
    }

    this.createSchema();
  }

  private createSchema(): void {
    this.db!.run(`
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
    `);
    this.dirty = true;
  }

  // ─── Document Operations ─────────────────────────────────────────

  upsertDocument(doc: SpecDocument): void {
    this.db!.run(
      `INSERT OR REPLACE INTO documents (id, path, title, product, subsystem, status, source_type, supersedes, date, content_hash, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [doc.id, doc.path, doc.title, doc.product, doc.subsystem, doc.status, doc.sourceType, doc.supersedes, doc.date, doc.contentHash, doc.updatedAt],
    );
    this.dirty = true;
  }

  getDocumentByPath(path: string): SpecDocument | null {
    const stmt = this.db!.prepare("SELECT * FROM documents WHERE path = ?");
    stmt.bind([path]);
    if (!stmt.step()) { stmt.free(); return null; }
    const row = stmt.getAsObject();
    stmt.free();
    return {
      id: row.id as string,
      path: row.path as string,
      title: row.title as string,
      product: row.product as string,
      subsystem: row.subsystem as string | null,
      status: row.status as string,
      sourceType: row.source_type as string,
      supersedes: row.supersedes as string | null,
      date: row.date as string | null,
      contentHash: row.content_hash as string,
      updatedAt: row.updated_at as number,
    };
  }

  getDocumentById(id: string): SpecDocument | null {
    const stmt = this.db!.prepare("SELECT * FROM documents WHERE id = ?");
    stmt.bind([id]);
    if (!stmt.step()) { stmt.free(); return null; }
    const row = stmt.getAsObject();
    stmt.free();
    return {
      id: row.id as string,
      path: row.path as string,
      title: row.title as string,
      product: row.product as string,
      subsystem: row.subsystem as string | null,
      status: row.status as string,
      sourceType: row.source_type as string,
      supersedes: row.supersedes as string | null,
      date: row.date as string | null,
      contentHash: row.content_hash as string,
      updatedAt: row.updated_at as number,
    };
  }

  findDocuments(filters: { subsystem?: string; product?: string; status?: string }): SpecDocument[] {
    const conditions: string[] = [];
    const params: string[] = [];
    if (filters.subsystem) { conditions.push("subsystem = ?"); params.push(filters.subsystem); }
    if (filters.product) { conditions.push("product = ?"); params.push(filters.product); }
    if (filters.status) { conditions.push("status = ?"); params.push(filters.status); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const stmt = this.db!.prepare(`SELECT * FROM documents ${where}`);
    if (params.length > 0) stmt.bind(params);

    const results: SpecDocument[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      results.push({
        id: row.id as string,
        path: row.path as string,
        title: row.title as string,
        product: row.product as string,
        subsystem: row.subsystem as string | null,
        status: row.status as string,
        sourceType: row.source_type as string,
        supersedes: row.supersedes as string | null,
        date: row.date as string | null,
        contentHash: row.content_hash as string,
        updatedAt: row.updated_at as number,
      });
    }
    stmt.free();
    return results;
  }

  deleteDocumentChunks(docId: string): void {
    this.db!.run("DELETE FROM chunks WHERE doc_id = ?", [docId]);
    this.dirty = true;
  }

  // ─── Chunk Operations ────────────────────────────────────────────

  insertChunk(chunk: SpecChunk): void {
    const embBlob = chunk.embedding ? embeddingToBuffer(chunk.embedding) : null;
    this.db!.run(
      `INSERT OR REPLACE INTO chunks (id, doc_id, heading, heading_chain, content, embedding, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [chunk.id, chunk.docId, chunk.heading, chunk.headingChain, chunk.content, embBlob, chunk.updatedAt],
    );
    this.dirty = true;
  }

  getAllChunksWithEmbeddings(filters?: { status?: string; subsystem?: string; product?: string; sourceType?: string }): Array<SpecChunk & { docPath: string; docTitle: string; docStatus: string; docSubsystem: string | null; docProduct: string; docSourceType: string }> {
    const conditions: string[] = ["c.embedding IS NOT NULL"];
    const params: string[] = [];

    if (filters?.status) { conditions.push("d.status = ?"); params.push(filters.status); }
    if (filters?.subsystem) { conditions.push("d.subsystem = ?"); params.push(filters.subsystem); }
    if (filters?.product) { conditions.push("d.product = ?"); params.push(filters.product); }
    if (filters?.sourceType) { conditions.push("d.source_type = ?"); params.push(filters.sourceType); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const stmt = this.db!.prepare(`
      SELECT c.*, d.path as doc_path, d.title as doc_title, d.status as doc_status,
             d.subsystem as doc_subsystem, d.product as doc_product, d.source_type as doc_source_type
      FROM chunks c JOIN documents d ON c.doc_id = d.id
      ${where}
    `);
    if (params.length > 0) stmt.bind(params);

    const results: Array<SpecChunk & { docPath: string; docTitle: string; docStatus: string; docSubsystem: string | null; docProduct: string; docSourceType: string }> = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      const embBuf = row.embedding as Uint8Array | null;
      results.push({
        id: row.id as string,
        docId: row.doc_id as string,
        heading: row.heading as string | null,
        headingChain: row.heading_chain as string | null,
        content: row.content as string,
        embedding: embBuf ? bufferToEmbedding(Buffer.from(embBuf)) : null,
        updatedAt: row.updated_at as number,
        docPath: row.doc_path as string,
        docTitle: row.doc_title as string,
        docStatus: row.doc_status as string,
        docSubsystem: row.doc_subsystem as string | null,
        docProduct: row.doc_product as string,
        docSourceType: row.doc_source_type as string,
      });
    }
    stmt.free();
    return results;
  }

  // ─── Plan Operations ──────────────────────────────────────────────

  upsertPlan(plan: Plan): void {
    this.db!.run(
      `INSERT OR REPLACE INTO plans (id, product, title, description, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [plan.id, plan.product, plan.title, plan.description, plan.updatedAt],
    );
    this.dirty = true;
  }

  getAllPlans(): Plan[] {
    const stmt = this.db!.prepare("SELECT * FROM plans ORDER BY product");
    const results: Plan[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      results.push({
        id: row.id as string,
        product: row.product as string,
        title: row.title as string,
        description: row.description as string | null,
        updatedAt: row.updated_at as number,
      });
    }
    stmt.free();
    return results;
  }

  getPlan(planId: string): Plan | null {
    const stmt = this.db!.prepare("SELECT * FROM plans WHERE id = ?");
    stmt.bind([planId]);
    if (!stmt.step()) { stmt.free(); return null; }
    const row = stmt.getAsObject();
    stmt.free();
    return {
      id: row.id as string,
      product: row.product as string,
      title: row.title as string,
      description: row.description as string | null,
      updatedAt: row.updated_at as number,
    };
  }

  // ─── Phase Operations ─────────────────────────────────────────────

  upsertPhase(phase: Phase): void {
    this.db!.run(
      `INSERT OR REPLACE INTO phases (id, plan_id, phase_num, title, description, status, spec_refs, notes, started_at, completed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [phase.id, phase.planId, phase.phaseNum, phase.title, phase.description, phase.status, phase.specRefs, phase.notes, phase.startedAt, phase.completedAt, phase.updatedAt],
    );
    this.dirty = true;
  }

  getPhases(planId: string): Phase[] {
    const stmt = this.db!.prepare("SELECT * FROM phases WHERE plan_id = ? ORDER BY phase_num");
    stmt.bind([planId]);
    const results: Phase[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      results.push(this.rowToPhase(row));
    }
    stmt.free();
    return results;
  }

  getPhase(planId: string, phaseNum: number): Phase | null {
    const stmt = this.db!.prepare("SELECT * FROM phases WHERE plan_id = ? AND phase_num = ?");
    stmt.bind([planId, phaseNum]);
    if (!stmt.step()) { stmt.free(); return null; }
    const row = stmt.getAsObject();
    stmt.free();
    return this.rowToPhase(row);
  }

  updatePhaseStatus(planId: string, phaseNum: number, status: string, notes?: string): void {
    const now = Date.now();
    const updates: string[] = ["status = ?", "updated_at = ?"];
    const params: (string | number)[] = [status, now];

    if (status === "active") {
      updates.push("started_at = ?");
      params.push(now);
    } else if (status === "completed") {
      updates.push("completed_at = ?");
      params.push(now);
    }

    if (notes !== undefined) {
      updates.push("notes = ?");
      params.push(notes);
    }

    params.push(planId, phaseNum);
    this.db!.run(
      `UPDATE phases SET ${updates.join(", ")} WHERE plan_id = ? AND phase_num = ?`,
      params,
    );
    this.dirty = true;
  }

  updatePhaseNotes(planId: string, phaseNum: number, notes: string): void {
    this.db!.run(
      "UPDATE phases SET notes = ?, updated_at = ? WHERE plan_id = ? AND phase_num = ?",
      [notes, Date.now(), planId, phaseNum],
    );
    this.dirty = true;
  }

  getAllPhasesGrouped(): Map<string, { plan: Plan; phases: Phase[] }> {
    const plans = this.getAllPlans();
    const grouped = new Map<string, { plan: Plan; phases: Phase[] }>();
    for (const plan of plans) {
      grouped.set(plan.id, { plan, phases: this.getPhases(plan.id) });
    }
    return grouped;
  }

  private rowToPhase(row: Record<string, any>): Phase {
    return {
      id: row.id as string,
      planId: row.plan_id as string,
      phaseNum: row.phase_num as number,
      title: row.title as string,
      description: row.description as string | null,
      status: row.status as string,
      specRefs: row.spec_refs as string | null,
      notes: row.notes as string | null,
      startedAt: row.started_at as number | null,
      completedAt: row.completed_at as number | null,
      updatedAt: row.updated_at as number,
    };
  }

  // ─── Stats ────────────────────────────────────────────────────────

  stats(): { documents: number; chunks: number; withEmbeddings: number } {
    const docs = this.db!.exec("SELECT COUNT(*) FROM documents")[0]?.values[0]?.[0] as number ?? 0;
    const chunks = this.db!.exec("SELECT COUNT(*) FROM chunks")[0]?.values[0]?.[0] as number ?? 0;
    const embedded = this.db!.exec("SELECT COUNT(*) FROM chunks WHERE embedding IS NOT NULL")[0]?.values[0]?.[0] as number ?? 0;
    return { documents: docs, chunks, withEmbeddings: embedded };
  }

  // ─── Persistence ─────────────────────────────────────────────────

  async flush(): Promise<void> {
    if (!this.dirty || !this.db) return;
    const data = this.db.export();
    await mkdir(dirname(this.dbPath), { recursive: true });
    await writeFile(this.dbPath, Buffer.from(data));
    this.dirty = false;
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
