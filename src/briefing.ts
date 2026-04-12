/**
 * Skald Briefing Generator
 *
 * Generates a markdown briefing for a plan phase that can be pasted
 * into a new Claude Code session to kick off a build.
 */

import { SkaldDatabase } from "./database.js";
import { SkaldSearch } from "./search.js";
import type { SkaldConfig, Phase } from "./types.js";

export async function generateBriefing(
  db: SkaldDatabase,
  search: SkaldSearch,
  config: SkaldConfig,
  product: string,
  phaseNum: number,
): Promise<string> {
  const planId = product.toLowerCase();
  const plan = db.getPlan(planId);
  if (!plan) throw new Error(`No plan found for product '${product}'`);

  const phases = db.getPhases(planId);
  const phase = phases.find((p) => p.phaseNum === phaseNum);
  if (!phase) throw new Error(`No phase ${phaseNum} found in plan '${product}'`);

  const completedPhases = phases.filter((p) => p.status === "completed" && p.phaseNum < phaseNum);
  const previousPhase = completedPhases.length > 0 ? completedPhases[completedPhases.length - 1] : null;

  const sections: string[] = [];

  // ─── Header ──────────────────────────────────────────────────────

  sections.push(`# Build Briefing: ${plan.title}`);
  sections.push(`## Phase ${phase.phaseNum}: ${phase.title}`);
  sections.push(`**Product:** ${plan.product} | **Status:** ${phase.status} | **Generated:** ${new Date().toISOString().split("T")[0]}`);
  sections.push("");

  // ─── Plan Context ────────────────────────────────────────────────

  if (plan.description) {
    sections.push(`### Product Goal`);
    sections.push(plan.description);
    sections.push("");
  }

  // ─── Completed Phases ────────────────────────────────────────────

  if (completedPhases.length > 0) {
    sections.push(`### Completed Phases`);
    for (const cp of completedPhases) {
      const completedDate = cp.completedAt ? new Date(cp.completedAt).toISOString().split("T")[0] : "?";
      sections.push(`- **Phase ${cp.phaseNum}: ${cp.title}** (completed ${completedDate})`);
      if (cp.notes) {
        sections.push(`  ${cp.notes}`);
      }
    }
    sections.push("");
  }

  // ─── Previous Phase Notes ────────────────────────────────────────

  if (previousPhase?.notes) {
    sections.push(`### Notes from Previous Phase`);
    sections.push(`> Phase ${previousPhase.phaseNum}: ${previousPhase.title}`);
    sections.push("");
    sections.push(previousPhase.notes);
    sections.push("");
  }

  // ─── Phase Goals ─────────────────────────────────────────────────

  sections.push(`### Phase ${phase.phaseNum} Goals`);
  sections.push(phase.description || phase.title);
  sections.push("");

  // ─── Relevant Specs ──────────────────────────────────────────────

  if (phase.specRefs) {
    sections.push(`### Referenced Specs`);
    const refs = phase.specRefs.split(",").map((r) => r.trim());
    for (const ref of refs) {
      const content = await search.readSpec(config.specDirs, ref);
      if (content) {
        sections.push(`#### ${ref}`);
        // Include first ~3000 chars of spec to keep briefing manageable
        sections.push(content.slice(0, 3000));
        if (content.length > 3000) sections.push("\n*[truncated — full spec available via `search_specs`]*");
        sections.push("");
      }
    }
  } else {
    // No explicit refs — search for relevant specs
    try {
      const searchQuery = `${plan.product} ${phase.title} ${phase.description || ""}`;
      const results = await search.search(searchQuery, {
        product: plan.product,
        status: "current",
        limit: 3,
      });
      if (results.length > 0) {
        sections.push(`### Relevant Specs (auto-discovered)`);
        for (const r of results) {
          sections.push(`- **${r.title}** (${r.path}) — ${(r.similarity * 100).toFixed(0)}% match`);
          if (r.headingChain) sections.push(`  Section: ${r.headingChain}`);
        }
        sections.push("");
      }
    } catch {
      // Search requires API key — skip if not available
    }
  }

  // ─── Remaining Phases ────────────────────────────────────────────

  const remaining = phases.filter((p) => p.phaseNum > phaseNum && p.status === "planned");
  if (remaining.length > 0) {
    sections.push(`### Upcoming Phases`);
    for (const rp of remaining) {
      sections.push(`- Phase ${rp.phaseNum}: ${rp.title}`);
    }
    sections.push("");
  }

  return sections.join("\n");
}
