/**
 * Skald Dashboard Generator
 *
 * Generates a self-contained HTML dashboard showing the spec corpus state.
 * ANIMUS visual style: dark glass morphism, amber accent, Inter font.
 */

import { SkaldDatabase } from "./database.js";
import { writeFile } from "fs/promises";
import type { Plan, Phase, BuildSession } from "./types.js";

interface DashboardData {
  generated: string;
  stats: { documents: number; chunks: number; withEmbeddings: number };
  byProduct: Record<string, number>;
  byStatus: Record<string, number>;
  bySourceType: Record<string, number>;
  subsystems: Array<{ product: string; subsystem: string; status: string; title: string; path: string; date: string | null }>;
  lintIssues: Array<{ type: string; message: string }>;
  recentDocs: Array<{ title: string; product: string; subsystem: string | null; status: string; path: string; date: string | null }>;
  plans: Array<{ plan: Plan; phases: Phase[] }>;
  sessionStats: Map<string, { count: number; totalMs: number; lastAt: number | null }>;
  activeSessions: BuildSession[];
}

export function gatherDashboardData(db: SkaldDatabase): DashboardData {
  const stats = db.stats();
  const allDocs = db.findDocuments({});

  // By product
  const byProduct: Record<string, number> = {};
  for (const doc of allDocs) {
    byProduct[doc.product] = (byProduct[doc.product] || 0) + 1;
  }

  // By status
  const byStatus: Record<string, number> = {};
  for (const doc of allDocs) {
    byStatus[doc.status] = (byStatus[doc.status] || 0) + 1;
  }

  // By source type
  const bySourceType: Record<string, number> = {};
  for (const doc of allDocs) {
    bySourceType[doc.sourceType] = (bySourceType[doc.sourceType] || 0) + 1;
  }

  // Subsystem map
  const subsystems = allDocs
    .filter((d) => d.subsystem)
    .map((d) => ({
      product: d.product,
      subsystem: d.subsystem!,
      status: d.status,
      title: d.title,
      path: d.path,
      date: d.date,
    }))
    .sort((a, b) => a.product.localeCompare(b.product) || a.subsystem.localeCompare(b.subsystem));

  // Lint issues
  const currentDocs = allDocs.filter((d) => d.status === "current");
  const bySubKey = new Map<string, typeof allDocs>();
  for (const doc of currentDocs) {
    if (!doc.subsystem) continue;
    const key = `${doc.product}/${doc.subsystem}`;
    if (!bySubKey.has(key)) bySubKey.set(key, []);
    bySubKey.get(key)!.push(doc);
  }
  const lintIssues: Array<{ type: string; message: string }> = [];
  for (const [key, docs] of bySubKey) {
    if (docs.length > 1) {
      lintIssues.push({
        type: "dual-current",
        message: `${key}: ${docs.map((d) => d.path.split("\\").pop()).join(", ")}`,
      });
    }
  }

  // Recent docs (by date)
  const recentDocs = [...allDocs]
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, 12)
    .map((d) => ({
      title: d.title,
      product: d.product,
      subsystem: d.subsystem,
      status: d.status,
      path: d.path,
      date: d.date,
    }));

  // Plans
  const plansGrouped = db.getAllPhasesGrouped();
  const plans = Array.from(plansGrouped.values());

  // Sessions
  const sessionStats = db.getAllSessionStats();
  const activeSessions = db.getActiveSessions();

  return {
    generated: new Date().toISOString(),
    stats,
    byProduct,
    byStatus,
    bySourceType,
    subsystems,
    lintIssues,
    recentDocs,
    plans,
    sessionStats,
    activeSessions,
  };
}

export function generateDashboardHtml(data: DashboardData): string {
  const statusColors: Record<string, string> = {
    current: "#4CAF50",
    completed: "#E8863C",
    superseded: "#666",
    draft: "#8B7355",
    review: "#6A9FD8",
  };

  const productEmoji: Record<string, string> = {
    vessel: "V",
    animus: "A",
    mimir: "M",
    skald: "S",
    futodama: "F",
    tenjin: "T",
    yomi: "Y",
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Skald — Spec Index Dashboard</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@200;300;400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --bg-deep: #0B0C10;
    --bg-mid: rgba(16,17,24,0.85);
    --bg-glass: rgba(255,255,255,0.045);
    --bg-glass-elevated: rgba(255,255,255,0.065);
    --bg-surface: rgba(255,255,255,0.03);
    --border-glass: rgba(255,255,255,0.07);
    --border-glass-strong: rgba(255,255,255,0.12);
    --border-glass-top: rgba(255,255,255,0.15);
    --accent: #E8863C;
    --accent-dim: rgba(232,134,60,0.12);
    --accent-subtle: rgba(232,134,60,0.07);
    --accent-text: #F5A664;
    --accent-muted: rgba(232,134,60,0.5);
    --text-primary: #E8E6E1;
    --text-secondary: rgba(232,230,225,0.50);
    --text-tertiary: rgba(232,230,225,0.25);
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: 'Inter', -apple-system, sans-serif;
    background: var(--bg-deep);
    color: var(--text-primary);
    min-height: 100vh;
    overflow-x: hidden;
  }

  /* Ambient orbs */
  .orb {
    position: fixed;
    border-radius: 50%;
    filter: blur(80px);
    pointer-events: none;
    z-index: 0;
  }
  .orb1 { width: 450px; height: 450px; background: rgba(232,134,60,0.06); top: -100px; right: -50px; }
  .orb2 { width: 300px; height: 300px; background: rgba(232,134,60,0.035); bottom: 10%; left: -80px; }
  .orb3 { width: 250px; height: 250px; background: rgba(232,134,60,0.03); bottom: -50px; right: 20%; }

  .container {
    position: relative;
    z-index: 1;
    max-width: 1400px;
    margin: 0 auto;
    padding: 2rem 2.5rem;
  }

  /* Header */
  .header {
    display: flex;
    align-items: baseline;
    gap: 16px;
    margin-bottom: 2rem;
    padding-bottom: 1.5rem;
    border-bottom: 0.5px solid var(--border-glass);
  }
  .header h1 {
    font-size: 22px;
    font-weight: 500;
    letter-spacing: 0.02em;
  }
  .header h1 span { color: var(--accent); }
  .header .subtitle {
    font-size: 11px;
    color: var(--text-tertiary);
    font-weight: 400;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .header .timestamp {
    margin-left: auto;
    font-size: 10.5px;
    color: var(--text-tertiary);
    font-weight: 300;
  }

  /* Glass card */
  .card {
    position: relative;
    background: var(--bg-glass);
    backdrop-filter: blur(24px) saturate(1.1);
    -webkit-backdrop-filter: blur(24px) saturate(1.1);
    border: 0.5px solid var(--border-glass);
    border-radius: 10px;
    padding: 1.25rem;
    overflow: visible;
  }
  .card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 1px;
    background: linear-gradient(90deg, transparent, var(--border-glass-top), transparent);
  }
  .card::after {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0; bottom: 0;
    background: linear-gradient(170deg, rgba(255,255,255,0.03) 0%, transparent 40%);
    pointer-events: none;
    border-radius: 10px;
  }

  .card-title {
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-secondary);
    margin-bottom: 1rem;
  }

  /* Metrics row */
  .metrics {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
    margin-bottom: 1.5rem;
  }
  .metric-value {
    font-size: 32px;
    font-weight: 300;
    color: var(--text-primary);
    line-height: 1;
    margin-bottom: 4px;
  }
  .metric-value.accent { color: var(--accent); }
  .metric-label {
    font-size: 11px;
    color: var(--text-secondary);
    font-weight: 400;
  }

  /* Grid layouts */
  .grid-2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    margin-bottom: 10px;
  }
  .grid-3 {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 10px;
    margin-bottom: 10px;
  }

  /* Bar chart */
  .bar-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
  }
  .bar-label {
    font-size: 11.5px;
    font-weight: 400;
    color: var(--text-secondary);
    width: 100px;
    text-align: right;
    flex-shrink: 0;
  }
  .bar-track {
    flex: 1;
    height: 20px;
    background: var(--bg-surface);
    border-radius: 4px;
    overflow: hidden;
    position: relative;
  }
  .bar-fill {
    height: 100%;
    border-radius: 4px;
    transition: width 0.6s ease;
    position: relative;
  }
  .bar-count {
    font-size: 10.5px;
    font-weight: 500;
    color: var(--text-primary);
    width: 30px;
    text-align: right;
    flex-shrink: 0;
  }

  /* Status badge */
  .badge {
    display: inline-block;
    font-size: 9.5px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 4px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .badge-current { background: rgba(76,175,80,0.15); color: #81C784; border: 0.5px solid rgba(76,175,80,0.2); }
  .badge-completed { background: var(--accent-dim); color: var(--accent-text); border: 0.5px solid rgba(232,134,60,0.15); }
  .badge-superseded { background: rgba(255,255,255,0.04); color: var(--text-tertiary); border: 0.5px solid rgba(255,255,255,0.06); }
  .badge-draft { background: rgba(139,115,85,0.12); color: #C4A882; border: 0.5px solid rgba(139,115,85,0.15); }
  .badge-review { background: rgba(106,159,216,0.12); color: #6A9FD8; border: 0.5px solid rgba(106,159,216,0.15); }

  /* Product badge */
  .product-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 5px;
    font-size: 10px;
    font-weight: 600;
    background: var(--accent-dim);
    color: var(--accent-text);
    border: 0.5px solid rgba(232,134,60,0.12);
    flex-shrink: 0;
  }

  /* Subsystem table */
  .sub-table {
    width: 100%;
  }
  .sub-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 0;
    border-bottom: 0.5px solid rgba(255,255,255,0.03);
    font-size: 11.5px;
  }
  .sub-row:last-child { border-bottom: none; }
  .sub-name {
    flex: 1;
    font-weight: 400;
    color: var(--text-primary);
  }
  .sub-product {
    font-size: 10px;
    color: var(--text-tertiary);
    width: 60px;
  }
  .sub-path {
    font-size: 10px;
    color: var(--text-tertiary);
    max-width: 300px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Lint issues */
  .lint-item {
    padding: 10px 12px;
    background: rgba(232,134,60,0.04);
    border: 0.5px solid rgba(232,134,60,0.1);
    border-radius: 6px;
    margin-bottom: 6px;
    font-size: 11px;
    color: var(--text-secondary);
    line-height: 1.5;
  }
  .lint-type {
    font-size: 9.5px;
    font-weight: 600;
    text-transform: uppercase;
    color: var(--accent-text);
    letter-spacing: 0.06em;
    margin-bottom: 2px;
  }
  .lint-ok {
    padding: 12px;
    text-align: center;
    font-size: 11.5px;
    color: #81C784;
    font-weight: 400;
  }

  /* Recent docs list */
  .recent-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 0;
    border-bottom: 0.5px solid rgba(255,255,255,0.03);
  }
  .recent-item:last-child { border-bottom: none; }
  .recent-title {
    flex: 1;
    font-size: 11.5px;
    font-weight: 400;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .recent-meta {
    font-size: 10px;
    color: var(--text-tertiary);
    white-space: nowrap;
  }

  /* Donut chart */
  .donut-container {
    display: flex;
    align-items: center;
    gap: 1.5rem;
  }
  .donut-svg { flex-shrink: 0; }
  .donut-legend {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .legend-item {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: var(--text-secondary);
  }
  .legend-dot {
    width: 8px;
    height: 8px;
    border-radius: 2px;
    flex-shrink: 0;
  }
  .legend-count {
    margin-left: auto;
    font-weight: 500;
    color: var(--text-primary);
    min-width: 20px;
    text-align: right;
  }

  /* Filter tabs */
  .filter-tabs {
    display: flex;
    gap: 2px;
    margin-bottom: 1rem;
    background: rgba(255,255,255,0.03);
    border-radius: 6px;
    padding: 3px;
    border: 0.5px solid var(--border-glass);
  }
  .filter-tab {
    padding: 5px 14px;
    font-size: 10.5px;
    font-weight: 500;
    color: var(--text-tertiary);
    cursor: pointer;
    border-radius: 4px;
    border: 0.5px solid transparent;
    transition: all 0.2s;
    background: transparent;
  }
  .filter-tab:hover { color: var(--text-secondary); }
  .filter-tab.active {
    background: var(--accent-dim);
    color: var(--accent-text);
    border-color: rgba(232,134,60,0.12);
  }

  /* Scrollable card body */
  .card-scroll {
    max-height: 380px;
    overflow-y: auto;
    margin: 0 -1.25rem;
    padding: 0 1.25rem;
  }
  .card-scroll::-webkit-scrollbar { width: 4px; }
  .card-scroll::-webkit-scrollbar-track { background: transparent; }
  .card-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }

  /* View tabs (top-level nav) */
  .view-tabs {
    display: flex;
    gap: 0;
    margin-bottom: 1.5rem;
    border-bottom: 0.5px solid var(--border-glass);
  }
  .view-tab {
    padding: 10px 24px;
    font-size: 12px;
    font-weight: 500;
    color: var(--text-tertiary);
    cursor: pointer;
    border-bottom: 2px solid transparent;
    transition: all 0.2s;
    letter-spacing: 0.04em;
  }
  .view-tab:hover { color: var(--text-secondary); }
  .view-tab.active {
    color: var(--accent-text);
    border-bottom-color: var(--accent);
  }
  .view-content { display: none; }
  .view-content.active { display: block; }

  /* Phase pipeline */
  .plan-card {
    margin-bottom: 10px;
  }
  .plan-header {
    display: flex;
    align-items: baseline;
    gap: 12px;
    margin-bottom: 4px;
  }
  .plan-title {
    font-size: 14px;
    font-weight: 500;
    color: var(--text-primary);
  }
  .plan-desc {
    font-size: 11px;
    color: var(--text-tertiary);
    margin-bottom: 1rem;
  }

  .phase-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 14px;
    margin-bottom: 4px;
    background: var(--bg-surface);
    border: 0.5px solid rgba(255,255,255,0.03);
    border-radius: 8px;
    transition: border-color 0.2s;
  }
  .phase-row:hover {
    border-color: var(--border-glass);
  }
  .phase-row.active-phase {
    border-color: rgba(76,175,80,0.3);
    background: rgba(76,175,80,0.04);
  }

  .phase-num {
    font-size: 10px;
    font-weight: 600;
    color: var(--text-tertiary);
    width: 14px;
    text-align: center;
    flex-shrink: 0;
  }
  .phase-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .phase-dot.completed { background: var(--accent); box-shadow: 0 0 6px rgba(232,134,60,0.3); }
  .phase-dot.active { background: #4CAF50; box-shadow: 0 0 6px rgba(76,175,80,0.4); animation: pulse 2s infinite; }
  .phase-dot.planned { background: rgba(255,255,255,0.1); }
  .phase-dot.skipped { background: rgba(255,255,255,0.06); }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  .phase-title {
    flex: 1;
    font-size: 12px;
    font-weight: 400;
    color: var(--text-primary);
  }
  .phase-desc {
    font-size: 10.5px;
    color: var(--text-tertiary);
    max-width: 350px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .btn-initiate {
    padding: 4px 14px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    background: linear-gradient(135deg, #E8863C, #C56A2A);
    color: #0B0C10;
    border: none;
    border-radius: 5px;
    cursor: pointer;
    transition: all 0.2s;
    flex-shrink: 0;
  }
  .btn-initiate:hover {
    box-shadow: 0 1px 10px rgba(232,134,60,0.3);
    transform: translateY(-1px);
  }
  .btn-initiate:active { transform: translateY(0); }

  .phase-date {
    font-size: 9.5px;
    color: var(--text-tertiary);
    white-space: nowrap;
  }

  /* Progress bar for plan */
  .plan-progress {
    display: flex;
    gap: 3px;
    margin-bottom: 1rem;
  }
  .progress-segment {
    height: 4px;
    border-radius: 2px;
    flex: 1;
  }

  /* Copied toast */
  .toast {
    position: fixed;
    bottom: 2rem;
    left: 50%;
    transform: translateX(-50%) translateY(20px);
    background: var(--bg-glass-elevated);
    backdrop-filter: blur(20px);
    border: 0.5px solid var(--border-glass-strong);
    border-radius: 8px;
    padding: 10px 24px;
    font-size: 12px;
    color: var(--accent-text);
    font-weight: 500;
    opacity: 0;
    transition: all 0.3s;
    pointer-events: none;
    z-index: 100;
  }
  .toast.show {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }

  /* No plans state */
  .empty-state {
    text-align: center;
    padding: 3rem 2rem;
    color: var(--text-tertiary);
    font-size: 12px;
  }
  .empty-state code {
    background: var(--bg-glass);
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    color: var(--text-secondary);
  }
</style>
</head>
<body>

<div class="orb orb1"></div>
<div class="orb orb2"></div>
<div class="orb orb3"></div>

<div class="container">
  <div class="header">
    <h1><span>Skald</span> Spec Index</h1>
    <div class="subtitle">Privateers AI Specification Corpus</div>
    <div class="timestamp">Generated ${new Date(data.generated).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })} at ${new Date(data.generated).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</div>
  </div>

  <!-- View Tabs -->
  <div class="view-tabs">
    <div class="view-tab active" data-view="plans">Plans</div>
    <div class="view-tab" data-view="index">Index</div>
  </div>

  <!-- ═══ PLANS VIEW ═══ -->
  <div class="view-content active" id="view-plans">
    ${data.plans.length === 0
      ? `<div class="card"><div class="empty-state">No plans yet.<br><br>Create one with: <code>skald plan add vessel "VESSEL Platform"</code></div></div>`
      : data.plans.map(({ plan, phases }) => {
          const completed = phases.filter((p) => p.status === "completed").length;
          const total = phases.length;
          return `
    <div class="card plan-card">
      <div class="plan-header">
        <div class="product-badge">${(productEmoji[plan.product] || plan.product[0] || "?").toUpperCase()}</div>
        <div class="plan-title">${plan.title || plan.product.toUpperCase()}</div>
        <span style="font-size:10.5px; color:var(--text-tertiary)">${completed}/${total} phases</span>
      </div>
      ${plan.description ? `<div class="plan-desc">${plan.description}</div>` : ""}
      <div class="plan-progress">
        ${phases.map((p) => `<div class="progress-segment" style="background: ${
          p.status === "completed" ? "var(--accent)" :
          p.status === "active" ? "#4CAF50" :
          p.status === "skipped" ? "rgba(255,255,255,0.06)" :
          "rgba(255,255,255,0.08)"
        }"></div>`).join("")}
      </div>
      ${phases.map((p) => {
        const isNextPlanned = p.status === "planned" && phases.filter((x) => x.status === "active").length === 0 &&
          phases.filter((x) => x.phaseNum < p.phaseNum && x.status !== "completed" && x.status !== "skipped").length === 0;
        const dateStr = p.status === "completed" && p.completedAt
          ? new Date(p.completedAt).toISOString().split("T")[0]
          : p.status === "active" && p.startedAt
          ? "started " + new Date(p.startedAt).toISOString().split("T")[0]
          : "";
        const phaseId = `${plan.id}_${p.phaseNum}`;
        const sessStats = data.sessionStats.get(phaseId);
        const sessInfo = sessStats
          ? (() => {
              const totalHrs = Math.floor(sessStats.totalMs / 3600000);
              const totalMins = Math.floor((sessStats.totalMs % 3600000) / 60000);
              const timeStr = totalHrs > 0 ? `${totalHrs}h${totalMins}m` : `${totalMins}m`;
              return `${sessStats.count} session${sessStats.count !== 1 ? "s" : ""}, ${timeStr}`;
            })()
          : null;
        const hasActiveSession = data.activeSessions.some((s) => s.phaseId === phaseId);
        return `
        <div class="phase-row${p.status === "active" ? " active-phase" : ""}${hasActiveSession ? " has-active-session" : ""}" data-plan="${plan.id}" data-phase="${p.phaseNum}">
          <div class="phase-num">${p.phaseNum}</div>
          <div class="phase-dot ${p.status}"></div>
          <div class="phase-title">${p.title}</div>
          ${p.description ? `<div class="phase-desc">${p.description}</div>` : ""}
          ${sessInfo ? `<div class="phase-date">${sessInfo}</div>` : ""}
          <span class="badge badge-${p.status === "planned" ? "draft" : p.status === "active" ? "current" : p.status}">${p.status}</span>
          ${dateStr ? `<div class="phase-date">${dateStr}</div>` : ""}
          ${(p.status === "planned" && isNextPlanned) ? `<button class="btn-initiate" onclick="initPhase('${plan.id}', ${p.phaseNum})">Initiate</button>` : ""}
        </div>`;
      }).join("")}
    </div>`;
        }).join("")}
  </div>

  <!-- ═══ INDEX VIEW ═══ -->
  <div class="view-content" id="view-index">

  <!-- Metrics -->
  <div class="metrics">
    <div class="card">
      <div class="metric-value accent">${data.stats.documents}</div>
      <div class="metric-label">Documents Indexed</div>
    </div>
    <div class="card">
      <div class="metric-value">${data.stats.chunks.toLocaleString()}</div>
      <div class="metric-label">Searchable Chunks</div>
    </div>
    <div class="card">
      <div class="metric-value">${data.stats.withEmbeddings.toLocaleString()}</div>
      <div class="metric-label">Embeddings</div>
    </div>
    <div class="card">
      <div class="metric-value${data.lintIssues.length > 0 ? "" : " accent"}">${data.lintIssues.length}</div>
      <div class="metric-label">Lint Issues</div>
    </div>
  </div>

  <!-- Status donut + Products bar -->
  <div class="grid-2">
    <div class="card">
      <div class="card-title">Status Breakdown</div>
      <div class="donut-container">
        ${generateDonutSvg(data.byStatus, statusColors)}
        <div class="donut-legend">
          ${Object.entries(data.byStatus)
            .sort((a, b) => b[1] - a[1])
            .map(([status, count]) => `
              <div class="legend-item">
                <div class="legend-dot" style="background: ${statusColors[status] || "#666"}"></div>
                <span>${status}</span>
                <span class="legend-count">${count}</span>
              </div>
            `).join("")}
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">By Product</div>
      ${Object.entries(data.byProduct)
        .sort((a, b) => b[1] - a[1])
        .map(([product, count]) => {
          const max = Math.max(...Object.values(data.byProduct));
          const pct = (count / max) * 100;
          return `
            <div class="bar-row">
              <div class="bar-label">${product}</div>
              <div class="bar-track">
                <div class="bar-fill" style="width: ${pct}%; background: linear-gradient(90deg, var(--accent), rgba(232,134,60,0.4));"></div>
              </div>
              <div class="bar-count">${count}</div>
            </div>
          `;
        }).join("")}
    </div>
  </div>

  <!-- Subsystem Map + Lint Issues -->
  <div class="grid-2">
    <div class="card">
      <div class="card-title">Subsystem Map</div>
      <div class="filter-tabs" id="productFilter">
        <div class="filter-tab active" data-filter="all">All</div>
        ${Object.keys(data.byProduct)
          .sort((a, b) => (data.byProduct[b] || 0) - (data.byProduct[a] || 0))
          .slice(0, 5)
          .map((p) => `<div class="filter-tab" data-filter="${p}">${p}</div>`)
          .join("")}
      </div>
      <div class="card-scroll">
        <div class="sub-table" id="subsystemTable">
          ${data.subsystems.map((s) => `
            <div class="sub-row" data-product="${s.product}">
              <div class="product-badge">${(productEmoji[s.product] || s.product[0] || "?").toUpperCase()}</div>
              <div class="sub-name">${s.subsystem}</div>
              <span class="badge badge-${s.status}">${s.status}</span>
            </div>
          `).join("")}
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Lint Issues</div>
      ${data.lintIssues.length === 0
        ? '<div class="lint-ok">No conflicts detected</div>'
        : data.lintIssues.map((issue) => `
          <div class="lint-item">
            <div class="lint-type">${issue.type}</div>
            ${issue.message}
          </div>
        `).join("")}

      <div class="card-title" style="margin-top: 1.5rem;">Source Types</div>
      ${Object.entries(data.bySourceType)
        .sort((a, b) => b[1] - a[1])
        .map(([type, count]) => {
          const max = Math.max(...Object.values(data.bySourceType));
          const pct = (count / max) * 100;
          return `
            <div class="bar-row">
              <div class="bar-label">${type}</div>
              <div class="bar-track">
                <div class="bar-fill" style="width: ${pct}%; background: linear-gradient(90deg, rgba(106,159,216,0.6), rgba(106,159,216,0.2));"></div>
              </div>
              <div class="bar-count">${count}</div>
            </div>
          `;
        }).join("")}
    </div>
  </div>

  <!-- Recent Documents -->
  <div class="card">
    <div class="card-title">Recent Documents</div>
    <div class="card-scroll">
      ${data.recentDocs.map((doc) => `
        <div class="recent-item">
          <div class="product-badge">${(productEmoji[doc.product] || doc.product[0] || "?").toUpperCase()}</div>
          <div class="recent-title">${doc.title}</div>
          <span class="badge badge-${doc.status}">${doc.status}</span>
          <div class="recent-meta">${doc.subsystem || ""}</div>
          <div class="recent-meta">${doc.date || ""}</div>
        </div>
      `).join("")}
    </div>
  </div>

  </div><!-- /view-index -->

  <div class="toast" id="toast">Briefing copied to clipboard</div>
</div>

<script>
  // View tab switching
  document.querySelectorAll('.view-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.view-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.view-content').forEach(v => v.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('view-' + tab.dataset.view).classList.add('active');
    });
  });

  // Filter tabs for subsystem map
  document.querySelectorAll('#productFilter .filter-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#productFilter .filter-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const filter = tab.dataset.filter;
      document.querySelectorAll('#subsystemTable .sub-row').forEach(row => {
        row.style.display = (filter === 'all' || row.dataset.product === filter) ? '' : 'none';
      });
    });
  });

  // Briefing data (pre-baked)
  const briefings = ${JSON.stringify(
    data.plans.reduce((acc, { plan, phases }) => {
      for (const phase of phases) {
        if (phase.status === "planned") {
          const completedBefore = phases.filter((p) => p.status === "completed" && p.phaseNum < phase.phaseNum);
          const previousPhase = completedBefore.length > 0 ? completedBefore[completedBefore.length - 1] : null;
          const remaining = phases.filter((p) => p.phaseNum > phase.phaseNum && p.status === "planned");

          let briefing = "# Build Briefing: " + (plan.title || plan.product) + "\\n";
          briefing += "## Phase " + phase.phaseNum + ": " + phase.title + "\\n";
          briefing += "**Product:** " + plan.product + " | **Generated:** " + new Date(data.generated).toISOString().split("T")[0] + "\\n\\n";
          if (plan.description) briefing += "### Product Goal\\n" + plan.description + "\\n\\n";
          if (completedBefore.length > 0) {
            briefing += "### Completed Phases\\n";
            for (const cp of completedBefore) {
              briefing += "- **Phase " + cp.phaseNum + ": " + cp.title + "**\\n";
              if (cp.notes) briefing += "  " + cp.notes + "\\n";
            }
            briefing += "\\n";
          }
          if (previousPhase?.notes) {
            briefing += "### Notes from Previous Phase\\n" + previousPhase.notes + "\\n\\n";
          }
          briefing += "### Phase " + phase.phaseNum + " Goals\\n" + (phase.description || phase.title) + "\\n\\n";
          if (phase.specRefs) briefing += "### Referenced Specs\\n" + phase.specRefs + "\\n\\n";
          if (remaining.length > 0) {
            briefing += "### Upcoming Phases\\n";
            for (const rp of remaining) briefing += "- Phase " + rp.phaseNum + ": " + rp.title + "\\n";
          }
          acc[plan.id + "_" + phase.phaseNum] = briefing;
        }
      }
      return acc;
    }, {} as Record<string, string>)
  )};

  function initPhase(planId, phaseNum) {
    const key = planId + '_' + phaseNum;
    const briefing = briefings[key];
    if (briefing) {
      // Unescape the \\n back to actual newlines
      const text = briefing.replace(/\\\\n/g, '\\n');
      navigator.clipboard.writeText(text).then(() => {
        const toast = document.getElementById('toast');
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 2500);
      });
    }
  }
</script>
</body>
</html>`;
}

function generateDonutSvg(byStatus: Record<string, number>, colors: Record<string, string>): string {
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  if (total === 0) return "";

  const cx = 70, cy = 70, r = 55;
  const circumference = 2 * Math.PI * r;
  let offset = 0;

  const segments = Object.entries(byStatus)
    .sort((a, b) => b[1] - a[1])
    .map(([status, count]) => {
      const pct = count / total;
      const dashLen = pct * circumference;
      const segment = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${colors[status] || "#666"}" stroke-width="18" stroke-dasharray="${dashLen} ${circumference - dashLen}" stroke-dashoffset="${-offset}" opacity="0.85"/>`;
      offset += dashLen;
      return segment;
    });

  return `<svg class="donut-svg" width="140" height="140" viewBox="0 0 140 140">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(255,255,255,0.03)" stroke-width="18"/>
    ${segments.join("\n    ")}
    <text x="${cx}" y="${cy - 4}" text-anchor="middle" fill="var(--text-primary)" font-size="22" font-weight="300" font-family="Inter">${total}</text>
    <text x="${cx}" y="${cy + 12}" text-anchor="middle" fill="var(--text-tertiary)" font-size="9" font-weight="400" font-family="Inter" letter-spacing="0.08em">DOCUMENTS</text>
  </svg>`;
}

export async function generateDashboard(db: SkaldDatabase, outputPath: string): Promise<void> {
  const data = gatherDashboardData(db);
  const html = generateDashboardHtml(data);
  await writeFile(outputPath, html, "utf-8");
}
