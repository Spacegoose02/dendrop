import { useState, type ReactNode } from "react";
import { RichText } from "./expressions.tsx";

/**
 * Message formatting, Discord style: **bold**, *italic* or _italic_, __underline__,
 * ~~strike~~, `code`, ```code blocks```, ||spoilers||, > quotes, # headings, - lists, links,
 * <@id> mentions and @everyone. A backslash shows the next character as it is (\*not bold\*).
 *
 * Everything is built as React elements (never HTML strings), so nothing in a message can add
 * markup or scripts. Links are only ever http or https, and open in a new tab.
 */
export interface MarkdownProps {
  text: string;
  /** Who <@id> is, for showing "@Name". */
  nameOf?: (userId: number) => string | undefined;
  meId?: number;
  /** Small, single-line (reply previews, search results): no blocks, no big emoji. */
  inline?: boolean;
}

/** Characters that mean the text has some formatting; plain text skips the parser. */
const SPECIAL = /[*_~`|>#\\<@-]|https?:\/\/|^\s*\d+\.\s/m;

export function Markdown({ text, nameOf, meId, inline }: MarkdownProps): ReactNode {
  if (!SPECIAL.test(text)) return <RichText text={text} inline={inline} />;
  const ctx: Ctx = { nameOf, meId, key: 0 };
  if (inline) return <>{parseInline(text.replace(/\n+/g, " "), ctx)}</>;
  // A message of only emoji still shows them big.
  if (!/[*_~`|>#\\]|https?:\/\/|<@|@everyone/.test(text)) return <RichText text={text} />;
  return <>{parseBlocks(text, ctx)}</>;
}

interface Ctx {
  nameOf?: (userId: number) => string | undefined;
  meId?: number;
  key: number;
}

// ---- Blocks: code blocks, quotes, headings, lists and paragraphs ------------------------------

function parseBlocks(text: string, ctx: Ctx): ReactNode[] {
  const out: ReactNode[] = [];
  const lines = text.split("\n");
  let para: string[] = [];
  const flush = () => {
    if (!para.length) return;
    out.push(
      <span className="md-p" key={ctx.key++}>
        {parseInline(para.join("\n"), ctx)}
      </span>,
    );
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s*```([\w+-]{0,20})\s*(.*)$/.exec(line);
    if (fence) {
      // Everything up to the closing ``` is code, shown exactly as typed.
      const rest = fence[2] ?? "";
      if (rest.endsWith("```") && rest.length >= 3) {
        flush();
        out.push(<CodeBlock key={ctx.key++} code={rest.slice(0, -3)} lang="" />);
        continue;
      }
      const body: string[] = rest ? [rest] : [];
      let j = i + 1;
      for (; j < lines.length && !/^\s*```\s*$/.test(lines[j]!) && !lines[j]!.trimEnd().endsWith("```"); j++) body.push(lines[j]!);
      if (j < lines.length) {
        const last = lines[j]!.trimEnd();
        if (!/^\s*```\s*$/.test(last)) body.push(last.slice(0, -3));
        flush();
        out.push(<CodeBlock key={ctx.key++} code={body.join("\n")} lang={fence[1] ?? ""} />);
        i = j;
        continue;
      }
      // No closing fence: just text.
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      const q: string[] = [quote[1]!];
      while (i + 1 < lines.length && /^>\s?/.test(lines[i + 1]!)) q.push(lines[++i]!.replace(/^>\s?/, ""));
      out.push(
        <blockquote className="md-quote" key={ctx.key++}>
          {parseInline(q.join("\n"), ctx)}
        </blockquote>,
      );
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      const Tag = (["h3", "h4", "h5"] as const)[heading[1]!.length - 1]!;
      out.push(
        <Tag className="md-h" key={ctx.key++}>
          {parseInline(heading[2]!, ctx)}
        </Tag>,
      );
      continue;
    }
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    const numbered = /^\s*(\d{1,3})\.\s+(.+)$/.exec(line);
    if (bullet || numbered) {
      flush();
      const items: string[] = [];
      const re = bullet ? /^\s*[-*]\s+(.+)$/ : /^\s*\d{1,3}\.\s+(.+)$/;
      let k = i;
      for (; k < lines.length; k++) {
        const m = re.exec(lines[k]!);
        if (!m) break;
        items.push(m[1]!);
      }
      i = k - 1;
      const lis = items.map((it) => <li key={ctx.key++}>{parseInline(it, ctx)}</li>);
      out.push(
        bullet ? (
          <ul className="md-list" key={ctx.key++}>
            {lis}
          </ul>
        ) : (
          <ol className="md-list" key={ctx.key++} start={Number(numbered![1])}>
            {lis}
          </ol>
        ),
      );
      continue;
    }
    para.push(line);
  }
  flush();
  return out;
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="md-codeblock">
      <div className="md-codeblock-bar">
        <span className="muted small">{lang || "code"}</span>
        <button
          className="ghost small"
          onClick={() => {
            void navigator.clipboard?.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

// ---- Inline: emphasis, code, spoilers, links and mentions ---------------------------------------

interface Rule {
  re: RegExp;
  render: (m: RegExpExecArray, ctx: Ctx) => ReactNode;
}

const URL_RE = /https?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}]/;

const RULES: Rule[] = [
  // A backslash escapes the next character.
  { re: /\\([*_~`|\\>#@<-])/, render: (m) => m[1] },
  { re: /`([^`\n]+)`/, render: (m, ctx) => <code className="md-code" key={ctx.key++}>{m[1]}</code> },
  { re: /\|\|([\s\S]+?)\|\|/, render: (m, ctx) => <Spoiler key={ctx.key++}>{parseInline(m[1]!, ctx)}</Spoiler> },
  { re: /\*\*([\s\S]+?)\*\*(?!\*)/, render: (m, ctx) => <strong key={ctx.key++}>{parseInline(m[1]!, ctx)}</strong> },
  { re: /__([\s\S]+?)__(?!_)/, render: (m, ctx) => <u key={ctx.key++}>{parseInline(m[1]!, ctx)}</u> },
  { re: /~~([\s\S]+?)~~/, render: (m, ctx) => <s key={ctx.key++}>{parseInline(m[1]!, ctx)}</s> },
  { re: /\*(?!\s)([\s\S]+?)(?<!\s)\*/, render: (m, ctx) => <em key={ctx.key++}>{parseInline(m[1]!, ctx)}</em> },
  { re: /(?<![\w])_(?!\s)([\s\S]+?)(?<!\s)_(?![\w])/, render: (m, ctx) => <em key={ctx.key++}>{parseInline(m[1]!, ctx)}</em> },
  { re: URL_RE, render: (m, ctx) => <SafeLink key={ctx.key++} href={m[0]} /> },
  {
    re: /<@(\d{1,12})>/,
    render: (m, ctx) => {
      const id = Number(m[1]);
      const name = ctx.nameOf?.(id);
      return (
        <span key={ctx.key++} className={`mention ${id === ctx.meId ? "mention-me" : ""}`}>
          @{name ?? "someone"}
        </span>
      );
    },
  },
  {
    re: /(?<![\w@])@everyone\b/,
    render: (_m, ctx) => (
      <span key={ctx.key++} className="mention everyone">
        @everyone
      </span>
    ),
  },
];

function parseInline(text: string, ctx: Ctx): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  while (rest) {
    // The rule that matches earliest wins (ties go to the one listed first).
    let best: { rule: Rule; m: RegExpExecArray } | null = null;
    for (const rule of RULES) {
      const m = rule.re.exec(rest);
      if (m && (!best || m.index < best.m.index)) best = { rule, m };
    }
    if (!best) {
      out.push(<RichText key={ctx.key++} text={rest} inline />);
      break;
    }
    if (best.m.index > 0) out.push(<RichText key={ctx.key++} text={rest.slice(0, best.m.index)} inline />);
    out.push(best.rule.render(best.m, ctx));
    rest = rest.slice(best.m.index + best.m[0].length);
  }
  return out;
}

function Spoiler({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(false);
  return (
    <span
      className={`spoiler ${shown ? "shown" : ""}`}
      role="button"
      tabIndex={shown ? -1 : 0}
      aria-label={shown ? undefined : "Spoiler: click to show"}
      onClick={(e) => {
        if (shown) return;
        e.preventDefault();
        e.stopPropagation();
        setShown(true);
      }}
      onKeyDown={(e) => {
        if (!shown && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          setShown(true);
        }
      }}
    >
      <span aria-hidden={!shown}>{children}</span>
    </span>
  );
}

function SafeLink({ href }: { href: string }) {
  let ok = false;
  try {
    const u = new URL(href);
    ok = u.protocol === "http:" || u.protocol === "https:";
  } catch {
    ok = false;
  }
  if (!ok) return <>{href}</>;
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="md-link">
      {href}
    </a>
  );
}

/** The http(s) links in a message, for preview cards (not ones inside code). */
export function linksIn(text: string): string[] {
  const noCode = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ").replace(/\|\|[\s\S]*?\|\|/g, " ");
  const out: string[] = [];
  const re = new RegExp(URL_RE.source, "g");
  for (const m of noCode.matchAll(re)) if (!out.includes(m[0])) out.push(m[0]);
  return out;
}

/** Plain text with formatting marks taken out, for short previews and notifications. */
export function plainText(text: string, nameOf?: (id: number) => string | undefined): string {
  return text
    .replace(/```[\w+-]*\n?([\s\S]*?)```/g, "$1")
    .replace(/\|\|[\s\S]*?\|\|/g, "▒▒▒")
    .replace(/<@(\d{1,12})>/g, (_w, id: string) => `@${nameOf?.(Number(id)) ?? "someone"}`)
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
