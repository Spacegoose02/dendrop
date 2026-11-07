import { spawn, type ChildProcess } from "node:child_process";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import type { IncomingMessage } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import type { BuiltinLivekit, ServerConfig } from "./config.js";

const isRtc = (url = ""): boolean => url === "/rtc" || url.startsWith("/rtc/") || url.startsWith("/rtc?");

/** The LiveKit address a client should use: the separate server's, or Dendrop's own for the built-in one. */
export function livekitUrl(config: ServerConfig, req: FastifyRequest): string {
  if (config.livekit.url) return config.livekit.url;
  // trustProxy is on, so behind a reverse proxy this is the address people actually use.
  const base = config.publicUrl || `${req.protocol}://${req.host}`;
  return base.replace(/^http/, "ws");
}

/** A token to join one LiveKit room, as this person, with audio, video and screen share. */
export async function livekitToken(config: ServerConfig, room: string, user: { id: number; displayName: string }): Promise<string> {
  const t = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
    identity: String(user.id),
    name: user.displayName,
    ttl: "4h",
  });
  t.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: false });
  return t.toJwt();
}

/** Where Dendrop reaches LiveKit's server API: the built-in copy locally, or the separate server. */
function livekitApiUrl(config: ServerConfig): string {
  const b = config.livekit.builtin;
  if (b) return `http://127.0.0.1:${b.signalPort}`;
  return config.livekit.url.replace(/^ws/, "http");
}

/**
 * Drops someone from a room, so a token they still hold stops being useful once they've lost
 * access. Best effort: the room may already be gone, or the call server down.
 */
export async function removeFromRoom(config: ServerConfig, room: string, identity: string): Promise<void> {
  if (!config.livekit.apiKey || (!config.livekit.url && !config.livekit.builtin)) return;
  try {
    await new RoomServiceClient(livekitApiUrl(config), config.livekit.apiKey, config.livekit.apiSecret, { requestTimeout: 5, failover: false }).removeParticipant(
      room,
      identity,
    );
  } catch {
    // Not in the room, or the call server isn't reachable.
  }
}

/** LiveKit's config for the built-in server. The signal port only listens on 127.0.0.1. */
export function livekitYaml(b: BuiltinLivekit, logLevel: string): string {
  return [
    `port: ${b.signalPort}`,
    "bind_addresses:",
    '  - "127.0.0.1"',
    "rtc:",
    `  tcp_port: ${b.tcpPort}`,
    // One UDP port for every call, so only one port needs forwarding.
    `  udp_port: ${b.udpPort}`,
    b.nodeIp ? `  node_ip: "${b.nodeIp}"` : "  use_external_ip: true",
    "logging:",
    `  level: ${logLevel === "debug" ? "debug" : logLevel === "info" ? "info" : "warn"}`,
    "",
  ].join("\n");
}

/**
 * Runs the LiveKit server built into the image beside Dendrop, restarts it if it stops, and
 * passes LiveKit's signalling (`/rtc...`, HTTP and WebSocket) through Dendrop's own port, so
 * the reverse proxy needs no second site. Media goes straight to the TCP and UDP ports.
 */
export function builtinLivekit(app: FastifyInstance, config: ServerConfig): void {
  const b = config.livekit.builtin;
  if (!b) return;
  const target = `127.0.0.1:${b.signalPort}`;

  let child: ChildProcess | undefined;
  let closing = false;
  let restarts = 0;
  const start = () => {
    const proc = spawn(b.bin, ["--config-body", livekitYaml(b, process.env.DENDROP_LOG_LEVEL ?? "info")], {
      env: { ...process.env, LIVEKIT_KEYS: `${config.livekit.apiKey}: ${config.livekit.apiSecret}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;
    const log = (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) if (line.trim()) app.log.info({ livekit: true }, line.trim());
    };
    proc.stdout?.on("data", log);
    proc.stderr?.on("data", log);
    const started = Date.now();
    proc.on("error", (err) => app.log.error(err, "Couldn't start the built-in LiveKit server"));
    proc.on("exit", (code, signal) => {
      if (closing) return;
      // Ran a while: start counting again. Keeps a broken setup from spinning.
      if (Date.now() - started > 60_000) restarts = 0;
      const wait = Math.min(60_000, 1000 * 2 ** restarts++);
      app.log.warn(`The built-in LiveKit server stopped (${signal ?? code}); starting it again in ${wait / 1000}s`);
      setTimeout(() => !closing && start(), wait).unref();
    });
  };
  app.addHook("onReady", async () => {
    app.log.info(`Calls use the built-in LiveKit server: media on ${b.tcpPort}/tcp and ${b.udpPort}/udp`);
    start();
  });
  app.addHook("onClose", async () => {
    closing = true;
    child?.kill("SIGTERM");
  });

  // LiveKit's client asks for /rtc/v1 (or /rtc on older servers) and /rtc/validate.
  const http = async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const res = await fetch(`http://${target}${req.url}`, { headers: { authorization: req.headers.authorization ?? "" } });
      return reply.code(res.status).type(res.headers.get("content-type") ?? "text/plain").send(await res.text());
    } catch {
      return reply.code(502).type("text/plain").send("The call server isn't running");
    }
  };
  // WebSockets are piped as raw TCP, before @fastify/websocket (and its 64 KB message cap for
  // the gateway) sees them. The wrapper is added once everything is registered.
  app.addHook("onReady", async () => {
    const server = app.server;
    const others = server.listeners("upgrade") as ((req: IncomingMessage, socket: Duplex, head: Buffer) => void)[];
    server.removeAllListeners("upgrade");
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (!isRtc(req.url)) {
        for (const fn of others) fn.call(server, req, socket, head);
        return;
      }
      const upstream = connect(b.signalPort, "127.0.0.1", () => {
        const lines = [`${req.method} ${req.url} HTTP/1.1`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        upstream.write(lines.join("\r\n") + "\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on("error", () => socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n"));
      socket.on("error", () => upstream.destroy());
      socket.on("close", () => upstream.destroy());
      upstream.on("close", () => socket.destroy());
    });
  });
  for (const url of ["/rtc", "/rtc/*"]) app.get(url, http);
}
