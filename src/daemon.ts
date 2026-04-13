/**
 * Skald Daemon
 *
 * Always-on service combining:
 * - Live dashboard server (port 18803)
 * - Spec file watcher (auto-reindex on changes)
 * - MCP server (stdio, for Claude Code)
 *
 * Run as: skald daemon [--port 18803]
 * Or as a Windows scheduled task for boot-time startup.
 */

import { SkaldDatabase } from "./database.js";
import { EmbeddingService } from "./embeddings.js";
import { startDashboardServer } from "./server.js";
import { SpecWatcher } from "./watcher.js";
import type { SkaldConfig } from "./types.js";

export async function startDaemon(config: SkaldConfig, port: number): Promise<void> {
  console.log("╔══════════════════════════════════════╗");
  console.log("║          SKALD DAEMON                ║");
  console.log("╚══════════════════════════════════════╝");
  console.log("");

  // 1. Start live dashboard server
  await startDashboardServer(config.dbPath, port);

  // 2. Start file watcher (if we have spec dirs and an API key)
  if (config.specDirs.length > 0 && config.openaiApiKey) {
    const watchDb = new SkaldDatabase(config.dbPath);
    await watchDb.init();
    const embeddings = new EmbeddingService({ apiKey: config.openaiApiKey });

    const watcher = new SpecWatcher({
      specDirs: config.specDirs,
      db: watchDb,
      embeddings,
      onReindex: (path, action) => {
        console.log(`[watch] [${action}] ${path}`);
      },
      onConflict: async (message) => {
        console.warn(`[watch] [CONFLICT] ${message}`);
        try {
          await fetch("http://localhost:18801/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: `Skald drift alert: ${message}`,
              channelId: "skald-alerts",
            }),
          });
        } catch {}
      },
    });
    watcher.start();
  } else {
    if (config.specDirs.length === 0) console.log("[watch] No spec dirs configured — watcher disabled");
    if (!config.openaiApiKey) console.log("[watch] No OPENAI_API_KEY — watcher disabled (can't re-embed)");
  }

  console.log("");
  console.log(`Dashboard: http://localhost:${port}`);
  console.log("Daemon running. Press Ctrl+C to stop.");
}
