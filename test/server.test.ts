// server.test.ts — M3 MCP wiring. Drives the real server through an in-memory
// transport + a real MCP Client: tool registration, structuredContent + text
// mirror (D4), the D1 contract in the description, and schema-boundary rejection.
import { readFileSync } from "node:fs";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/index.js";
import type { FetchLike } from "../src/github.js";

function res(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: `S${status}`,
    headers: new Headers(),
    json: async () => body,
  } as unknown as Response;
}

const fakeFetch: FetchLike = async (url) => {
  const u = new URL(url as string);
  if (u.pathname.includes("/search/repositories")) {
    return res({
      items: [
        {
          full_name: "a/x",
          html_url: "https://github.com/a/x",
          description: "does a thing",
          stargazers_count: 42,
          forks_count: 3,
          open_issues_count: 1,
          pushed_at: "2026-01-01T00:00:00Z",
          language: "TypeScript",
          license: { spdx_id: "MIT" },
        },
      ],
    });
  }
  return res({ content: Buffer.from("# X\n\nUseful thing.", "utf-8").toString("base64"), encoding: "base64" });
};

async function connect(fetchImpl: FetchLike): Promise<Client> {
  const server = createServer(fetchImpl);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

beforeEach(() => {
  process.env.GITHUB_TOKEN = "t";
});
afterEach(() => {
  delete process.env.GITHUB_TOKEN;
});

describe("find_repos MCP tool", () => {
  it("is registered and its description encodes the multi-query contract (D1)", async () => {
    const client = await connect(fakeFetch);
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "find_repos");
    expect(tool).toBeDefined();
    expect(tool!.description).toMatch(/4-8/);
    expect(tool!.description!.toLowerCase()).toContain("expand");
  });

  it("returns structuredContent AND a JSON text mirror (D4)", async () => {
    const client = await connect(fakeFetch);
    const out = (await client.callTool({ name: "find_repos", arguments: { queries: ["q1"] } })) as {
      structuredContent: { candidates: Array<{ full_name: string; readme_excerpt: string }> };
      content: Array<{ type: string; text: string }>;
    };
    expect(out.structuredContent.candidates[0].full_name).toBe("a/x");
    expect(out.structuredContent.candidates[0].readme_excerpt).toContain("Useful thing.");
    expect(out.content[0].type).toBe("text");
    expect(JSON.parse(out.content[0].text).candidates[0].full_name).toBe("a/x");
  });

  it("rejects invalid input (empty queries) at the schema boundary", async () => {
    const client = await connect(fakeFetch);
    let errored = false;
    try {
      const r = (await client.callTool({ name: "find_repos", arguments: { queries: [] } })) as { isError?: boolean };
      errored = r?.isError === true;
    } catch {
      errored = true;
    }
    expect(errored).toBe(true);
  });

  it("accepts more than 8 queries gracefully — findRepos clamps, no schema 422 (finding #2)", async () => {
    const client = await connect(fakeFetch);
    const args = { queries: Array.from({ length: 10 }, (_, i) => `q${i}`) };
    const out = (await client.callTool({ name: "find_repos", arguments: args })) as {
      isError?: boolean;
      structuredContent?: { candidates: unknown[] };
    };
    expect(out.isError ?? false).toBe(false);
    expect(out.structuredContent!.candidates.length).toBeGreaterThanOrEqual(1);
  });

  it("advertises the package.json version with no drift (finding #3)", async () => {
    const client = await connect(fakeFetch);
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(client.getServerVersion()?.version).toBe(pkg.version);
  });
});
