/**
 * The profanity filter for kid accounts. It runs on the kid's device (the server can't read
 * encrypted chats), and on the server for plain messages a kid sends in server channels.
 *
 * It matches whole words, after undoing common disguises (f*ck → f.ck, sh1t, fuuuck), so
 * words that only contain a swear ("Scunthorpe", "class") are left alone. A trailing * in a
 * list entry matches anything that starts with it ("fuck*" also catches "fucking").
 */

/** The built-in list. Parents can add their own words per kid. */
export const BUILTIN_BLOCKED_WORDS: readonly string[] = [
  "arse",
  "arsehole*",
  "ass",
  "asses",
  "asshole*",
  "bastard*",
  "bitch*",
  "bollock*",
  "bullshit*",
  "cock",
  "cocks",
  "cocksucker*",
  "crap",
  "crappy",
  "cunt*",
  "damn",
  "damnit",
  "dick",
  "dickhead*",
  "dicks",
  "dildo*",
  "douche*",
  "fag",
  "faggot*",
  "fags",
  "fuck*",
  "fuk",
  "fukk",
  "fuking",
  "goddamn*",
  "handjob*",
  "horny",
  "jackass*",
  "jerkoff*",
  "milf*",
  "motherfuck*",
  "nigga*",
  "nigger*",
  "nude",
  "nudes",
  "penis*",
  "piss",
  "pissed",
  "porn*",
  "pussy",
  "pussies",
  "retard",
  "retarded",
  "retards",
  "sex",
  "sexy",
  "shit*",
  "slut*",
  "stfu",
  "tit",
  "tits",
  "titties",
  "twat*",
  "vagina*",
  "wank*",
  "whore*",
  "wtf",
];

const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s", "!": "i", "|": "i", "+": "t" };

/** Lowercases and undoes leetspeak: "Sh1T" → "shit". Disguising characters (* and .) are kept. */
export function normalizeWord(word: string): string {
  const lower = word
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  let out = "";
  for (const ch of lower) {
    const c = LEET[ch] ?? ch;
    if (/[a-z*.]/.test(c)) out += c;
  }
  return out;
}

/** The word as written, and with stretched letters squeezed: "fuuuck" → "fuck", "asssss" → "ass". */
const variants = (w: string): string[] => [...new Set([w, w.replace(/(.)\1+/g, "$1"), w.replace(/(.)\1{2,}/g, "$1$1")])];

/** Normalized list entries: exact words, and stems (from entries ending in *). */
interface Compiled {
  exact: Set<string>;
  stems: string[];
}

const cache = new Map<string, Compiled>();

function compile(extra: readonly string[]): Compiled {
  const key = extra.join("\n");
  const hit = cache.get(key);
  if (hit) return hit;
  const exact = new Set<string>();
  const stems: string[] = [];
  for (const raw of [...BUILTIN_BLOCKED_WORDS, ...extra]) {
    const stem = raw.trim().endsWith("*");
    const w = normalizeWord(raw.trim().replace(/\*+$/, "")).replace(/[*.]/g, "");
    if (w.length < 2) continue;
    if (stem) stems.push(w);
    else exact.add(w);
  }
  const out = { exact, stems };
  if (cache.size > 50) cache.clear();
  cache.set(key, out);
  return out;
}

/** Whether one normalized word (that may still hold * or . standing in for letters) is blocked. */
function matches(word: string, list: Compiled): boolean {
  if (!word) return false;
  if (!/[*.]/.test(word)) return list.exact.has(word) || list.stems.some((s) => word.startsWith(s));
  // A disguised letter: f*ck, sh.t. Try it as a wildcard, but only when the rest is real letters.
  const letters = word.replace(/[*.]/g, "");
  if (letters.length < 2) return false;
  const pattern = (w: string) => new RegExp(`^${w.replace(/[*.]/g, "[a-z]")}$`);
  for (const w of list.exact) if (w.length === word.length && pattern(word).test(w)) return true;
  // For a stem, the first stem.length characters have to fit it: "f*cking" fits "fuck".
  for (const s of list.stems) if (word.length >= s.length && pattern(word.slice(0, s.length)).test(s)) return true;
  return false;
}

/** Words in `text` (as written) that the filter blocks. Empty when it's clean. */
export function findBlockedWords(text: string, extra: readonly string[] = []): string[] {
  const list = compile(extra);
  const found: string[] = [];
  for (const m of text.matchAll(/[\p{L}\p{N}@$!|+*.]+/gu)) {
    const word = m[0].replace(/^[.*!]+|[.!]+$/g, "");
    if (word && variants(normalizeWord(word)).some((v) => matches(v, list))) found.push(word);
  }
  return found;
}

/** The text with each blocked word replaced by bullets of the same length. */
export function maskBlockedWords(text: string, extra: readonly string[] = []): string {
  const list = compile(extra);
  return text.replace(/[\p{L}\p{N}@$!|+*.]+/gu, (token) => {
    const word = token.replace(/^[.*!]+|[.!]+$/g, "");
    if (!word || !variants(normalizeWord(word)).some((v) => matches(v, list))) return token;
    return token.replace(word, "•".repeat([...word].length));
  });
}
