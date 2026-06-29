// readme.test.ts — denoise + bounded excerpt (D2, spec §13.2). Load-bearing.
import { describe, it, expect } from "vitest";
import { denoiseAndExcerpt } from "../src/readme.js";

describe("denoiseAndExcerpt (D2)", () => {
  it("returns null for null / empty / whitespace-only", () => {
    expect(denoiseAndExcerpt(null)).toBeNull();
    expect(denoiseAndExcerpt("")).toBeNull();
    expect(denoiseAndExcerpt("   \n  \n")).toBeNull();
  });

  it("strips leading badges, images, and HTML comments, keeping real prose", () => {
    const md = [
      "<!-- a comment -->",
      "[![build](https://img/b.svg)](https://ci)[![cov](https://img/c.svg)](https://cov)",
      "![logo](https://img/logo.png)",
      "",
      "# My Project",
      "Does a specific useful thing.",
    ].join("\n");
    const out = denoiseAndExcerpt(md)!;
    expect(out).toContain("# My Project");
    expect(out).toContain("Does a specific useful thing.");
    expect(out).not.toContain("img/b.svg");
    expect(out).not.toContain("a comment");
  });

  it("returns a short README as-is (denoised)", () => {
    expect(denoiseAndExcerpt("# Title\n\nShort and clean.")).toBe("# Title\n\nShort and clean.");
  });

  it("bounds a long README to the cap, breaking at a boundary (not mid-word)", () => {
    const para = "word ".repeat(80).trim();
    const md = "# Title\n\n" + Array.from({ length: 12 }, (_, i) => `## Section ${i}\n\n${para}`).join("\n\n");
    const out = denoiseAndExcerpt(md)!;
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(out).toContain("# Title");
    expect(out.endsWith(" ")).toBe(false);
  });

  it("returns null when a README is only badges / layout noise", () => {
    const md = '[![a](x)](y)\n![img](z)\n<div align="center"></div>';
    expect(denoiseAndExcerpt(md)).toBeNull();
  });

  it("preserves content-bearing HTML headers, stripping only the tags (finding #1)", () => {
    const md = '<div align="center">\n<h1>Cool Project</h1>\n<p>Does a specific thing.</p>\n</div>\n\n## Install\n\nrun it';
    const out = denoiseAndExcerpt(md)!;
    expect(out).toContain("Cool Project");
    expect(out).toContain("Does a specific thing.");
    expect(out).not.toContain("<h1>");
    expect(out).not.toContain("<div");
  });

  it("does not strip badge-like lines inside a code fence (finding #5)", () => {
    const md = "# T\n\nIntro.\n\n```md\n![example](pic.png)\n```\n";
    expect(denoiseAndExcerpt(md)).toContain("![example](pic.png)");
  });
});
