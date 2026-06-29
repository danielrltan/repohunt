// rank.test.ts — pre-rank ordering is deterministic and correct (spec §11, D8).
import { describe, it, expect } from "vitest";
import { prerank, type Ranked } from "../src/rank.js";

function r(p: Partial<Ranked> & { full_name: string }): Ranked {
  return {
    full_name: p.full_name,
    url: "u",
    description: null,
    stars: p.stars ?? 0,
    forks: 0,
    open_issues: 0,
    last_pushed: p.last_pushed ?? null,
    license: null,
    primary_language: null,
    matched_queries: p.matched_queries ?? ["q"],
    best_match_rank: p.best_match_rank ?? 0,
  };
}

describe("prerank (D8)", () => {
  it("ranks more matched queries first", () => {
    const out = prerank([
      r({ full_name: "a/one", matched_queries: ["q1"] }),
      r({ full_name: "a/three", matched_queries: ["q1", "q2", "q3"] }),
      r({ full_name: "a/two", matched_queries: ["q1", "q2"] }),
    ]);
    expect(out.map((x) => x.full_name)).toEqual(["a/three", "a/two", "a/one"]);
  });

  it("a niche exact-match (3 queries, few stars) outranks a popular generic (1 query, many stars)", () => {
    const out = prerank([
      r({ full_name: "big/generic", matched_queries: ["q1"], stars: 90000, best_match_rank: 0 }),
      r({ full_name: "small/niche", matched_queries: ["q1", "q2", "q3"], stars: 40, best_match_rank: 2 }),
    ]);
    expect(out[0].full_name).toBe("small/niche");
  });

  it("breaks ties by best-match rank, then recency, then stars (weak)", () => {
    const out = prerank([
      r({ full_name: "a/old", best_match_rank: 1, last_pushed: "2020-01-01T00:00:00Z", stars: 5 }),
      r({ full_name: "a/new", best_match_rank: 1, last_pushed: "2026-01-01T00:00:00Z", stars: 1 }),
      r({ full_name: "a/top", best_match_rank: 0, last_pushed: "2010-01-01T00:00:00Z", stars: 1 }),
    ]);
    expect(out.map((x) => x.full_name)).toEqual(["a/top", "a/new", "a/old"]);
  });

  it("does not mutate the input and handles empty", () => {
    const input = [r({ full_name: "a/x" })];
    const copy = [...input];
    prerank(input);
    expect(input).toEqual(copy);
    expect(prerank([])).toEqual([]);
  });
});
