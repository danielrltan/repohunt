// findRepos.ts — the find_repos tool handler. Orchestrates the §6 pipeline:
//
//   validate → fan-out search (bounded, settled) → pool & dedupe (matched_queries)
//   → cheap pre-rank (D8) → TRIM to an enrich buffer → enrich READMEs for the
//   buffer ONLY → backfill around fetch failures → assemble top max_results.
//
// Invariants: no LLM/model call anywhere; READMEs are fetched only for the
// trimmed enrich buffer, never the whole pool (trim-before-enrich, §9.4); one
// failed query or one rate-limited README degrades gracefully to partial
// results, never a crash (§7). Degraded reasons name the REAL cause (rate limit
// vs auth vs invalid query vs network) so the caller doesn't blindly retry an
// unretryable failure (review finding #2).
//
// The enrich buffer (a few more than max_results) is failure insurance: if a
// README fetch is rate-limited, a buffered candidate that DID enrich backfills
// it, so a couple of 403s don't blow holes in the returned set. The real fix
// for "niche repos cut for generics" is the pre-rank's stars down-weight (D8).

import {
  searchRepos,
  fetchReadme,
  boundedMap,
  RateLimitError,
  GitHubError,
  MissingTokenError,
  type FetchLike,
  type SearchOptions,
} from "./github.js";
import { prerank, type Ranked } from "./rank.js";
import { denoiseAndExcerpt } from "./readme.js";
import type { FindReposInput, FindReposResult, RepoCandidate } from "./types.js";

const DEFAULT_MAX = 8;
const MAX_CAP = 15;
const MAX_QUERIES = 8;
const PER_QUERY = 10;
const SEARCH_CONCURRENCY = 3;
const ENRICH_CONCURRENCY = 3;
const ENRICH_BUFFER = 3;
const LOW_QUERY_THRESHOLD = 3;

/** Thrown for invalid tool input; the MCP layer (M3) maps it to a tool error. */
export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInputError";
  }
}

/** Human-readable, accurate cause for a failed GitHub call (review finding #2). */
function failReason(err: unknown): string {
  if (err instanceof RateLimitError) return "GitHub rate limit";
  if (err instanceof MissingTokenError) return "GITHUB_TOKEN missing";
  if (err instanceof GitHubError) {
    if (err.status === 401) return "GitHub authentication failed";
    if (err.status === 422) return "a query was rejected as invalid search syntax";
    if (err.status === 0) return "GitHub was unreachable (network/timeout)";
    return `GitHub error ${err.status}`;
  }
  return "an unexpected error";
}

export async function findRepos(
  input: FindReposInput,
  fetchImpl: FetchLike = fetch,
): Promise<FindReposResult> {
  // 1. Validate + normalize. Input is untyped JSON at runtime, so guard shape.
  if (!Array.isArray(input?.queries)) {
    throw new InvalidInputError("find_repos: 'queries' must be an array of keyword strings.");
  }
  const queries = [
    ...new Set(input.queries.map((q) => (typeof q === "string" ? q.trim() : "")).filter((q) => q.length > 0)),
  ].slice(0, MAX_QUERIES);
  if (queries.length === 0) {
    throw new InvalidInputError("find_repos requires at least one non-empty query string.");
  }
  const rawMax =
    typeof input.max_results === "number" && Number.isFinite(input.max_results) ? input.max_results : DEFAULT_MAX;
  const maxResults = Math.min(MAX_CAP, Math.max(1, Math.floor(rawMax)));

  const notes: string[] = [];
  if (queries.length < LOW_QUERY_THRESHOLD) {
    notes.push(
      `only ${queries.length} quer${queries.length === 1 ? "y" : "ies"} provided — ` +
        "recall improves when the calling agent expands one intent into 4-8 varied keyword queries",
    );
  }

  // 2. Fan-out search with bounded concurrency; settled so one failure is isolated.
  const searchOpts: SearchOptions = {
    language: input.language,
    minStars: input.min_stars,
    perPage: PER_QUERY,
  };
  const settled = await boundedMap(queries, SEARCH_CONCURRENCY, (q) => searchRepos(q, searchOpts, fetchImpl));

  // 3. Pool + dedupe by full_name, recording matched_queries and best best-match rank.
  const searchFails = new Set<string>();
  const pool = new Map<string, Ranked>();
  settled.forEach((res, qi) => {
    if (res.status === "rejected") {
      searchFails.add(failReason(res.reason));
      return;
    }
    res.value.forEach((repo, rank) => {
      const existing = pool.get(repo.full_name);
      if (existing) {
        if (!existing.matched_queries.includes(queries[qi])) existing.matched_queries.push(queries[qi]);
        existing.best_match_rank = Math.min(existing.best_match_rank, rank);
      } else {
        pool.set(repo.full_name, { ...repo, matched_queries: [queries[qi]], best_match_rank: rank });
      }
    });
  });

  if (pool.size === 0) {
    // Distinguish a filtered-out empty from a genuine no-match (review finding #5).
    if (searchFails.size === 0 && (input.language || (typeof input.min_stars === "number" && input.min_stars > 0))) {
      notes.push("no repositories matched — try lowering min_stars or removing the language filter");
    }
    return finalize([], notes, searchFails, new Set());
  }

  // 4. Cheap pre-rank, then TRIM to the enrich buffer (before any README fetch).
  const ranked = prerank([...pool.values()]);
  const buffer = ranked.slice(0, Math.min(ranked.length, maxResults + ENRICH_BUFFER));

  // 5. Enrich READMEs for the buffer ONLY (bounded, settled). README-only — the
  //    metadata already came from search.
  const enriched = await boundedMap(buffer, ENRICH_CONCURRENCY, async (repo) => {
    const slash = repo.full_name.indexOf("/");
    if (slash <= 0 || slash >= repo.full_name.length - 1) return null; // malformed full_name
    const owner = repo.full_name.slice(0, slash);
    const name = repo.full_name.slice(slash + 1);
    return denoiseAndExcerpt(await fetchReadme(owner, name, fetchImpl));
  });

  const withExcerpt = buffer.map((repo, i) => {
    const r = enriched[i];
    if (r.status === "rejected") {
      return { repo, excerpt: null as string | null, failed: true, reason: failReason(r.reason) };
    }
    return { repo, excerpt: r.value, failed: false, reason: "" };
  });

  // 6. Backfill: sink fetch-failures to the back (stable sort), then take max_results.
  const selected = [...withExcerpt].sort((a, b) => Number(a.failed) - Number(b.failed)).slice(0, maxResults);

  const candidates: RepoCandidate[] = selected.map(({ repo, excerpt }) => ({
    full_name: repo.full_name,
    url: repo.url,
    description: repo.description,
    readme_excerpt: excerpt,
    stars: repo.stars,
    forks: repo.forks,
    open_issues: repo.open_issues,
    last_pushed: repo.last_pushed,
    license: repo.license,
    primary_language: repo.primary_language,
    matched_queries: repo.matched_queries,
  }));

  // Only count README failures that actually landed in the returned set.
  const readmeFails = new Set<string>();
  selected.forEach((s) => {
    if (s.failed) readmeFails.add(s.reason);
  });

  return finalize(candidates, notes, searchFails, readmeFails);
}

function finalize(
  candidates: RepoCandidate[],
  notes: string[],
  searchFails: Set<string>,
  readmeFails: Set<string>,
): FindReposResult {
  const result: FindReposResult = { candidates };
  if (notes.length > 0) result.notes = notes;

  const reasons: string[] = [];
  if (searchFails.size > 0) reasons.push(`some searches failed (${[...searchFails].join(", ")})`);
  if (readmeFails.size > 0) reasons.push(`some README fetches failed (${[...readmeFails].join(", ")})`);
  if (reasons.length > 0) result.degraded = { reason: `${reasons.join("; ")} — results may be partial` };

  return result;
}
