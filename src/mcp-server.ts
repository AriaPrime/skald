/**
 * Skald MCP Server
 *
 * Exposes search_specs and get_canonical as MCP tools over stdio transport.
 * Claude Code connects to this as an MCP server to query the spec index.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SkaldDatabase } from "./database.js";
import { SkaldSearch } from "./search.js";
import { generateBriefing } from "./briefing.js";
import { EmbeddingService } from "./embeddings.js";
import type { SkaldConfig } from "./types.js";

// zod is a peer dep of @modelcontextprotocol/sdk — re-export to avoid extra install

export async function startMcpServer(config: SkaldConfig): Promise<void> {
  const db = new SkaldDatabase(config.dbPath);
  await db.init();

  const embeddings = new EmbeddingService({ apiKey: config.openaiApiKey });
  const search = new SkaldSearch(db, embeddings);

  const server = new McpServer({
    name: "skald",
    version: "0.1.0",
  });

  // ─── search_specs ──────────────────────────────────────────────

  server.tool(
    "search_specs",
    "Search the spec corpus semantically. Returns ranked chunks with metadata. Use this to find specs by concept rather than filename.",
    {
      query: z.string().describe("Natural language query describing what you're looking for"),
      subsystem: z.string().optional().describe("Filter to a specific subsystem (e.g., reticularis, cortex, canvas)"),
      product: z.string().optional().describe("Filter to a specific product (e.g., vessel, animus, mimir)"),
      status: z.string().optional().describe("Filter by status: current, superseded, draft, completed, review"),
      source_type: z.string().optional().describe("Filter by source type: spec, build-progress, concept, review, reference"),
      limit: z.number().optional().describe("Maximum results to return (default: 10)"),
    },
    async ({ query, subsystem, product, status, source_type, limit }) => {
      const results = await search.search(query, {
        subsystem,
        product,
        status,
        sourceType: source_type,
        limit,
      });

      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No matching specs found." }],
        };
      }

      const formatted = results
        .map((r, i) => {
          const meta = [
            r.product,
            r.subsystem,
            r.status,
            `${(r.similarity * 100).toFixed(0)}% match`,
          ]
            .filter(Boolean)
            .join(" | ");

          return `### ${i + 1}. ${r.title}\n**${meta}**\nPath: ${r.path}\n${r.headingChain ? `Section: ${r.headingChain}\n` : ""}${r.snippet}\n`;
        })
        .join("\n---\n\n");

      return {
        content: [{ type: "text" as const, text: formatted }],
      };
    },
  );

  // ─── get_canonical ─────────────────────────────────────────────

  server.tool(
    "get_canonical",
    "Get the single current spec for a subsystem. Returns full text. Errors if zero or multiple documents claim to be current.",
    {
      subsystem: z.string().describe("Subsystem name (e.g., reticularis, cortex, canvas, soul)"),
      product: z.string().optional().describe("Product name (e.g., vessel, animus)"),
    },
    async ({ subsystem, product }) => {
      const result = search.getCanonical(subsystem, product);

      if (result.error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${result.error}` }],
          isError: true,
        };
      }

      const doc = result.doc!;
      const fullText = await search.readSpec(config.specDirs, doc.path);

      if (!fullText) {
        return {
          content: [{ type: "text" as const, text: `Error: Could not read file at ${doc.path}` }],
          isError: true,
        };
      }

      const header = `# ${doc.title}\n**Product:** ${doc.product} | **Subsystem:** ${doc.subsystem} | **Status:** ${doc.status}\n**Path:** ${doc.path}\n\n---\n\n`;

      return {
        content: [{ type: "text" as const, text: header + fullText }],
      };
    },
  );

  // ─── lint_specs ────────────────────────────────────────────────

  server.tool(
    "lint_specs",
    "Check the spec index for conflicts: multiple current docs for the same subsystem, orphan supersedes references, etc.",
    {},
    async () => {
      const issues = search.lint();

      if (issues.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No issues found. All subsystems have at most one current spec." }],
        };
      }

      const formatted = issues.map((issue) => `[${issue.type}] ${issue.message}`).join("\n\n");
      return {
        content: [{ type: "text" as const, text: `Found ${issues.length} issue(s):\n\n${formatted}` }],
      };
    },
  );

  // ─── plan_status ───────────────────────────────────────────────

  server.tool(
    "plan_status",
    "Update the status of a plan phase. Use after completing work to mark a phase done, or to activate the next phase. Supports auto-advance: completing a phase automatically activates the next planned phase.",
    {
      product: z.string().describe("Product name (e.g., vessel, animus, mimir, skald)"),
      phase_num: z.number().describe("Phase number to update"),
      status: z.enum(["planned", "active", "completed", "skipped"]).describe("New status"),
      notes: z.string().optional().describe("Completion notes — what was built, what was learned, what to watch out for"),
    },
    async ({ product, phase_num, status, notes }) => {
      try {
        const planId = product.toLowerCase();
        const plan = db.getPlan(planId);
        if (!plan) return { content: [{ type: "text" as const, text: `Error: No plan found for '${product}'` }], isError: true };

        db.updatePhaseStatus(planId, phase_num, status, notes);
        await db.flush();

        const lines: string[] = [`Phase ${phase_num} of ${product} → **${status}**`];
        if (notes) lines.push(`Notes saved.`);

        // Auto-advance
        if (status === "completed") {
          const phases = db.getPhases(planId);
          const nextPhase = phases.find((p) => p.phaseNum > phase_num && p.status === "planned");
          if (nextPhase) {
            const hasActive = phases.some((p) => p.status === "active");
            if (!hasActive) {
              db.updatePhaseStatus(planId, nextPhase.phaseNum, "active");
              await db.flush();
              lines.push(`\nAuto-advanced **Phase ${nextPhase.phaseNum}: ${nextPhase.title}** → active`);
            }
          } else {
            const allDone = phases.every((p) => p.status === "completed" || p.status === "skipped");
            if (allDone) lines.push(`\nAll phases complete for ${product}!`);
          }
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    },
  );

  // ─── plan_notes ───────────────────────────────────────────────

  server.tool(
    "plan_notes",
    "Add or update notes on a plan phase. Use to record what was built, decisions made, gotchas discovered, or handoff context for the next phase.",
    {
      product: z.string().describe("Product name"),
      phase_num: z.number().describe("Phase number"),
      notes: z.string().describe("Notes text — what was done, what was learned, what to watch for"),
    },
    async ({ product, phase_num, notes }) => {
      try {
        db.updatePhaseNotes(product.toLowerCase(), phase_num, notes);
        await db.flush();
        return { content: [{ type: "text" as const, text: `Notes updated for Phase ${phase_num} of ${product}.` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    },
  );

  // ─── plan_briefing ─────────────────────────────────────────────

  server.tool(
    "plan_briefing",
    "Generate a build briefing for a plan phase. Returns a markdown document with plan context, phase goals, relevant specs, and previous phase notes. Use this to prepare for a build session.",
    {
      product: z.string().describe("Product name (e.g., vessel, animus, mimir)"),
      phase_num: z.number().describe("Phase number to generate briefing for"),
    },
    async ({ product, phase_num }) => {
      try {
        const briefing = await generateBriefing(db, search, config, product, phase_num);
        return {
          content: [{ type: "text" as const, text: briefing }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  // ─── Start ─────────────────────────────────────────────────────

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
