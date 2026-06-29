// pipeline.test.ts — findRepos orchestration: dedupe, matched_queries,
// trim-before-enrich, degradation, backfill, low-query hint (spec §11, §9.4).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { findRepos, InvalidInputError } from "../src/findRepos.js";
import type { FetchLike } from "../src/github.js";

function res(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: `S${status}`,
    headers: new Headers(headers),
    json: async () => body,
  } as unknown as Response;
}

function item(full_name: string, extra: Record<string, unknown> = {}) {
  return {
    full_name,
    html_url: `https://github.com/${full_name}`,
    description: "d",
    stargazers_count: 10,
    forks_count: 1,
    open_issues_count: 0,
    pushed_at: "2026-01-01T00:00:00Z",
    language: "TypeScript",
    license: { spdx_id: "MIT" },
    ...extra,
  };
}

function readmeRes(text: string): Response {
  return res({ content: Buffer.from(text, "utf-8").toString("base64"), encoding: "base64" });
}

const isSearch = (u: URL) => u.pathname.includes("/search/repositories");

beforeEach(() => {
  process.env.GITHUB_TOKEN = "t";
});
afterEach(() => {
  delete process.env.GITHUB_TOKEN;
});

describe("findRepos", () => {
  it("dedupes across queries, populates matched_queries, returns enriched candidates", async () => {
    const fetchMock = vi.fn<FetchLike>(async (url) => {
      const u = new URL(url as string);
      if (isSearch(u)) {
        const q = u.searchParams.get("q") ?? "";
        return q.includes("q1") ? res({ items: [item("a/shared"), item("a/one")] }) : res({ items: [item("a/shared")] });
      }
      return readmeRes("# Repo\n\nUseful.");
    });
    const out = await findRepos({ queries: ["q1 foo", "q2 bar"] }, fetchMock);
    const shared = out.candidates.find((c) => c.full_name === "a/shared")!;
    expect(shared.matched_queries.sort()).toEqual(["q1 foo", "q2 bar"]);
    expect(shared.readme_excerpt).toContain("Useful.");
    expect(out.candidates.map((c) => c.full_name).sort()).toEqual(["a/one", "a/shared"]);
  });

  it("fetches READMEs ONLY for the enrich buffer, not the whole pool (trim-before-enrich)", async () => {
    let readmeFetches = 0;
    const fetchMock = vi.fn<FetchLike>(async (url) => {
      const u = new URL(url as string);
      if (isSearch(u)) return res({ items: Array.from({ length: 10 }, (_, i) => item(`a/r${i}`)) });
      readmeFetches++;
      return readmeRes("# R\n\ntext");
    });
    const out = await findRepos({ queries: ["q1"], max_results: 4 }, fetchMock);
    expect(out.candidates).toHaveLength(4);
    // buffer = max_results(4) + ENRICH_BUFFER(3) = 7, well under the pool of 10
    expect(readmeFetches).toBe(7);
  });

  it("adds a low-query hint when fewer than 3 queries are provided", async () => {
    const fetchMock = vi.fn<FetchLike>(async (url) => {
      const u = new URL(url as string);
      return isSearch(u) ? res({ items: [item("a/x")] }) : readmeRes("# x\n\ny");
    });
    const out = await findRepos({ queries: ["only one"] }, fetchMock);
    expect(out.notes?.[0]).toContain("recall improves");
  });

  it("rejects empty queries before any fetch", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => res({ items: [] }));
    await expect(findRepos({ queries: [] }, fetchMock)).rejects.toBeInstanceOf(InvalidInputError);
    await expect(findRepos({ queries: ["   ", ""] }, fetchMock)).rejects.toBeInstanceOf(InvalidInputError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("degrades gracefully when one query is rate-limited, keeping the rest", async () => {
    const fetchMock = vi.fn<FetchLike>(async (url) => {
      const u = new URL(url as string);
      if (isSearch(u)) {
        const q = u.searchParams.get("q") ?? "";
        return q.includes("boom") ? res({ message: "rate limit" }, 403, { "x-ratelimit-remaining": "0" }) : res({ items: [item("a/ok")] });
      }
      return readmeRes("# ok\n\ntext");
    });
    const out = await findRepos({ queries: ["good one", "boom two", "good three"] }, fetchMock);
    expect(out.candidates.map((c) => c.full_name)).toEqual(["a/ok"]);
    expect(out.degraded?.reason).toContain("rate limit");
  });

  it("backfills around a rate-limited README so the returned set stays full", async () => {
    const fetchMock = vi.fn<FetchLike>(async (url) => {
      const u = new URL(url as string);
      if (isSearch(u)) return res({ items: [item("a/r0"), item("a/r1"), item("a/r2")] });
      if (u.pathname.includes("/a/r0/readme")) return res({ message: "rate limit" }, 403, { "x-ratelimit-remaining": "0" });
      return readmeRes("# ok\n\ntext");
    });
    const out = await findRepos({ queries: ["q1"], max_results: 2 }, fetchMock);
    expect(out.candidates.map((c) => c.full_name)).toEqual(["a/r1", "a/r2"]);
    expect(out.candidates.every((c) => c.readme_excerpt === "# ok\n\ntext")).toBe(true);
    expect(out.degraded).toBeUndefined(); // the failure was backfilled out of the result
  });

  it("returns a repo with no README (404) with a null excerpt, not an error", async () => {
    const fetchMock = vi.fn<FetchLike>(async (url) => {
      const u = new URL(url as string);
      return isSearch(u) ? res({ items: [item("a/noreadme")] }) : res({ message: "Not Found" }, 404);
    });
    const out = await findRepos({ queries: ["q1"] }, fetchMock);
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0].readme_excerpt).toBeNull();
    expect(out.degraded).toBeUndefined();
  });

  it("returns empty candidates (not an error) when nothing matches", async () => {
    const fetchMock = vi.fn<FetchLike>(async (url) => {
      const u = new URL(url as string);
      return isSearch(u) ? res({ items: [] }) : readmeRes("x");
    });
    const out = await findRepos({ queries: ["q1", "q2", "q3"] }, fetchMock);
    expect(out.candidates).toEqual([]);
    expect(out.notes).toBeUndefined();
  });

  it("rejects a non-array queries value instead of crashing (finding #3)", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => res({ items: [] }));
    // @ts-expect-error runtime-invalid input shape
    await expect(findRepos({ queries: "react state management" }, fetchMock)).rejects.toBeInstanceOf(InvalidInputError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to the default when max_results is non-numeric — no silent empty (finding #3)", async () => {
    const fetchMock = vi.fn<FetchLike>(async (url) => {
      const u = new URL(url as string);
      return isSearch(u) ? res({ items: [item("a/x")] }) : readmeRes("# x\n\ny");
    });
    // @ts-expect-error runtime-invalid input shape
    const out = await findRepos({ queries: ["q1"], max_results: "abc" }, fetchMock);
    expect(out.candidates).toHaveLength(1);
  });

  it("reports an accurate degraded reason for an auth failure, not 'rate limit' (finding #2)", async () => {
    const fetchMock = vi.fn<FetchLike>(async (url) => {
      const u = new URL(url as string);
      return isSearch(u) ? res({ message: "Bad credentials" }, 401) : readmeRes("x");
    });
    const out = await findRepos({ queries: ["q1", "q2"] }, fetchMock);
    expect(out.candidates).toEqual([]);
    expect(out.degraded?.reason).toContain("authentication");
    expect(out.degraded?.reason).not.toContain("rate limit");
  });

  it("notes filtered-out emptiness when min_stars yields nothing (finding #5)", async () => {
    const fetchMock = vi.fn<FetchLike>(async (url) => {
      const u = new URL(url as string);
      return isSearch(u) ? res({ items: [] }) : readmeRes("x");
    });
    const out = await findRepos({ queries: ["q1", "q2", "q3"], min_stars: 999999 }, fetchMock);
    expect(out.candidates).toEqual([]);
    expect(out.notes?.some((n) => n.includes("min_stars"))).toBe(true);
  });

  it("de-duplicates identical queries to save API calls", async () => {
    let searchCalls = 0;
    const fetchMock = vi.fn<FetchLike>(async (url) => {
      const u = new URL(url as string);
      if (isSearch(u)) {
        searchCalls++;
        return res({ items: [item("a/x")] });
      }
      return readmeRes("# x\n\ny");
    });
    await findRepos({ queries: ["same", "same", "  same  "] }, fetchMock);
    expect(searchCalls).toBe(1);
  });
});
