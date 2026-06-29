// types.ts — shared types for the find_repos input/output schema (spec §5).
// Derived directly from the spec; revisit after /office-hours + /plan-eng-review.

/** Input to the find_repos tool. */
export interface FindReposInput {
  /** 1–8 keyword search strings. The caller expands one intent into variations. */
  queries: string[];
  /** Restrict to a GitHub-recognized language, e.g. "typescript". */
  language?: string;
  /** Filter out repos below this star count. Default 0. */
  min_stars?: number;
  /** How many fully-enriched candidates to return. Default 8, hard cap 15. */
  max_results?: number;
}

/** A single enriched candidate repo in the output (spec §5). */
export interface RepoCandidate {
  full_name: string;
  url: string;
  description: string | null;
  readme_excerpt: string | null;
  stars: number;
  forks: number;
  open_issues: number;
  /** ISO date of the last push, or null if unknown. */
  last_pushed: string | null;
  /** SPDX id, or null if unlicensed/unknown. */
  license: string | null;
  primary_language: string | null;
  /** Which of the input queries surfaced this repo (signal for the caller). */
  matched_queries: string[];
}

/**
 * Repo metadata derived from a single GitHub search result item (spec §6 step 5
 * correction: the search response already carries every output field except the
 * README excerpt, so enrichment fetches ONLY the README). `RepoCandidate` is this
 * plus `readme_excerpt` and `matched_queries`.
 */
export interface RepoMeta {
  full_name: string;
  url: string;
  description: string | null;
  stars: number;
  forks: number;
  open_issues: number;
  last_pushed: string | null;
  license: string | null;
  primary_language: string | null;
}

/** Rate-limit headers parsed off a GitHub response (spec §7). */
export interface RateLimitInfo {
  remaining: number | null;
  limit: number | null;
  /** Unix epoch seconds when the window resets, or null. */
  reset: number | null;
}

/** The find_repos result envelope. */
export interface FindReposResult {
  candidates: RepoCandidate[];
  /** Non-fatal hints for the caller, e.g. the low-query-count nudge (D1). */
  notes?: string[];
  /** Present when results are partial due to rate limiting (spec §7). */
  degraded?: { reason: string };
}
