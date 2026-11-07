import { describe, expect, it } from "vitest";
import { reportFailure, type ReplyTarget } from "../src/interaction-reply.js";

/** Mimics discord.js: reply() on a deferred or replied interaction throws InteractionAlreadyReplied. */
function fake(state: { deferred: boolean; replied: boolean }) {
  const calls: string[] = [];
  const i: ReplyTarget = {
    ...state,
    async reply(o) {
      if (state.deferred || state.replied) throw new Error("InteractionAlreadyReplied");
      calls.push(`reply:${o.content}:${o.flags ?? ""}`);
    },
    async editReply(o) {
      if (!state.deferred && !state.replied) throw new Error("InteractionNotReplied");
      calls.push(`edit:${o.content}`);
    },
  };
  return { i, calls };
}

describe("command failure reporting", () => {
  it("uses editReply for a deferred interaction (start/reconnect connect failure)", async () => {
    const f = fake({ deferred: true, replied: false });
    expect(await reportFailure(f.i, "failed: timeout", 64)).toBe("edited");
    expect(f.calls).toEqual(["edit:failed: timeout"]);
  });

  it("uses an ephemeral reply for a fresh interaction and skips one already replied", async () => {
    const f = fake({ deferred: false, replied: false });
    expect(await reportFailure(f.i, "failed: x", 64)).toBe("replied");
    expect(f.calls).toEqual(["reply:failed: x:64"]);
    const g = fake({ deferred: false, replied: true });
    expect(await reportFailure(g.i, "failed: y", 64)).toBe("skipped");
    expect(g.calls).toEqual([]);
  });

  it("never rejects, even if Discord refuses the response", async () => {
    const i: ReplyTarget = {
      deferred: true,
      replied: false,
      reply: async () => {},
      editReply: async () => {
        throw new Error("Unknown interaction");
      },
    };
    const res = await reportFailure(i, "failed");
    expect(res).toBeInstanceOf(Error);
  });
});
