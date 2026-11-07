import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Conversation, Me } from "@dendrop/shared";
import { account, startServer, type TestServer } from "./helpers.js";

describe("name and text colors", () => {
  let s: TestServer;
  let ana: string, ben: string;

  before(async () => {
    s = await startServer({ DENDROP_SIGNUP: "true" });
    ana = await account(s, "ana");
    ben = await account(s, "ben");
    const anaId = s.ctx.users.byUsername("ana")!.id;
    await s.app.inject({ method: "POST", url: "/api/friends", headers: { cookie: ana }, payload: { username: "ben" } });
    await s.app.inject({ method: "POST", url: `/api/friends/${anaId}/accept`, headers: { cookie: ben } });
  });
  after(() => s.close());

  const patch = (cookie: string, payload: object) => s.app.inject({ method: "PATCH", url: "/api/me", headers: { cookie }, payload });

  it("starts with the theme's colors", async () => {
    const me = (await s.app.inject({ method: "GET", url: "/api/me", headers: { cookie: ana } })).json() as Me;
    assert.equal(me.nameColor, null);
    assert.equal(me.textColor, null);
  });

  it("saves #rrggbb colors and shows them to others", async () => {
    const res = await patch(ana, { nameColor: "#9B59FF", textColor: "#33ccff" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().nameColor, "#9b59ff", "kept lowercase");
    assert.equal(res.json().textColor, "#33ccff");

    const benId = s.ctx.users.byUsername("ben")!.id;
    const convo = (await s.app.inject({ method: "POST", url: "/api/conversations", headers: { cookie: ana }, payload: { userId: benId } })).json() as Conversation;
    const seen = (await s.app.inject({ method: "GET", url: `/api/conversations/${convo.id}`, headers: { cookie: ben } })).json() as Conversation;
    const anaThere = seen.members.find((m) => m.username === "ana")!;
    assert.equal(anaThere.nameColor, "#9b59ff");
    assert.equal(anaThere.textColor, "#33ccff");
  });

  it("leaves a color alone when the patch doesn't mention it, and null clears it", async () => {
    assert.equal((await patch(ana, { displayName: "Ana" })).json().nameColor, "#9b59ff");
    const cleared = (await patch(ana, { textColor: null })).json() as Me;
    assert.equal(cleared.textColor, null);
    assert.equal(cleared.nameColor, "#9b59ff");
  });

  it("refuses anything that isn't a #rrggbb color", async () => {
    for (const bad of ["red", "#fff", "#12345g", "url(x)", "#1234567", 7]) {
      assert.equal((await patch(ana, { nameColor: bad })).statusCode, 400, String(bad));
      assert.equal((await patch(ana, { textColor: bad })).statusCode, 400, String(bad));
    }
  });
});
