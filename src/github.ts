// github.ts — GitHub API client (Milestone M1).
//
// One shared `githubRequest` helper does auth + rate-limit accounting + error
// mapping; `searchRepos` and `fetchReadme` build on it. The token is read from
// GITHUB_TOKEN and NEVER interpolated into an error, log, or thrown message
// (invariant #3). `boundedMap` runs fan-outs with small concurrency to avoid
// GitHub's secondary-rate-limit penalties (D7).
//
// Rate-limit classification: 429 is always a rate limit; 403 is overloaded
// (SSO/forbidden/scope), so it counts as a rate limit ONLY when the signals say
// so (remaining==0, a Retry-After, or a rate-limit message). Otherwise a
// permanent auth error would masquerade as transient throttling and trigger
// retry storms (review finding #1, corrects the naive "all 403 = rate limit").

import type { RepoMeta, RateLimitInfo } from "./types.js";

const API_BASE = "https://api.github.com";
const USER_AGENT = "repohunt-mcp";
const API_VERSION = "2022-11-28";
const REQUEST_TIMEOUT_MS = 10_000;

/** Injectable fetch so tests can run without network. */
export type FetchLike = typeof fetch;

/** GITHUB_TOKEN is absent or blank. */
export class MissingTokenError extends Error {
  constructor() {
    super(
      "GITHUB_TOKEN is not set. Create a read-only token (a classic PAT with NO " +
        "scopes works for public repos, or a fine-grained token with read-only " +
        "access) and set GITHUB_TOKEN. See the README. The token never leaves your machine.",
    );
    this.name = "MissingTokenError";
  }
}

/** A GitHub primary or secondary rate limit was hit (403/429). */
export class RateLimitError extends Error {
  constructor(
    status: number,
    /** Seconds to wait, from Retry-After or x-ratelimit-reset, if known. */
    readonly retryAfter: number | undefined,
    readonly rate: RateLimitInfo,
  ) {
    super(`GitHub rate limit hit (HTTP ${status})`);
    this.name = "RateLimitError";
  }
}

/** Any other non-2xx GitHub response, a network failure (status 0), or a
 *  timeout (status 0). Never carries the token. */
export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`GitHub API error ${status}: ${message}`);
    this.name = "GitHubError";
  }
}

/** Read + validate the token. Exported so the server can fail fast at startup (M3). */
export function getGithubToken(): string {
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) throw new MissingTokenError();
  return token;
}

function parseRate(headers: Headers): RateLimitInfo {
  const num = (key: string): number | null => {
    const raw = headers.get(key);
    if (raw == null || raw.trim() === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  return {
    remaining: num("x-ratelimit-remaining"),
    limit: num("x-ratelimit-limit"),
    reset: num("x-ratelimit-reset"),
  };
}

/** Best-effort backoff hint: Retry-After (delay-seconds OR HTTP-date), else the
 *  x-ratelimit-reset epoch. Returns seconds-from-now, or undefined if unknown. */
function parseRetryAfter(headers: Headers, rate: RateLimitInfo): number | undefined {
  const raw = headers.get("retry-after");
  if (raw) {
    const secs = Number(raw);
    if (Number.isFinite(secs) && secs > 0) return Math.ceil(secs);
    const when = Date.parse(raw);
    if (Number.isFinite(when)) {
      const delta = Math.ceil((when - Date.now()) / 1000);
      if (delta > 0) return delta;
    }
  }
  if (rate.reset != null) {
    const delta = Math.ceil(rate.reset - Date.now() / 1000);
    if (delta > 0) return delta;
  }
  return undefined;
}

/** Pull a human message off an error response without ever throwing. */
async function safeMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string };
    if (body?.message) return body.message;
  } catch {
    // non-JSON body
  }
  return res.statusText || "request failed";
}

interface GitHubResponse<T> {
  data: T;
  status: number;
  rate: RateLimitInfo;
}

async function githubRequest<T>(
  path: string,
  params: Record<string, string | number | undefined> | undefined,
  fetchImpl: FetchLike,
): Promise<GitHubResponse<T>> {
  const token = getGithubToken();
  const url = new URL(path.startsWith("http") ? path : API_BASE + path);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }

  let res: Response;
  try {
    res = await fetchImpl(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": API_VERSION,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // Timeout or network failure → typed, recoverable error so the settled
    // fan-out degrades instead of hanging forever. Never carries the token.
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    throw new GitHubError(0, timedOut ? "request timed out" : "network error");
  }

  const rate = parseRate(res.headers);

  if (!res.ok) {
    const message = await safeMessage(res);
    const retryAfter = parseRetryAfter(res.headers, rate);
    const isRateLimit =
      res.status === 429 ||
      (res.status === 403 &&
        (rate.remaining === 0 || retryAfter !== undefined || /rate limit|secondary|abuse/i.test(message)));
    if (isRateLimit) throw new RateLimitError(res.status, retryAfter, rate);
    throw new GitHubError(res.status, message);
  }

  try {
    const data = (await res.json()) as T;
    return { data, status: res.status, rate };
  } catch {
    throw new GitHubError(res.status, "invalid JSON in response body");
  }
}

export interface SearchOptions {
  language?: string;
  minStars?: number;
  /** Results to pull per query. Defaults to 10 (spec §6.2), clamped to 1–100. */
  perPage?: number;
}

interface SearchItem {
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  pushed_at: string | null;
  language: string | null;
  license: { spdx_id: string | null } | null;
}

function mapSearchItem(item: SearchItem): RepoMeta {
  const spdx = item.license?.spdx_id ?? null;
  return {
    full_name: item.full_name,
    url: item.html_url,
    description: item.description ?? null,
    stars: item.stargazers_count ?? 0,
    forks: item.forks_count ?? 0,
    open_issues: item.open_issues_count ?? 0,
    last_pushed: item.pushed_at ?? null,
    // GitHub returns "NOASSERTION" for unrecognized licenses; normalize to null.
    license: spdx && spdx !== "NOASSERTION" ? spdx : null,
    primary_language: item.language ?? null,
  };
}

/** Quote a qualifier value if it contains whitespace (GitHub needs
 *  `language:"Jupyter Notebook"`, not `language:Jupyter Notebook`). */
function qualifierValue(raw: string): string {
  const v = raw.replace(/"/g, "").trim();
  return /\s/.test(v) ? `"${v}"` : v;
}

/**
 * Run one keyword search. `in:name,description,readme` is appended so the README
 * body is searched, not just name/description/topics (D6 — default search omits
 * the README). `sort` is intentionally omitted to get GitHub's best-match order;
 * results are returned in that order (the caller uses the index as a signal).
 */
export async function searchRepos(
  query: string,
  opts: SearchOptions = {},
  fetchImpl: FetchLike = fetch,
): Promise<RepoMeta[]> {
  const qualifiers = [query.trim(), "in:name,description,readme"];
  if (opts.language) {
    const lang = qualifierValue(opts.language);
    if (lang) qualifiers.push(`language:${lang}`);
  }
  if (opts.minStars && opts.minStars > 0) qualifiers.push(`stars:>=${Math.floor(opts.minStars)}`);

  const perPage = Math.min(100, Math.max(1, Math.floor(opts.perPage ?? 10)));
  const { data } = await githubRequest<{ items?: SearchItem[] }>(
    "/search/repositories",
    { q: qualifiers.join(" "), per_page: perPage },
    fetchImpl,
  );
  return (data.items ?? []).map(mapSearchItem);
}

/**
 * Fetch + decode a repo's README. Returns null when the repo has no README
 * (404) rather than throwing, so one README-less repo doesn't sink the result.
 * Rate-limit and other errors propagate (the caller's settled fan-out degrades).
 */
export async function fetchReadme(
  owner: string,
  repo: string,
  fetchImpl: FetchLike = fetch,
): Promise<string | null> {
  try {
    const { data } = await githubRequest<{ content?: string; encoding?: string }>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/readme`,
      undefined,
      fetchImpl,
    );
    if (!data.content) return null;
    if (data.encoding === "base64") {
      return Buffer.from(data.content, "base64").toString("utf-8");
    }
    return data.content;
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) return null;
    throw err;
  }
}

/**
 * Map over `items` with at most `limit` calls in flight, returning settled
 * results so a single rejection (e.g. one rate-limited query) keeps the rest.
 * Bounded concurrency avoids GitHub's secondary-rate-limit penalties (D7).
 */
export async function boundedMap<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));

  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}
