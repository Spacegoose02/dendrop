import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

/**
 * Fetching pages people link to, for link previews. Anyone can post any link, so this must not
 * become a way to reach the server's own network (SSRF): the router, Unraid's web UI, other
 * containers, cloud metadata. So it:
 *  - only does http and https on ports 80 and 443,
 *  - resolves the name itself and refuses if any address is private, loopback, link-local,
 *    multicast or otherwise not on the public internet (IPv4-in-IPv6 forms included),
 *  - connects to the address it checked (no second lookup, so DNS rebinding can't swap it),
 *  - follows at most a few redirects, checking each one the same way,
 *  - sends no cookies or credentials, gives up after a few seconds and reads a capped amount.
 */

export interface SafeResponse {
  status: number;
  contentType: string;
  body: Buffer;
  /** Where it ended up after redirects. */
  url: string;
}

export interface SafeFetchOptions {
  maxBytes: number;
  accept: string;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Tests only: allow private addresses (a local test server). */
  allowPrivate?: boolean;
}

export class BlockedError extends Error {}

const USER_AGENT = "Mozilla/5.0 (compatible; DendropLinkPreview/1.0; +https://github.com/Spacegoose02/dendrop)";

/** Whether an IP address is on the public internet. Anything unparseable counts as not. */
export function isPublicAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return isPublicV4(address);
  if (kind === 6) return isPublicV6(address);
  return false;
}

function v4Parts(a: string): number[] {
  return a.split(".").map(Number);
}

function isPublicV4(a: string): boolean {
  const [x, y, z] = v4Parts(a) as [number, number, number, number];
  if (x === 0 || x === 10 || x === 127) return false; // "this network", private, loopback
  if (x === 100 && y >= 64 && y <= 127) return false; // carrier-grade NAT
  if (x === 169 && y === 254) return false; // link-local, cloud metadata
  if (x === 172 && y >= 16 && y <= 31) return false; // private
  if (x === 192 && y === 168) return false; // private
  if (x === 192 && y === 0 && (z === 0 || z === 2)) return false; // IETF, TEST-NET-1
  if (x === 192 && y === 88 && z === 99) return false; // 6to4 relay
  if (x === 198 && (y === 18 || y === 19)) return false; // benchmarking
  if (x === 198 && y === 51 && z === 100) return false; // TEST-NET-2
  if (x === 203 && y === 0 && z === 113) return false; // TEST-NET-3
  if (x >= 224) return false; // multicast, reserved, broadcast
  return true;
}

/** The eight 16-bit groups of an IPv6 address (with a trailing IPv4 part folded in). */
function v6Groups(a: string): number[] {
  let s = a.toLowerCase().split("%")[0]!;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const [p, q, r, t] = v4Parts(v4[1]!) as [number, number, number, number];
    s = s.slice(0, -v4[1]!.length) + `${((p << 8) | q).toString(16)}:${((r << 8) | t).toString(16)}`;
  }
  const [head, tail] = s.includes("::") ? (s.split("::") as [string, string]) : [s, null];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const fill = tail === null ? [] : new Array(8 - h.length - t.length).fill("0");
  return [...h, ...fill, ...t].map((g) => parseInt(g || "0", 16));
}

function isPublicV6(a: string): boolean {
  const g = v6Groups(a);
  if (g.length !== 8 || g.some((n) => Number.isNaN(n))) return false;
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d): judge the IPv4 address inside.
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) return isPublicV4(v4(g[6]!, g[7]!));
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((n) => n === 0)) return isPublicV4(v4(g[6]!, g[7]!));
  // 6to4 carries an IPv4 address too.
  if (g[0] === 0x2002) return isPublicV4(v4(g[1]!, g[2]!));
  // Only global unicast (2000::/3) is public; that leaves out ::, ::1, fc00::/7, fe80::/10, ff00::/8...
  if ((g[0]! & 0xe000) !== 0x2000) return false;
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (g[0] === 0x2001 && g[1]! < 0x200) return false; // Teredo, benchmarking, ORCHID and other IETF space
  return true;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** A dns lookup for http.request that refuses names pointing anywhere private. */
function checkedLookup(allowPrivate: boolean) {
  return (hostname: string, options: { all?: boolean }, cb: LookupCallback) => {
    dnsLookup(hostname, { all: true }, (err, addresses) => {
      if (err) return cb(err, "");
      if (!addresses.length) return cb(new BlockedError(`No address for ${hostname}`), "");
      if (!allowPrivate && addresses.some((a) => !isPublicAddress(a.address))) return cb(new BlockedError(`${hostname} points at a private address`), "");
      if (options.all) return cb(null, addresses);
      cb(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}

/** Checks a URL before any connection: scheme, port, no credentials, and IP literals. */
export function checkUrl(raw: string, allowPrivate = false): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedError("Not a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BlockedError("Only http and https links");
  if (url.username || url.password) throw new BlockedError("Links with passwords aren't fetched");
  if (url.port && !(allowPrivate || url.port === "80" || url.port === "443")) throw new BlockedError("Only the usual web ports");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !allowPrivate && !isPublicAddress(host)) throw new BlockedError("That address is private");
  if (!allowPrivate && !isIP(host) && (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || !host.includes("."))) {
    throw new BlockedError("That name is private");
  }
  return url;
}

function once(url: URL, o: SafeFetchOptions): Promise<{ status: number; location: string | null; contentType: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      url,
      {
        method: "GET",
        headers: { "user-agent": USER_AGENT, accept: o.accept, "accept-encoding": "identity", "accept-language": "en" },
        lookup: checkedLookup(!!o.allowPrivate) as unknown as typeof dnsLookup,
        // Never a proxy or a keep-alive pool shared with anything else.
        agent: false,
        timeout: o.timeoutMs ?? 5000,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const contentType = String(res.headers["content-type"] ?? "").toLowerCase();
        if (status >= 300 && status < 400) {
          res.resume();
          resolve({ status, location: res.headers.location ?? null, contentType, body: Buffer.alloc(0) });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve({ status, location: null, contentType, body: Buffer.concat(chunks) });
        };
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > o.maxBytes) {
            // Keep what fits (enough for a page's <head>) and stop downloading.
            chunks.push(c.subarray(0, c.length - (size - o.maxBytes)));
            finish();
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on("end", finish);
        res.on("error", (e) => (done ? undefined : reject(e)));
      },
    );
    const deadline = setTimeout(() => req.destroy(new Error("Timed out")), (o.timeoutMs ?? 5000) * 2);
    req.on("close", () => clearTimeout(deadline));
    req.on("timeout", () => req.destroy(new Error("Timed out")));
    req.on("error", reject);
    req.end();
  });
}

/** GETs a URL under the rules above. Throws BlockedError for anything refused. */
export async function safeFetch(raw: string, o: SafeFetchOptions): Promise<SafeResponse> {
  let url = checkUrl(raw, o.allowPrivate);
  for (let hop = 0; ; hop++) {
    const r = await once(url, o);
    if (r.status >= 300 && r.status < 400 && r.location) {
      if (hop >= (o.maxRedirects ?? 4)) throw new BlockedError("Too many redirects");
      url = checkUrl(new URL(r.location, url).toString(), o.allowPrivate);
      continue;
    }
    return { status: r.status, contentType: r.contentType, body: r.body, url: url.toString() };
  }
}
