/**
 * Turns what someone typed into a server address: "tower:8080" becomes "http://tower:8080",
 * "chat.example.com" becomes "https://chat.example.com". Paths, queries and trailing slashes
 * are dropped, because the app always loads the server's root. Throws a readable error.
 */
export function normalizeServerUrl(input: string): string {
  let text = input.trim();
  if (!text) throw new Error("Enter your Dendrop server's address");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    // A bare host: plain http for a LAN name, IP or explicit port, https for a public domain.
    const host = text.split(/[/?#]/)[0]!;
    const local = /:\d+$/.test(host) || !host.includes(".") || /^\d+\.\d+\.\d+\.\d+(:\d+)?$/.test(host) || /\.(local|lan|home|internal)(:\d+)?$/i.test(host);
    text = `${local ? "http" : "https"}://${text}`;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("That doesn't look like a web address");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("The address must start with http:// or https://");
  if (url.username || url.password) throw new Error("Leave the user name and password out of the address");
  return url.origin;
}

/** The origin of a saved server address, or "" when there isn't a usable one. */
export function originOf(serverUrl: string): string {
  try {
    const u = new URL(serverUrl);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : "";
  } catch {
    return "";
  }
}
