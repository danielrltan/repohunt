#!/usr/bin/env node
// index.ts — MCP server entry + find_repos tool registration (Milestone M3).
//
// Registers the single tool with the D1 strong description + few-shot example
// (the tool description is the product — it's the only lever the server has over
// quality), the D4 outputSchema so capable hosts get a typed contract while
// every host still gets a JSON text block, and a fail-fast on a missing token.

import { readFileSync, realpathSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { findRepos } from "./findRepos.js";
import { getGithubToken, MissingTokenError, type FetchLike } from "./github.js";

// Single-source the version from package.json so it can't drift from the MCP
// initialize handshake when /ship bumps it (review finding #3).
function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
const VERSION = readVersion();

const TOOL_DESCRIPTION = `Search GitHub for repositories matching a development intent and return structured EVIDENCE (not a verdict) for you to rank.

IMPORTANT — before calling this tool you MUST expand the user's single intent into 4-8 VARIED keyword queries: synonyms, likely library/package names, and problem restatements. Do not pass one raw phrase; keyword recall depends on the variety you supply. The server fires every query against GitHub's live search (README body included), dedupes, pre-ranks, and returns the strongest candidates each with a trimmed README excerpt + metadata. You then rank them and decide fork / study / avoid.

Example — intent "rate limiting middleware for express":
  queries: [
    "express rate limit middleware",
    "express-rate-limit",
    "api throttling node",
    "request throttling express",
    "leaky bucket rate limiter node",
    "ddos protection express middleware"
  ]`;

const inputSchema = {
  queries: z
    .array(z.string())
    .min(1)
    // No upper bound here: findRepos dedupes + clamps to 8, so an over-eager
    // model that sends 9-10 queries gets graceful truncation, not a hard 422
    // at the SDK boundary (review finding #2). The description still guides 4-8.
    .describe(
      "Keyword search strings (aim for 4-8). Expand ONE user intent into several varied " +
        "variations (synonyms, library names, problem restatements). More variety = better recall.",
    ),
  language: z.string().optional().describe("Restrict to a GitHub-recognized language, e.g. 'typescript'."),
  min_stars: z.number().int().min(0).optional().describe("Filter out repos below this star count. Default 0."),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(15)
    .optional()
    .describe("How many enriched candidates to return. Default 8, hard cap 15."),
};

const candidateSchema = z.object({
  full_name: z.string(),
  url: z.string(),
  description: z.string().nullable(),
  readme_excerpt: z.string().nullable(),
  stars: z.number(),
  forks: z.number(),
  open_issues: z.number(),
  last_pushed: z.string().nullable(),
  license: z.string().nullable(),
  primary_language: z.string().nullable(),
  matched_queries: z.array(z.string()),
});

const outputSchema = {
  candidates: z.array(candidateSchema),
  notes: z.array(z.string()).optional(),
  degraded: z.object({ reason: z.string() }).optional(),
};

/** Build the server with find_repos registered. Exported (and fetch-injectable)
 *  so tests can drive it over an in-memory transport without a real network. */
export function createServer(fetchImpl: FetchLike = fetch): McpServer {
  const server = new McpServer({ name: "repohunt", version: VERSION });

  server.registerTool(
    "find_repos",
    {
      title: "Find GitHub repositories by intent",
      description: TOOL_DESCRIPTION,
      inputSchema,
      outputSchema,
    },
    async (args) => {
      try {
        const result = await findRepos(args, fetchImpl);
        return {
          // Text block for universal host compatibility + structuredContent for
          // capable hosts (D4); the SDK validates structuredContent vs outputSchema.
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          // Double cast required (interface has no index signature); the SDK
          // runtime-validates structuredContent against outputSchema regardless.
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `find_repos failed: ${message}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}

async function main(): Promise<void> {
  // Fail fast on a missing token with a clear, actionable message (spec §7).
  try {
    getGithubToken();
  } catch (err) {
    if (err instanceof MissingTokenError) {
      // Synchronous write: process.exit() can truncate an async stderr pipe,
      // and this message is the entire point of failing fast (review finding #1).
      writeSync(2, `\n[repohunt] ${err.message}\n\n`);
      process.exit(1);
    }
    throw err;
  }

  const server = createServer();
  await server.connect(new StdioServerTransport());
  // stdio is the protocol channel — only ever log to stderr, never stdout.
  process.stderr.write("[repohunt] MCP server ready on stdio.\n");
}

function isDirectRun(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return realpathSync(arg) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((err) => {
    writeSync(2, `[repohunt] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
