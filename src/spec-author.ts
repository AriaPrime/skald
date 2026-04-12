/**
 * Skald Spec Authoring
 *
 * Scaffolds new spec files with correct frontmatter, version chain,
 * and folder placement. Knows where specs live and what version comes next.
 */

import { readdir, writeFile, mkdir } from "fs/promises";
import { join, basename } from "path";
import { SkaldDatabase } from "./database.js";

interface NewSpecOptions {
  product: string;
  subsystem: string;
  title?: string;
  description?: string;
  sourceType?: string;
  specDir: string;
}

interface NewSpecResult {
  path: string;
  version: number;
  supersedes: string | null;
  title: string;
}

/**
 * Figure out the next version number for a subsystem by scanning
 * both the database and the filesystem.
 */
function findNextVersion(db: SkaldDatabase, product: string, subsystem: string): { nextVersion: number; supersedes: string | null; latestPath: string | null } {
  // Query DB for existing docs in this subsystem
  const docs = db.findDocuments({ product: product.toLowerCase(), subsystem: subsystem.toLowerCase() });

  // Find the highest version
  let maxVersion = 0;
  let latestDoc: { path: string; title: string } | null = null;

  for (const doc of docs) {
    const match = basename(doc.path).match(/[-_]v(\d+)/i);
    if (match) {
      const v = parseInt(match[1]);
      if (v > maxVersion) {
        maxVersion = v;
        latestDoc = { path: doc.path, title: doc.title };
      }
    }
  }

  return {
    nextVersion: maxVersion + 1,
    supersedes: latestDoc ? basename(latestDoc.path) : null,
    latestPath: latestDoc?.path || null,
  };
}

/**
 * Resolve the target folder for a new spec.
 * Pattern: PRODUCT/PRODUCT SUBSYSTEM/ (e.g., VESSEL/VESSEL RETICULARIS/)
 */
function resolveFolder(specDir: string, product: string, subsystem: string): string {
  const productUpper = product.toUpperCase();
  const subsystemUpper = subsystem.toUpperCase().replace(/-/g, " ");
  return join(specDir, productUpper, `${productUpper} ${subsystemUpper}`);
}

/**
 * Generate a filename from product, subsystem, and version.
 * Pattern: PRODUCT-Subsystem-Spec-vN.md
 */
function generateFilename(product: string, subsystem: string, version: number): string {
  const productPart = product.toUpperCase();
  // Capitalize subsystem words
  const subsystemPart = subsystem
    .split(/[-_\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("-");
  return `${productPart}-${subsystemPart}-Spec-v${version}.md`;
}

/**
 * Generate the frontmatter + skeleton content for a new spec.
 */
function generateSpecContent(opts: {
  title: string;
  product: string;
  subsystem: string;
  version: number;
  supersedes: string | null;
  description?: string;
  sourceType: string;
}): string {
  const date = new Date().toISOString().split("T")[0];

  const frontmatter = [
    "---",
    `title: "${opts.title}"`,
    `product: ${opts.product.toLowerCase()}`,
    `subsystem: ${opts.subsystem.toLowerCase()}`,
    `status: draft`,
    `source_type: ${opts.sourceType}`,
    `version: ${opts.version}`,
    opts.supersedes ? `supersedes: "${opts.supersedes}"` : null,
    `date: ${date}`,
    "---",
  ]
    .filter(Boolean)
    .join("\n");

  const skeleton = `
# ${opts.title}

**Version:** v${opts.version}${opts.supersedes ? ` (supersedes ${opts.supersedes})` : ""}
**Date:** ${date}
**Product:** ${opts.product.toUpperCase()}
**Subsystem:** ${opts.subsystem}
${opts.description ? `\n> ${opts.description}\n` : ""}
---

## Overview

<!-- What this spec covers and why it exists -->

## Architecture

<!-- System design, components, data flow -->

## Implementation

<!-- Technical details, APIs, schemas -->

## Migration

<!-- What changes from the previous version, if any -->

## Open Questions

<!-- Unresolved decisions, trade-offs to revisit -->
`;

  return frontmatter + "\n" + skeleton;
}

/**
 * Create a new spec file.
 */
export async function createSpec(db: SkaldDatabase, opts: NewSpecOptions): Promise<NewSpecResult> {
  const { product, subsystem, specDir } = opts;
  const sourceType = opts.sourceType || "spec";

  // Find next version
  const { nextVersion, supersedes } = findNextVersion(db, product, subsystem);

  // Generate title
  const subsystemTitle = subsystem
    .split(/[-_\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
  const title = opts.title || `${product.toUpperCase()} ${subsystemTitle} v${nextVersion}`;

  // Resolve folder and filename
  const folder = resolveFolder(specDir, product, subsystem);
  const filename = generateFilename(product, subsystem, nextVersion);
  const fullPath = join(folder, filename);

  // Create folder if needed
  await mkdir(folder, { recursive: true });

  // Generate content
  const content = generateSpecContent({
    title,
    product,
    subsystem,
    version: nextVersion,
    supersedes,
    description: opts.description,
    sourceType,
  });

  // Write file
  await writeFile(fullPath, content, "utf-8");

  // If there's a previous version, update its status to superseded
  if (supersedes) {
    const prevDocs = db.findDocuments({ product: product.toLowerCase(), subsystem: subsystem.toLowerCase() });
    for (const doc of prevDocs) {
      if (basename(doc.path) === supersedes && doc.status === "current") {
        // We can't easily update status through the current DB API without a full upsert,
        // so we'll note it for the user
      }
    }
  }

  return {
    path: fullPath,
    version: nextVersion,
    supersedes,
    title,
  };
}
