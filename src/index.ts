/**
 * Skald CLI
 *
 * Commands:
 *   skald build [--dir <path>] [--db <path>]   Index a spec directory
 *   skald search <query> [--subsystem X]        Search the index
 *   skald lint                                  Check for conflicts
 *   skald serve                                 Start MCP server (stdio)
 *
 * Environment:
 *   OPENAI_API_KEY     Required for embedding generation
 *   SKALD_SPEC_DIR     Default spec directory
 *   SKALD_DB_PATH      Default database path
 */

import { EmbeddingService } from "./embeddings.js";
import { SkaldDatabase } from "./database.js";
import { indexDirectory } from "./indexer.js";
import { SkaldSearch } from "./search.js";
import { startMcpServer } from "./mcp-server.js";
import { generateDashboard } from "./dashboard.js";
import { generateBriefing } from "./briefing.js";
import { startDashboardServer } from "./server.js";
import { createSpec } from "./spec-author.js";
import type { SkaldConfig, Plan, Phase } from "./types.js";

// ─── Config ────────────────────────────────────────────────────────

const DEFAULT_SPEC_DIR = "C:\\Users\\ARIA_PRIME\\OneDrive\\Documents\\RONST\\NEWER DOCS\\PRIVATEERS\\A - Privateers AI\\AI PROTOTYPE";
const DEFAULT_DB_PATH = "C:\\Users\\ARIA_PRIME\\vessel\\data\\skald.db";

function getConfig(args: string[]): SkaldConfig {
  const dirIdx = args.indexOf("--dir");
  const dbIdx = args.indexOf("--db");

  return {
    specDirs: [dirIdx >= 0 ? args[dirIdx + 1] : (process.env.SKALD_SPEC_DIR || DEFAULT_SPEC_DIR)],
    dbPath: dbIdx >= 0 ? args[dbIdx + 1] : (process.env.SKALD_DB_PATH || DEFAULT_DB_PATH),
    openaiApiKey: process.env.OPENAI_API_KEY || "",
  };
}

function parseArgs(args: string[]): { command: string; positional: string[]; flags: Record<string, string | boolean> } {
  const command = args[0] || "help";
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(args[i]);
    }
  }

  return { command, positional, flags };
}

// ─── Commands ──────────────────────────────────────────────────────

async function cmdBuild(config: SkaldConfig, verbose: boolean): Promise<void> {
  if (!config.openaiApiKey) {
    console.error("Error: OPENAI_API_KEY environment variable is required for embedding generation.");
    process.exit(1);
  }

  const db = new SkaldDatabase(config.dbPath);
  await db.init();

  const embeddings = new EmbeddingService({ apiKey: config.openaiApiKey });

  console.log(`Indexing specs from: ${config.specDirs.join(", ")}`);
  console.log(`Database: ${config.dbPath}\n`);

  for (const specDir of config.specDirs) {
    const result = await indexDirectory(specDir, db, embeddings, { verbose });
    console.log(`\nResults for ${specDir}:`);
    console.log(`  Files scanned:  ${result.filesScanned}`);
    console.log(`  Files indexed:  ${result.filesIndexed}`);
    console.log(`  Files skipped:  ${result.filesSkipped} (unchanged or too small)`);
    console.log(`  Chunks created: ${result.chunksCreated}`);
    console.log(`  Embeddings:     ${result.embeddingsGenerated}`);
    if (result.errors.length > 0) {
      console.log(`  Errors:         ${result.errors.length}`);
      for (const err of result.errors) {
        console.log(`    - ${err.path}: ${err.error}`);
      }
    }
  }

  const stats = db.stats();
  console.log(`\nDatabase totals: ${stats.documents} documents, ${stats.chunks} chunks (${stats.withEmbeddings} with embeddings)`);

  await db.flush();
  db.close();
}

async function cmdSearch(config: SkaldConfig, query: string, flags: Record<string, string | boolean>): Promise<void> {
  if (!config.openaiApiKey) {
    console.error("Error: OPENAI_API_KEY environment variable is required for search.");
    process.exit(1);
  }

  const db = new SkaldDatabase(config.dbPath);
  await db.init();

  const embeddings = new EmbeddingService({ apiKey: config.openaiApiKey });
  const search = new SkaldSearch(db, embeddings);

  const results = await search.search(query, {
    subsystem: flags.subsystem as string | undefined,
    product: flags.product as string | undefined,
    status: flags.status as string | undefined,
    sourceType: flags["source-type"] as string | undefined,
    limit: flags.limit ? parseInt(flags.limit as string) : undefined,
  });

  if (results.length === 0) {
    console.log("No matching specs found.");
  } else {
    for (const [i, r] of results.entries()) {
      const meta = [r.product, r.subsystem, r.status, `${(r.similarity * 100).toFixed(0)}%`]
        .filter(Boolean)
        .join(" | ");
      console.log(`\n${i + 1}. ${r.title} [${meta}]`);
      console.log(`   Path: ${r.path}`);
      if (r.headingChain) console.log(`   Section: ${r.headingChain}`);
      console.log(`   ${r.snippet.slice(0, 200).replace(/\n/g, " ")}...`);
    }
  }

  db.close();
}

async function cmdLint(config: SkaldConfig): Promise<void> {
  const db = new SkaldDatabase(config.dbPath);
  await db.init();

  const embeddings = new EmbeddingService({ apiKey: config.openaiApiKey || "unused" });
  const search = new SkaldSearch(db, embeddings);

  const issues = search.lint();

  if (issues.length === 0) {
    console.log("No issues found.");
  } else {
    console.log(`Found ${issues.length} issue(s):\n`);
    for (const issue of issues) {
      console.log(`[${issue.type}] ${issue.message}\n`);
    }
  }

  db.close();
}

async function cmdServe(config: SkaldConfig): Promise<void> {
  if (!config.openaiApiKey) {
    console.error("Error: OPENAI_API_KEY environment variable is required for MCP server.");
    process.exit(1);
  }

  await startMcpServer(config);
}

// ─── Plan Commands ────────────────────────────────────────────────

async function cmdPlan(config: SkaldConfig, positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const subcommand = positional[0] || "list";
  const db = new SkaldDatabase(config.dbPath);
  await db.init();

  switch (subcommand) {
    case "list": {
      const grouped = db.getAllPhasesGrouped();
      if (grouped.size === 0) {
        console.log("No plans yet. Create one with: skald plan add <product> \"<title>\"");
        break;
      }
      for (const [, { plan, phases }] of grouped) {
        console.log(`\n${plan.title || plan.product.toUpperCase()}`);
        if (plan.description) console.log(`  ${plan.description}`);
        console.log("");
        for (const phase of phases) {
          const icon =
            phase.status === "completed" ? "[done]" :
            phase.status === "active" ? "[>>>]" :
            phase.status === "skipped" ? "[skip]" :
            "[    ]";
          console.log(`  ${icon}  Phase ${phase.phaseNum}: ${phase.title}`);
          if (phase.description && flags.verbose) console.log(`         ${phase.description}`);
        }
      }
      break;
    }

    case "add": {
      const product = positional[1];
      const title = positional[2];
      if (!product || !title) {
        console.error("Usage: skald plan add <product> \"<title>\" [--desc \"...\"]");
        process.exit(1);
      }
      const planId = product.toLowerCase();
      const plan: Plan = {
        id: planId,
        product: product.toLowerCase(),
        title,
        description: (flags.desc as string) || null,
        updatedAt: Date.now(),
      };
      db.upsertPlan(plan);
      await db.flush();
      console.log(`Plan created: ${title} (${planId})`);
      break;
    }

    case "phase": {
      const product = positional[1];
      const num = parseInt(positional[2]);
      const title = positional[3];
      if (!product || isNaN(num) || !title) {
        console.error("Usage: skald plan phase <product> <num> \"<title>\" [--desc \"...\"] [--refs \"spec1,spec2\"]");
        process.exit(1);
      }
      const planId = product.toLowerCase();
      const plan = db.getPlan(planId);
      if (!plan) {
        console.error(`No plan found for product '${product}'. Create one first with: skald plan add ${product} "..."`);
        process.exit(1);
      }
      const phase: Phase = {
        id: `${planId}_${num}`,
        planId,
        phaseNum: num,
        title,
        description: (flags.desc as string) || null,
        status: (flags.status as string) || "planned",
        specRefs: (flags.refs as string) || null,
        notes: (flags.notes as string) || null,
        startedAt: null,
        completedAt: null,
        updatedAt: Date.now(),
      };
      db.upsertPhase(phase);
      await db.flush();
      console.log(`Phase ${num} added to ${product}: ${title}`);
      break;
    }

    case "status": {
      const product = positional[1];
      const num = parseInt(positional[2]);
      const status = positional[3];
      if (!product || isNaN(num) || !status) {
        console.error("Usage: skald plan status <product> <num> <planned|active|completed|skipped> [--notes \"...\"]");
        process.exit(1);
      }
      const valid = ["planned", "active", "completed", "skipped"];
      if (!valid.includes(status)) {
        console.error(`Invalid status '${status}'. Must be one of: ${valid.join(", ")}`);
        process.exit(1);
      }
      const planId = product.toLowerCase();
      const notes = flags.notes as string | undefined;

      db.updatePhaseStatus(planId, num, status, notes);
      await db.flush();

      console.log(`Phase ${num} of ${product} → ${status}${notes ? " (notes saved)" : ""}`);

      // Auto-advance: if completing a phase, check if next phase should activate
      if (status === "completed") {
        const phases = db.getPhases(planId);
        const nextPhase = phases.find((p) => p.phaseNum > num && p.status === "planned");
        if (nextPhase) {
          const hasActivePhase = phases.some((p) => p.status === "active");
          if (!hasActivePhase) {
            db.updatePhaseStatus(planId, nextPhase.phaseNum, "active");
            await db.flush();
            console.log(`  → Auto-advanced Phase ${nextPhase.phaseNum}: ${nextPhase.title} → active`);
          }
        } else {
          const allDone = phases.every((p) => p.status === "completed" || p.status === "skipped");
          if (allDone) {
            console.log(`  All phases complete for ${product}!`);
          }
        }
      }
      break;
    }

    case "notes": {
      const product = positional[1];
      const num = parseInt(positional[2]);
      const notesText = positional.slice(3).join(" ") || (flags.notes as string);
      if (!product || isNaN(num) || !notesText) {
        console.error("Usage: skald plan notes <product> <num> \"<notes text>\"");
        process.exit(1);
      }
      db.updatePhaseNotes(product.toLowerCase(), num, notesText);
      await db.flush();
      console.log(`Notes updated for Phase ${num} of ${product}`);
      break;
    }

    case "briefing": {
      const product = positional[1];
      const num = parseInt(positional[2]);
      if (!product || isNaN(num)) {
        console.error("Usage: skald plan briefing <product> <num>");
        process.exit(1);
      }
      const embeddings = new EmbeddingService({ apiKey: config.openaiApiKey || "unused" });
      const search = new SkaldSearch(db, embeddings);
      const briefing = await generateBriefing(db, search, config, product, num);
      console.log(briefing);

      // Copy to clipboard on Windows
      try {
        const { execSync } = await import("child_process");
        execSync("clip", { input: briefing });
        console.error("\n--- Briefing copied to clipboard ---");
      } catch {
        // Non-fatal if clip fails
      }
      break;
    }

    default:
      console.error(`Unknown plan subcommand: ${subcommand}`);
      console.error("Available: list, add, phase, status, briefing");
      process.exit(1);
  }

  db.close();
}

const DEFAULT_DASHBOARD_PATH = "C:\\Users\\ARIA_PRIME\\vessel\\data\\skald-dashboard.html";

async function cmdDashboard(config: SkaldConfig, flags: Record<string, string | boolean>): Promise<void> {
  const db = new SkaldDatabase(config.dbPath);
  await db.init();

  const outputPath = (flags.out as string) || DEFAULT_DASHBOARD_PATH;
  await generateDashboard(db, outputPath);
  console.log(`Dashboard generated: ${outputPath}`);

  // Open in browser
  const { exec } = await import("child_process");
  exec(`start "" "${outputPath}"`);

  db.close();
}

function printHelp(): void {
  console.log(`
Skald — Spec Index for VESSEL / ANIMUS / Privateers AI

Usage:
  skald build [--dir <path>] [--db <path>] [--verbose]
    Index a spec directory into SQLite + embeddings.

  skald search <query> [--subsystem <name>] [--product <name>] [--status <status>] [--limit <n>]
    Search the spec index semantically.

  skald lint [--db <path>]
    Check for conflicts (dual-current, orphan references).

  skald plan list
    Show all plans with their phases.
  skald plan add <product> "<title>" [--desc "..."]
    Create a new plan for a product.
  skald plan phase <product> <num> "<title>" [--desc "..."] [--refs "spec1,spec2"]
    Add a phase to a plan.
  skald plan status <product> <num> <planned|active|completed|skipped>
    Update phase status.
  skald plan briefing <product> <num>
    Generate a build briefing and copy to clipboard.

  skald spec new <product> <subsystem> [--title "..."] [--desc "..."]
    Scaffold a new spec file with frontmatter, version chain, and folder placement.

  skald dashboard [--out <path>]
    Generate a static HTML dashboard and open it in the browser.

  skald live [--port 18803]
    Start live dashboard server. Refreshes from DB on every page load.

  skald serve [--dir <path>] [--db <path>]
    Start MCP server on stdio (for Claude Code integration).

Environment:
  OPENAI_API_KEY     Required for embedding generation and search
  SKALD_SPEC_DIR     Default spec directory
  SKALD_DB_PATH      Default database path
`);
}

// ─── Main ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const { command, positional, flags } = parseArgs(args);
const config = getConfig(args);

switch (command) {
  case "build":
    cmdBuild(config, !!flags.verbose).catch(console.error);
    break;
  case "search":
    if (positional.length === 0) {
      console.error("Usage: skald search <query>");
      process.exit(1);
    }
    cmdSearch(config, positional.join(" "), flags).catch(console.error);
    break;
  case "lint":
    cmdLint(config).catch(console.error);
    break;
  case "plan":
    cmdPlan(config, positional, flags).catch(console.error);
    break;
  case "spec": {
    const specSub = positional[0] || "help";
    if (specSub === "new") {
      const product = positional[1];
      const subsystem = positional[2];
      if (!product || !subsystem) {
        console.error("Usage: skald spec new <product> <subsystem> [--title \"...\"] [--desc \"...\"]");
        process.exit(1);
      }
      const db = new SkaldDatabase(config.dbPath);
      await db.init();
      const result = await createSpec(db, {
        product,
        subsystem,
        title: flags.title as string | undefined,
        description: flags.desc as string | undefined,
        specDir: config.specDirs[0],
      });
      db.close();
      console.log(`Created: ${result.path}`);
      console.log(`  Title: ${result.title}`);
      console.log(`  Version: v${result.version}`);
      if (result.supersedes) console.log(`  Supersedes: ${result.supersedes}`);
      console.log(`\nEdit the file, then run 'skald build' to index it.`);
    } else {
      console.error("Usage: skald spec new <product> <subsystem>");
    }
    break;
  }
  case "dashboard":
    cmdDashboard(config, flags).catch(console.error);
    break;
  case "serve":
    cmdServe(config).catch(console.error);
    break;
  case "live": {
    const port = flags.port ? parseInt(flags.port as string) : 18803;
    startDashboardServer(config.dbPath, port).catch(console.error);
    break;
  }
  default:
    printHelp();
}
