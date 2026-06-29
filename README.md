# repohunt

> Grounded GitHub repo discovery as an MCP server. Your AI agent expands one
> intent into several keyword queries; repohunt fires them at GitHub's live
> Search API, dedupes and ranks the hits, and returns clean structured
> **evidence** (a trimmed README excerpt plus metadata) for the agent to judge.
>
> **No embeddings. No corpus. No backend. No LLM inside the server.** All the
> intelligence lives in the agent you're already paying for, so repohunt costs
> nothing to run and nothing to use beyond your own GitHub rate limit.

## Why

When you start a feature, the right first move is often "find a repo to fork,
study, or avoid" rather than building from scratch. GitHub's native search is a
flat keyword list with no judgment. Thankfully, GitHub already maintains the keyword index; the
calling agent supplies the query variety on the way in and the ranking judgment on
the way out.

While keyword search has a somewhat weak intent-recall than say semantic search, this tool narrows the gap by (a) searching README **bodies**, not just names
and descriptions, and (b) firing 4-8 agent-expanded query variations per call.

## Quick start

### 1. Get a GitHub token (read-only)

A token raises your search rate limit from ~10/min (unauthenticated, degraded) to
30/min. **Public-repo read needs no scopes at all.**

**Classic token (simplest):**
1. Open <https://github.com/settings/tokens/new>
2. Note: `repohunt`. Expiration: your choice.
3. **Select NO scopes.** Public read needs none. Do not check `public_repo`, that's a *write* scope.
4. Generate and copy the `ghp_...` token.

**Fine-grained token (most locked-down):** open <https://github.com/settings/personal-access-tokens/new>, set Repository access to **Public repositories (read-only)** with no account permissions.

The token only ever lives in your MCP host config on your machine. repohunt never
sends it anywhere except `api.github.com`.

### 2. Add repohunt to your MCP host

**Claude Desktop:** open Settings > Developer > Edit Config, then add:

```json
{
  "mcpServers": {
    "repohunt": {
      "command": "npx",
      "args": ["-y", "repohunt"],
      "env": { "GITHUB_TOKEN": "ghp_your_token_here" }
    }
  }
}
```

Restart the host. You should see `find_repos` in the tool list. The same
`command`/`args`/`env` shape works for Cursor, Claude Code, or any MCP host.

If `GITHUB_TOKEN` is missing, repohunt exits immediately with a message telling you
exactly how to fix it. It never silently runs unauthenticated.

## The `find_repos` tool

One tool. Your agent calls it; you don't.

**Input**

| Field | Type | Required | Notes |
|---|---|---|---|
| `queries` | `string[]` | yes | Keyword search strings. The agent expands ONE intent into 4-8 varied queries (synonyms, library names, restatements). More variety = better recall. |
| `language` | `string` | no | GitHub language filter, e.g. `"typescript"`. |
| `min_stars` | `integer` | no | Drop repos below this star count. Default `0`. |
| `max_results` | `integer` | no | Enriched candidates to return. Default `8`, hard cap `15`. |

**Output:** structured JSON. A list of `candidates`, each with `full_name`, `url`,
`description`, `readme_excerpt`, `stars`, `forks`, `open_issues`, `last_pushed`,
`license`, `primary_language`, and `matched_queries` (which of your queries surfaced
it). Plus optional `notes` (hints) and `degraded` (set when rate limits made the
results partial). It returns evidence, not a verdict. Ranking is the agent's job.

**Example.** You ask your agent: _"find me a rate-limiting middleware for Express."_
The agent expands the intent and calls:

```json
{
  "queries": [
    "express rate limit middleware",
    "express-rate-limit",
    "api throttling node",
    "request throttling express",
    "leaky bucket rate limiter node"
  ],
  "max_results": 5
}
```

repohunt returns (trimmed):

```json
{
  "candidates": [
    {
      "full_name": "express-rate-limit/express-rate-limit",
      "url": "https://github.com/express-rate-limit/express-rate-limit",
      "description": "Basic rate-limiting middleware for the Express web server",
      "readme_excerpt": "# express-rate-limit\n\nBasic rate-limiting middleware for Express. Use to limit repeated requests to public APIs and endpoints such as password reset...",
      "stars": 3000,
      "forks": 320,
      "open_issues": 4,
      "last_pushed": "2026-05-20T12:00:00Z",
      "license": "MIT",
      "primary_language": "TypeScript",
      "matched_queries": ["express rate limit middleware", "express-rate-limit", "request throttling express"]
    }
  ]
}
```

The agent reads the excerpts and tells you which repo to fork, study, or avoid.

## How it works

```
queries[]  ->  fan-out search (in:name,description,readme, bounded concurrency)
           ->  pool & dedupe (record matched_queries)  ->  cheap pre-rank  ->  TRIM
           ->  fetch READMEs for the survivors ONLY  ->  denoise + excerpt
           ->  return structured evidence              (no model call, ever)
```

Bounded concurrency keeps GitHub's secondary rate limits happy; READMEs are fetched
only for the trimmed candidate set (never the whole pool); a rate-limited query or
README degrades to partial results with a `degraded` note instead of failing.

## Development

```bash
npm install
npm run build       # tsc -> dist/
npm test            # vitest, mocked + deterministic
npm run typecheck

# optional: live smoke test against the real GitHub API
RUN_LIVE=1 GITHUB_TOKEN=ghp_... npm test
```

## License

MIT. See [LICENSE](./LICENSE).
