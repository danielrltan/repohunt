// readme.ts — denoise + bound a README into an evidence excerpt (spec §6.5, D2).
//
// This excerpt is load-bearing: it's what lets the calling agent reject
// plausible-but-wrong keyword matches (spec §13.2). Strategy (regex only, no
// markdown parser; smart section-detection deferred to v2):
//   - drop badge lines, bare images, HTML comments, and PURE-structural HTML
//     (lines that are only layout tags like <div align=center> or </p>);
//   - KEEP content-bearing HTML (<h1>Title</h1>, <p>Real description.</p>),
//     stripping just the tags so the inner text survives (review finding #1 —
//     dropping these gave a misleading "install steps but not what it is" excerpt);
//   - never denoise inside a fenced code block (review finding #5);
//   - bound to ~2000 chars, breaking at a heading/paragraph/word boundary, and
//     never split a UTF-16 surrogate pair on the fallback hard cut (finding #4).

const MAX_EXCERPT = 2000;
const MIN_BREAK = 1200; // don't break before this when hunting for a boundary

// [![alt](img)](link) repeated, or a bare ![alt](img) image line.
const BADGE_LINE = /^\s*(\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)\s*)+$/;
const IMAGE_LINE = /^\s*!\[[^\]]*\]\([^)]*\)\s*$/;
const FENCE = /^(?:```|~~~)/;
// Known HTML tags we strip to recover inner text. A known-tag list avoids
// mangling prose like "use `<T>` generics" (`<T>` is not a known tag).
const HTML_TAG =
  /<\/?(?:h[1-6]|p|div|span|a|strong|em|b|i|u|s|center|sub|sup|small|picture|source|img|br|hr|table|thead|tbody|tr|td|th|ul|ol|li|blockquote|code|pre|details|summary|kbd|samp|figure|figcaption|nobr|font)(?:\s[^>]*)?\/?>/gi;

function stripTags(s: string): string {
  return s.replace(HTML_TAG, "");
}

/** Returns a bounded, denoised excerpt, or null if there's no usable prose. */
export function denoiseAndExcerpt(markdown: string | null): string | null {
  if (!markdown) return null;

  const text = markdown.replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?-->/g, "");

  const out: string[] = [];
  let started = false;
  let inFence = false;
  for (const line of text.split("\n")) {
    const t = line.trim();

    if (FENCE.test(t)) {
      inFence = !inFence;
      started = true;
      out.push(line);
      continue;
    }
    if (inFence) {
      started = true;
      out.push(line); // never denoise inside a code fence
      continue;
    }

    // Pure-structural HTML (only tags, no text) is layout noise; content HTML keeps its text.
    const structural = t.length > 0 && /[<>]/.test(t) && stripTags(t).trim() === "";
    const noise = BADGE_LINE.test(t) || IMAGE_LINE.test(t) || structural;

    if (!started) {
      if (t === "" || noise) continue;
      started = true;
    } else if (noise) {
      continue;
    }
    out.push(stripTags(line));
  }

  const body = out.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!body) return null;
  if (body.length <= MAX_EXCERPT) return body;

  // Bound it, preferring a heading boundary, then paragraph, then line, then word.
  const slice = body.slice(0, MAX_EXCERPT);
  let cut = slice.lastIndexOf("\n#");
  if (cut < MIN_BREAK) cut = slice.lastIndexOf("\n\n");
  if (cut < MIN_BREAK) cut = slice.lastIndexOf("\n");
  if (cut < MIN_BREAK) cut = slice.lastIndexOf(" ");
  if (cut < MIN_BREAK) cut = MAX_EXCERPT; // unbroken run (CJK, base64): hard cap
  // Never split a UTF-16 surrogate pair on the hard cap.
  const prev = body.charCodeAt(cut - 1);
  if (prev >= 0xd800 && prev <= 0xdbff) cut -= 1;
  return body.slice(0, cut).trim();
}
