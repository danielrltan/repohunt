// live.smoke.test.ts — D5 live smoke test against the REAL GitHub API.
//
// Gated behind RUN_LIVE=1 + a real GITHUB_TOKEN so it NEVER runs in CI by
// default (CI stays deterministic on mocked fetch). Run it manually to verify
// the real-world contract — the §9.1 "works in the wild" acceptance criterion:
//
//   RUN_LIVE=1 GITHUB_TOKEN=ghp_... npm test
import { describe, it, expect } from "vitest";
import { findRepos } from "../src/findRepos.js";

const live = process.env.RUN_LIVE === "1" && !!process.env.GITHUB_TOKEN;

describe.skipIf(!live)("live smoke (real GitHub API)", () => {
  it(
    "returns real enriched candidates for a real intent",
    async () => {
      const out = await findRepos({
        queries: [
          "express rate limit middleware",
          "express-rate-limit",
          "api throttling node",
          "request throttling express",
        ],
        language: "typescript",
        max_results: 5,
      });

      expect(out.candidates.length).toBeGreaterThan(0);
      const top = out.candidates[0];
      expect(top.full_name).toMatch(/.+\/.+/);
      expect(typeof top.stars).toBe("number");
      expect(Array.isArray(top.matched_queries)).toBe(true);
      // At least one candidate should carry a substantive README excerpt.
      expect(out.candidates.some((c) => (c.readme_excerpt?.length ?? 0) > 50)).toBe(true);
    },
    30_000,
  );
});
