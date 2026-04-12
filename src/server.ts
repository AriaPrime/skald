/**
 * Skald Live Dashboard Server
 *
 * Serves the dashboard HTML on an HTTP port. Each page load regenerates
 * from the live database — no static file needed.
 *
 * Default port: 18803
 */

import { createServer } from "http";
import { SkaldDatabase } from "./database.js";
import { gatherDashboardData, generateDashboardHtml } from "./dashboard.js";

export async function startDashboardServer(dbPath: string, port: number): Promise<void> {
  const db = new SkaldDatabase(dbPath);
  await db.init();

  const server = createServer(async (_req, res) => {
    const url = _req.url ?? "/";

    if (url === "/" || url === "/index.html") {
      try {
        const data = gatherDashboardData(db);
        const html = generateDashboardHtml(data);
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        res.end(html);
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(`Error generating dashboard: ${err.message}`);
      }
    } else if (url === "/api/plans") {
      // JSON endpoint for plans data
      try {
        const data = gatherDashboardData(db);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
        });
        res.end(JSON.stringify(data.plans));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else if (url === "/api/stats") {
      try {
        const data = gatherDashboardData(db);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
        });
        res.end(JSON.stringify({
          stats: data.stats,
          byProduct: data.byProduct,
          byStatus: data.byStatus,
          lintIssues: data.lintIssues.length,
          plans: data.plans.length,
          generated: data.generated,
        }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
  });

  server.listen(port, () => {
    console.log(`Skald dashboard live at http://localhost:${port}`);
  });
}
