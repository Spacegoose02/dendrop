/**
 * The pieces of message formatting that don't need React: table rows, link safety checks and
 * code-block coloring. Kept apart from markdown.tsx so they can be tested on their own.
 */

// ---- Tables (GitHub style) --------------------------------------------------------------------

export type Align = "left" | "center" | "right" | undefined;

/** At most this many columns and body rows are shown; the rest is dropped. */
export const MAX_TABLE_COLS = 20;
export const MAX_TABLE_ROWS = 200;

/** The cells of a `| a | b |` row. `\|` and pipes inside `code` don't split a cell. */
export function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\" && i + 1 < s.length) {
      cell += c + s[++i];
      continue;
    }
    if (c === "`") inCode = !inCode;
    if (c === "|" && !inCode) {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += c;
  }
  cells.push(cell.trim());
  return cells;
}

const DELIM_CELL = /^:?-+:?$/;

/** The alignments of a `| --- | :-: | --: |` row, or null when the line isn't one. */
export function parseDelimiterRow(line: string): Align[] | null {
  if (!line.includes("|") || !/-/.test(line)) return null;
  const cells = splitTableRow(line);
  if (!cells.length || !cells.every((c) => DELIM_CELL.test(c))) return null;
  return cells.map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : undefined));
}

/** Whether `lines[i]` starts a table: a header row with a matching delimiter row under it. */
export function tableStartsAt(lines: string[], i: number): Align[] | null {
  const head = lines[i];
  const next = lines[i + 1];
  if (head === undefined || next === undefined || !head.includes("|")) return null;
  const aligns = parseDelimiterRow(next);
  if (!aligns || aligns.length !== splitTableRow(head).length) return null;
  return aligns;
}

/** Pads or cuts a row to the table's width. */
export function fitRow(cells: string[], width: number): string[] {
  const out = cells.slice(0, width);
  while (out.length < width) out.push("");
  return out;
}

// ---- Links ------------------------------------------------------------------------------------

/** The URL if it's http(s) with no user name or password in it (`https://bank.com@evil.example`). */
export function safeHttpUrl(href: string): URL | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  return u;
}

function normalHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}

// Dots that look like "." (ideographic, full width, one-dot leader…) and invisible characters.
const LOOKALIKE_DOTS = /[。．｡․·‧]/g;
const INVISIBLE = /[​-‏⁠﻿­]/g;
const HOST_IN_LABEL =
  /(?:[a-z0-9¡-￿](?:[a-z0-9¡-￿-]{0,61}[a-z0-9¡-￿])?\.)+[a-z¡-￿]{2,63}(?![a-z0-9¡-￿-])/i;

/** The web address a link's text seems to name (`paypal.com`, `https://x.y/z`), if any. */
export function hostClaimedBy(label: string): string | null {
  const text = label.replace(INVISIBLE, "").replace(LOOKALIKE_DOTS, ".");
  const m = HOST_IN_LABEL.exec(text);
  if (!m) return null;
  try {
    return normalHost(new URL(`http://${m[0]}`).hostname);
  } catch {
    return null;
  }
}

/**
 * Whether a `[label](url)` link should show where it really goes next to its text: when the
 * label names a different site than the link (`[paypal.com](https://evil.example)`), or the real
 * address uses look-alike letters (punycode, `xn--`).
 */
export function linkNeedsHost(label: string, url: URL): boolean {
  const real = normalHost(url.hostname);
  if (real.split(".").some((part) => part.startsWith("xn--"))) return true;
  const claimed = hostClaimedBy(label);
  if (!claimed) return false;
  return !(real === claimed || real.endsWith(`.${claimed}`));
}

// ---- Code coloring ----------------------------------------------------------------------------

export type TokenKind = "comment" | "string" | "number" | "keyword" | "literal" | "fn" | "tag" | "attr";
export interface Token {
  kind?: TokenKind;
  text: string;
}

/** Longer code blocks are shown without colors, so a huge paste stays quick. */
export const MAX_HIGHLIGHT = 20_000;

type Family = "c" | "hash" | "sql" | "markup";

const FAMILY: Record<string, Family> = {};
for (const l of "js javascript jsx mjs cjs ts typescript tsx java c h cpp c++ cc hpp cs csharp go golang rust rs kotlin kt swift php dart scala css scss less json jsonc json5 groovy zig".split(" ")) FAMILY[l] = "c";
for (const l of "py python sh bash shell zsh fish console rb ruby yaml yml toml ini conf dockerfile docker ps1 powershell pwsh r perl pl make makefile nix elixir ex exs".split(" ")) FAMILY[l] = "hash";
for (const l of "sql mysql postgres postgresql psql sqlite lua hs haskell".split(" ")) FAMILY[l] = "sql";
for (const l of "html htm xml svg vue svelte xhtml".split(" ")) FAMILY[l] = "markup";

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

const KEYWORDS: Record<Exclude<Family, "markup">, Set<string>> = {
  c: words(`abstract as async await break case catch class const continue debugger declare default defer delete do else enum
    export extends final finally fn for foreach from func function get go goto if impl implements import in instanceof interface
    internal let loop match mod module move mut namespace new of override package private protected pub public readonly return
    select set static struct super switch synchronized this throw throws trait try type typeof unsafe use using var void volatile
    when where while with yield int long short char float double bool boolean byte string str usize isize u8 u16 u32 u64 i8 i16
    i32 i64 f32 f64 auto signed unsigned sizeof typedef extern inline chan map range fun val object companion lateinit guard
    elif endif define include pragma`),
  hash: words(`and as assert async await break case class def del do done elif else end ensure esac except fi finally for from
    function global if import in is lambda local module nonlocal not or pass raise rescue return self then try unless until when
    while with yield echo export readonly source alias begin defined puts require`),
  sql: words(`select from where and or not insert into values update set delete create table drop alter add column index view
    join left right inner outer full cross on as group by order having limit offset union all distinct case when then else end
    is in like between exists primary key foreign references default null unique constraint begin commit rollback transaction
    with returning asc desc integer int text varchar real boolean blob date timestamp local function return if elseif for do
    while repeat until break nil true false let where module import data instance class deriving`),
};

const LITERALS = words("true false null undefined None True False nil NaN Infinity NULL TRUE FALSE self this");

const NUMBER = String.raw`\b(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b`;
const WORD = String.raw`[A-Za-z_$][\w$]*`;

function tokenRegex(family: Family): RegExp {
  const parts: string[] = [];
  if (family === "markup") {
    parts.push(String.raw`(?<comment><!--[\s\S]*?(?:-->|$))`);
    parts.push(String.raw`(?<string>"[^"\n]*"?|'[^'\n]*'?)`);
    parts.push(String.raw`(?<tag></?[A-Za-z][\w:-]*|/?>)`);
    parts.push(String.raw`(?<attr>[A-Za-z_:][\w:.-]*(?==))`);
    return new RegExp(parts.join("|"), "g");
  }
  const comment =
    family === "c" ? String.raw`//[^\n]*|/\*[\s\S]*?(?:\*/|$)` : family === "hash" ? String.raw`#[^\n]*` : String.raw`--[^\n]*|/\*[\s\S]*?(?:\*/|$)`;
  parts.push(`(?<comment>${comment})`);
  const strings = [String.raw`"(?:[^"\\\n]|\\.)*"?`, String.raw`'(?:[^'\\\n]|\\.)*'?`];
  if (family === "c") strings.unshift(String.raw`\x60(?:[^\x60\\]|\\[\s\S])*\x60?`);
  if (family === "hash") strings.unshift(String.raw`"""[\s\S]*?(?:"""|$)`, String.raw`'''[\s\S]*?(?:'''|$)`);
  parts.push(`(?<string>${strings.join("|")})`);
  parts.push(`(?<number>${NUMBER})`);
  parts.push(`(?<word>${WORD})`);
  return new RegExp(parts.join("|"), "g");
}

const REGEX_CACHE = new Map<Family, RegExp>();

/** The family of coloring rules for a code block's language, or undefined for none. */
export function codeFamily(lang: string): Family | undefined {
  return FAMILY[lang.toLowerCase()];
}

/**
 * Splits code into colored pieces. Unknown languages, and very long code, come back as one
 * plain piece. Joining every token's text always gives back the code exactly.
 */
export function highlight(code: string, lang: string): Token[] {
  const family = codeFamily(lang);
  if (!family || code.length > MAX_HIGHLIGHT) return [{ text: code }];
  let re = REGEX_CACHE.get(family);
  if (!re) REGEX_CACHE.set(family, (re = tokenRegex(family)));
  re.lastIndex = 0;
  const kw = family === "markup" ? undefined : KEYWORDS[family];
  const out: Token[] = [];
  let plain = "";
  const push = (kind: TokenKind | undefined, text: string) => {
    if (!kind) {
      plain += text;
      return;
    }
    if (plain) out.push({ text: plain });
    plain = "";
    out.push({ kind, text });
  };
  let last = 0;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    if (m[0] === "") {
      re.lastIndex++;
      continue;
    }
    if (m.index > last) push(undefined, code.slice(last, m.index));
    const g = m.groups!;
    const text = m[0];
    let kind: TokenKind | undefined;
    if (g.comment !== undefined) kind = "comment";
    else if (g.string !== undefined) kind = "string";
    else if (g.number !== undefined) kind = "number";
    else if (g.tag !== undefined) kind = "tag";
    else if (g.attr !== undefined) kind = "attr";
    else if (g.word !== undefined) {
      const lower = family === "sql" ? text.toLowerCase() : text;
      if (LITERALS.has(text)) kind = "literal";
      else if (kw?.has(lower)) kind = "keyword";
      else if (/^\s*\(/.test(code.slice(re.lastIndex, re.lastIndex + 8))) kind = "fn";
    }
    push(kind, text);
    last = re.lastIndex;
  }
  if (last < code.length) push(undefined, code.slice(last));
  if (plain) out.push({ text: plain });
  return out;
}
