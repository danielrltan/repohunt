// github.test.ts — M1 client: auth/token, search qualifier + mapping,
// rate-limit + 404 behavior, bounded concurrency. All against a fake fetch.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  searchRepos,
  fetchReadme,
  boundedMap,
  getGithubToken,
  MissingTokenError,
  RateLimitError,
  GitHubError,
  type FetchLike,
} from "../src/github.js";

function fakeRes(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const status = init.status ?? 200;
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: `Status ${status}`,
    headers: new Headers(init.headers ?? {}),
    json: async () => body,
  } as unknown as Response;
}

const SEARCH_ITEM = {
  full_name: "owner/repo",
  html_url: "https://github.com/owner/repo",
  description: "a thing",
  stargazers_count: 123,
  forks_count: 4,
  open_issues_count: 5,
  pushed_at: "2026-01-02T00:00:00Z",
  language: "TypeScript",
  license: { spdx_id: "MIT" },
};

beforeEach(() => {
  process.env.GITHUB_TOKEN = "test-token-do-not-log";
});
afterEach(() => {
  delete process.env.GITHUB_TOKEN;
});

describe("getGithubToken", () => {
  it("returns the trimmed token", () => {
    process.env.GITHUB_TOKEN = "  abc  ";
    expect(getGithubToken()).toBe("abc");
  });

  it("throws MissingTokenError when unset or blank", () => {
    delete process.env.GITHUB_TOKEN;
    expect(() => getGithubToken()).toThrow(MissingTokenError);
    process.env.GITHUB_TOKEN = "   ";
    expect(() => getGithubToken()).toThrow(MissingTokenError);
  });

  it("never includes the token in the error message", () => {
    process.env.GITHUB_TOKEN = "super-secret";
    delete process.env.GITHUB_TOKEN;
    try {
      getGithubToken();
    } catch (e) {
      expect((e as Error).message).not.toContain("super-secret");
    }
  });
});

describe("searchRepos", () => {
  it("builds the q with in:readme + language + stars qualifiers and maps items", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => fakeRes({ items: [SEARCH_ITEM] }));
    const repos = await searchRepos("rate limit middleware", { language: "typescript", minStars: 100 }, fetchMock);

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    const q = calledUrl.searchParams.get("q")!;
    expect(q).toContain("rate limit middleware");
    expect(q).toContain("in:name,description,readme");
    expect(q).toContain("language:typescript");
    expect(q).toContain("stars:>=100");
    expect(calledUrl.searchParams.get("per_page")).toBe("10");
    // sort omitted → best-match default
    expect(calledUrl.searchParams.has("sort")).toBe(false);

    expect(repos).toEqual([
      {
        full_name: "owner/repo",
        url: "https://github.com/owner/repo",
        description: "a thing",
        stars: 123,
        forks: 4,
        open_issues: 5,
        last_pushed: "2026-01-02T00:00:00Z",
        license: "MIT",
        primary_language: "TypeScript",
      },
    ]);
  });

  it("sends the Bearer token but it never leaks into thrown errors", async () => {
    const fetchMock = vi.fn<FetchLike>(async (_url, init) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-token-do-not-log");
      return fakeRes({ message: "Bad credentials" }, { status: 401 });
    });
    await expect(searchRepos("x", {}, fetchMock)).rejects.toMatchObject({ status: 401 });
    await searchRepos("x", {}, fetchMock).catch((e: Error) => {
      expect(e.message).not.toContain("test-token-do-not-log");
    });
  });

  it("normalizes NOASSERTION license and missing fields", async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      fakeRes({ items: [{ ...SEARCH_ITEM, license: { spdx_id: "NOASSERTION" }, description: null }] }),
    );
    const [repo] = await searchRepos("x", {}, fetchMock);
    expect(repo.license).toBeNull();
    expect(repo.description).toBeNull();
  });

  it("returns [] when there are no items", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => fakeRes({}));
    expect(await searchRepos("x", {}, fetchMock)).toEqual([]);
  });

  it("throws MissingTokenError before any fetch when the token is absent", async () => {
    delete process.env.GITHUB_TOKEN;
    const fetchMock = vi.fn<FetchLike>(async () => fakeRes({ items: [] }));
    await expect(searchRepos("x", {}, fetchMock)).rejects.toThrow(MissingTokenError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a 403 with Retry-After to RateLimitError", async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      fakeRes({}, { status: 403, headers: { "retry-after": "60", "x-ratelimit-remaining": "0" } }),
    );
    await expect(searchRepos("x", {}, fetchMock)).rejects.toMatchObject({
      name: "RateLimitError",
      retryAfter: 60,
    });
  });

  it("treats a 429 as a rate limit even when remaining > 0 (secondary limit)", async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      fakeRes({}, { status: 429, headers: { "x-ratelimit-remaining": "57" } }),
    );
    const err = await searchRepos("x", {}, fetchMock).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.rate.remaining).toBe(57);
  });
});

describe("fetchReadme", () => {
  it("base64-decodes the README content", async () => {
    const content = Buffer.from("# Hello\nworld", "utf-8").toString("base64");
    const fetchMock = vi.fn<FetchLike>(async () => fakeRes({ content, encoding: "base64" }));
    expect(await fetchReadme("owner", "repo", fetchMock)).toBe("# Hello\nworld");
  });

  it("returns null on 404 (no README) instead of throwing", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => fakeRes({ message: "Not Found" }, { status: 404 }));
    expect(await fetchReadme("owner", "repo", fetchMock)).toBeNull();
  });

  it("propagates non-404 errors", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => fakeRes({ message: "boom" }, { status: 500 }));
    await expect(fetchReadme("owner", "repo", fetchMock)).rejects.toBeInstanceOf(GitHubError);
  });
});

describe("boundedMap", () => {
  it("never exceeds the concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    await boundedMap(items, 3, async (n) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n * 2;
    });
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it("returns settled results, isolating a single rejection", async () => {
    const results = await boundedMap([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("nope");
      return n;
    });
    expect(results[0]).toEqual({ status: "fulfilled", value: 1 });
    expect(results[1]).toMatchObject({ status: "rejected" });
    expect(results[2]).toEqual({ status: "fulfilled", value: 3 });
  });

  it("preserves input order", async () => {
    const results = await boundedMap([30, 10, 20], 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    expect(results.map((r) => (r.status === "fulfilled" ? r.value : null))).toEqual([30, 10, 20]);
  });
});

describe("review hardening (M1)", () => {
  it("treats a 403 WITHOUT rate-limit signals as GitHubError, not RateLimitError", async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      fakeRes(
        { message: "Resource protected by organization SAML enforcement. Grant your token access." },
        { status: 403, headers: { "x-ratelimit-remaining": "4999" } },
      ),
    );
    const err = await searchRepos("x", {}, fetchMock).catch((e) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err).not.toBeInstanceOf(RateLimitError);
    expect(err.status).toBe(403);
  });

  it("classifies a 403 with a secondary-rate-limit message as RateLimitError", async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      fakeRes({ message: "You have exceeded a secondary rate limit" }, { status: 403, headers: { "x-ratelimit-remaining": "10" } }),
    );
    await expect(searchRepos("x", {}, fetchMock)).rejects.toBeInstanceOf(RateLimitError);
  });

  it("quotes a multi-word language qualifier", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => fakeRes({ items: [] }));
    await searchRepos("x", { language: "Jupyter Notebook" }, fetchMock);
    const q = new URL(fetchMock.mock.calls[0][0] as string).searchParams.get("q")!;
    expect(q).toContain('language:"Jupyter Notebook"');
  });

  it("clamps per_page to 1..100", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => fakeRes({ items: [] }));
    await searchRepos("x", { perPage: 0 }, fetchMock);
    expect(new URL(fetchMock.mock.calls[0][0] as string).searchParams.get("per_page")).toBe("1");
    await searchRepos("x", { perPage: 500 }, fetchMock);
    expect(new URL(fetchMock.mock.calls[1][0] as string).searchParams.get("per_page")).toBe("100");
  });

  it("maps a network failure to GitHubError(0)", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => {
      throw new Error("ECONNREFUSED");
    });
    const err = await searchRepos("x", {}, fetchMock).catch((e) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err.status).toBe(0);
  });

  it("maps a request timeout to GitHubError(0) 'request timed out'", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => {
      const e = new Error("aborted");
      e.name = "TimeoutError";
      throw e;
    });
    const err = await searchRepos("x", {}, fetchMock).catch((e) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err.message).toContain("timed out");
  });

  it("maps invalid JSON on a 200 to GitHubError", async () => {
    const fetchMock = vi.fn<FetchLike>(
      async () =>
        ({
          status: 200,
          ok: true,
          statusText: "OK",
          headers: new Headers(),
          json: async () => {
            throw new SyntaxError("Unexpected end of JSON input");
          },
        }) as unknown as Response,
    );
    await expect(searchRepos("x", {}, fetchMock)).rejects.toBeInstanceOf(GitHubError);
  });

  it("parses an HTTP-date Retry-After into positive seconds", async () => {
    const future = new Date(Date.now() + 120_000).toUTCString();
    const fetchMock = vi.fn<FetchLike>(async () => fakeRes({}, { status: 429, headers: { "retry-after": future } }));
    const err = await searchRepos("x", {}, fetchMock).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfter).toBeGreaterThan(0);
    expect(err.retryAfter).toBeLessThanOrEqual(121);
  });

  it("treats an empty x-ratelimit-remaining header as null, not 0", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => fakeRes({}, { status: 429, headers: { "x-ratelimit-remaining": "" } }));
    const err = await searchRepos("x", {}, fetchMock).catch((e) => e);
    expect(err.rate.remaining).toBeNull();
  });
});
