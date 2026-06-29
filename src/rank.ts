// rank.ts — cheap, pure pre-rank (spec §6.4, D8). Runs BEFORE README enrichment.
//
// D8 ordering: more matched queries first, then better GitHub best-match
// position, then more recently pushed. Stars is a WEAK final tiebreaker only —
// over-weighting it buried niche exact-matches under popular generics, which is
// exactly the repo this tool exists to surface (outside-voice finding).

import type { RepoMeta } from "./types.js";

export interface Ranked extends RepoMeta {
  /** Distinct input queries that surfaced this repo. */
  matched_queries: string[];
  /** Best (lowest) best-match position across the queries that surfaced it. */
  best_match_rank: number;
}

function pushedAtMs(iso: string | null): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/** Stable, deterministic pre-rank. Does not mutate the input. */
export function prerank<T extends Ranked>(pool: readonly T[]): T[] {
  return [...pool].sort((a, b) => {
    if (b.matched_queries.length !== a.matched_queries.length) {
      return b.matched_queries.length - a.matched_queries.length;
    }
    if (a.best_match_rank !== b.best_match_rank) {
      return a.best_match_rank - b.best_match_rank;
    }
    const dt = pushedAtMs(b.last_pushed) - pushedAtMs(a.last_pushed);
    if (dt !== 0) return dt;
    return b.stars - a.stars; // weak tiebreaker only (D8)
  });
}
