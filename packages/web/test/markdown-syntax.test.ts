import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fitRow,
  highlight,
  hostClaimedBy,
  linkNeedsHost,
  MAX_HIGHLIGHT,
  parseDelimiterRow,
  safeHttpUrl,
  splitTableRow,
  tableStartsAt,
} from "../src/markdown-syntax.ts";

test("table rows split on pipes, but not escaped ones or ones in code", () => {
  assert.deepEqual(splitTableRow("| a | b |"), ["a", "b"]);
  assert.deepEqual(splitTableRow("a | b"), ["a", "b"]);
  assert.deepEqual(splitTableRow("| x \\| y | `a|b` |"), ["x \\| y", "`a|b`"]);
  assert.deepEqual(fitRow(["a"], 3), ["a", "", ""]);
  assert.deepEqual(fitRow(["a", "b", "c"], 2), ["a", "b"]);
});

test("delimiter rows give alignments; other lines aren't tables", () => {
  assert.deepEqual(parseDelimiterRow("| --- | :-- | :-: | --: |"), [undefined, "left", "center", "right"]);
  assert.equal(parseDelimiterRow("---"), null);
  assert.equal(parseDelimiterRow("| a | b |"), null);
  assert.ok(tableStartsAt(["| a | b |", "|---|---|", "| 1 | 2 |"], 0));
  assert.equal(tableStartsAt(["| a | b |", "|---|"], 0), null, "column counts must match");
  assert.equal(tableStartsAt(["||spoiler||", "text"], 0), null);
  assert.equal(tableStartsAt(["just text", "- item"], 0), null);
});

test("only plain http(s) links, never ones hiding a user name", () => {
  assert.ok(safeHttpUrl("https://example.com/a"));
  assert.equal(safeHttpUrl("javascript:alert(1)"), null);
  assert.equal(safeHttpUrl("https://paypal.com@evil.example/"), null);
  assert.equal(safeHttpUrl("not a url"), null);
});

test("labelled links that name another site show the real one", () => {
  const u = (s: string) => safeHttpUrl(s)!;
  assert.equal(hostClaimedBy("see the docs"), null);
  assert.equal(hostClaimedBy("https://www.PayPal.com/login"), "paypal.com");
  assert.equal(hostClaimedBy("paypal。com"), "paypal.com", "look-alike dot");
  assert.equal(linkNeedsHost("the docs", u("https://example.com")), false);
  assert.equal(linkNeedsHost("github.com", u("https://github.com/x")), false);
  assert.equal(linkNeedsHost("github.com", u("https://gist.github.com/x")), false, "a subdomain of the named site is fine");
  assert.equal(linkNeedsHost("paypal.com", u("https://evil.example")), true);
  assert.equal(linkNeedsHost("https://paypal.com", u("https://paypal.com.evil.example")), true);
  assert.equal(linkNeedsHost("**paypal.com**", u("https://evil.example")), true);
  assert.equal(linkNeedsHost("pay​pal.com", u("https://evil.example")), true, "invisible characters");
  assert.equal(linkNeedsHost("apple", u("https://аррle.com")), true, "Cyrillic look-alike host");
});

test("code coloring keeps the text exactly and colors the obvious pieces", () => {
  const code = 'const x = 42; // the answer\nfunction f(a) { return "hi\\"" + `t` }';
  const toks = highlight(code, "js");
  assert.equal(toks.map((t) => t.text).join(""), code);
  const kinds = (k: string) => toks.filter((t) => t.kind === k).map((t) => t.text);
  assert.deepEqual(kinds("keyword"), ["const", "function", "return"]);
  assert.deepEqual(kinds("number"), ["42"]);
  assert.deepEqual(kinds("comment"), ["// the answer"]);
  assert.deepEqual(kinds("string"), ['"hi\\""', "`t`"]);
  assert.deepEqual(kinds("fn"), ["f"]);

  const py = highlight("def f():\n    # hi\n    return None", "Python");
  assert.deepEqual(py.filter((t) => t.kind).map((t) => [t.kind, t.text]), [
    ["keyword", "def"],
    ["fn", "f"],
    ["comment", "# hi"],
    ["keyword", "return"],
    ["literal", "None"],
  ]);
  assert.deepEqual(highlight("SELECT 1 -- x", "sql").filter((t) => t.kind).map((t) => t.kind), ["keyword", "number", "comment"]);
  const html = '<a href="x">hi</a><!-- c -->';
  assert.equal(highlight(html, "html").map((t) => t.text).join(""), html);
});

test("unknown languages and huge blocks stay plain", () => {
  assert.deepEqual(highlight("const x = 1", ""), [{ text: "const x = 1" }]);
  assert.deepEqual(highlight("const x = 1", "nope"), [{ text: "const x = 1" }]);
  const big = "x".repeat(MAX_HIGHLIGHT + 1);
  assert.deepEqual(highlight(big, "js"), [{ text: big }]);
});
