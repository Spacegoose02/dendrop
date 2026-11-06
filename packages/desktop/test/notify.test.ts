import assert from "node:assert/strict";
import { test } from "node:test";
import type { Conversation, Message, ServerEvent } from "@dendrop/shared";
import { GatewayWatcher, notificationFor, Throttle, type SocketLike } from "../src/notify.js";

const msg = (over: Partial<Message> = {}): Message => ({ id: 1, conversationId: 7, authorId: 2, body: "meet at 6, love you", createdAt: "", editedAt: null, deleted: false, attachments: [], ...over });
const dm: Conversation = { id: 7, isGroup: false, name: null, members: [{ id: 1, username: "me", displayName: "Me" }, { id: 2, username: "sam", displayName: "Sam" }], lastMessageAt: null, createdAt: "", reads: [] };
const opts = (notifySender = false) => ({ meId: 1, notifySender, conversation: (id: number) => (id === 7 ? dm : undefined) });

test("message notifications never include the message text", () => {
  for (const sender of [false, true]) {
    const n = notificationFor({ type: "message.created", message: msg() }, opts(sender));
    assert.ok(n);
    assert.ok(!JSON.stringify(n).includes("meet at 6"));
  }
});

test("sender is named only when asked", () => {
  assert.equal(notificationFor({ type: "message.created", message: msg() }, opts())?.body, "New message");
  assert.equal(notificationFor({ type: "message.created", message: msg() }, opts(true))?.body, "New message from Sam");
  // Unknown conversation: falls back to the plain text.
  assert.equal(notificationFor({ type: "message.created", message: msg({ conversationId: 9 }) }, opts(true))?.body, "New message");
});

test("group names show with the sender", () => {
  const group: Conversation = { ...dm, id: 8, isGroup: true, name: "Den family" };
  const n = notificationFor({ type: "message.created", message: msg({ conversationId: 8 }) }, { meId: 1, notifySender: true, conversation: () => group });
  assert.equal(n?.body, "New message from Sam in Den family");
});

test("own messages, deletions, edits and typing don't notify", () => {
  const events: ServerEvent[] = [
    { type: "message.created", message: msg({ authorId: 1 }) },
    { type: "message.created", message: msg({ deleted: true }) },
    { type: "message.updated", message: msg() },
    { type: "typing", conversationId: 7, userId: 2 },
    { type: "presence", userId: 2, online: true },
  ];
  for (const e of events) assert.equal(notificationFor(e, opts(true)), null, e.type);
});

test("incoming friend requests notify", () => {
  const e: ServerEvent = { type: "friend.updated", friend: { user: dm.members[1]!, state: "incoming", since: "" } };
  assert.equal(notificationFor(e, opts())?.body, "New friend request");
  assert.equal(notificationFor(e, opts(true))?.body, "Sam sent you a friend request");
  assert.equal(notificationFor({ ...e, friend: { ...e.friend, state: "friends" } }, opts()), null);
});

test("throttle collapses a burst per conversation", () => {
  const t = new Throttle(1000);
  assert.equal(t.allow("7", 0), true);
  assert.equal(t.allow("7", 500), false);
  assert.equal(t.allow("8", 500), true);
  assert.equal(t.allow("7", 1600), true);
});

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  handlers: Record<string, ((...a: never[]) => void)[]> = {};
  constructor(readonly url: string, readonly headers: Record<string, string>) {}
  on(event: string, fn: (...a: never[]) => void) {
    (this.handlers[event] ??= []).push(fn);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    for (const fn of this.handlers[event] ?? []) (fn as (...a: unknown[]) => void)(...args);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
}

function harness(cookie = "dd_session=abc") {
  const sockets: FakeSocket[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const events: Array<[ServerEvent, number]> = [];
  const watcher = new GatewayWatcher({
    origin: () => "https://chat.example.com",
    cookies: async () => cookie,
    open: (url, headers) => {
      const s = new FakeSocket(url, headers);
      sockets.push(s);
      return s;
    },
    onEvent: (e, me) => events.push([e, me]),
    setTimer: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      const i = timers.indexOf(t as (typeof timers)[number]);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  return { watcher, sockets, timers, events };
}

const tick = () => new Promise((r) => setImmediate(r));

test("watcher connects with the window's cookie and passes events after ready", async () => {
  const h = harness();
  h.watcher.start();
  await tick();
  const s = h.sockets[0]!;
  assert.equal(s.url, "wss://chat.example.com/api/gateway");
  assert.equal(s.headers.Cookie, "dd_session=abc");
  s.readyState = 1;
  s.emit("open");
  s.emit("message", JSON.stringify({ type: "message.created", message: msg() }));
  assert.equal(h.events.length, 0, "nothing before ready");
  s.emit("message", JSON.stringify({ type: "ready", user: { id: 1 } }));
  s.emit("message", JSON.stringify({ type: "message.created", message: msg() }));
  s.emit("message", "not json");
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0]![1], 1);
  assert.equal(h.watcher.connected, true);
  h.watcher.stop();
});

test("watcher backs off on drops and waits long when signed out", async () => {
  const h = harness();
  h.watcher.start();
  await tick();
  h.sockets[0]!.emit("close", 1006);
  assert.equal(h.timers.at(-1)!.ms, 1000);
  h.timers.pop()!.fn();
  await tick();
  h.sockets[1]!.emit("close", 1006);
  assert.equal(h.timers.at(-1)!.ms, 2000);
  h.timers.pop()!.fn();
  await tick();
  h.sockets[2]!.emit("close", 4401);
  assert.equal(h.timers.at(-1)!.ms, 5 * 60_000);
  // Signing in pokes it: straight back on.
  h.watcher.poke();
  await tick();
  assert.equal(h.sockets.length, 4);
  h.watcher.stop();
});

test("watcher doesn't connect without a sign-in cookie", async () => {
  const h = harness("");
  h.watcher.start();
  await tick();
  assert.equal(h.sockets.length, 0);
  assert.equal(h.timers.at(-1)!.ms, 5 * 60_000);
  h.watcher.stop();
  assert.equal(h.timers.length, 0);
});
