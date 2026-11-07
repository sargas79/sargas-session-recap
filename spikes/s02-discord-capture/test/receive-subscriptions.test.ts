import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { ReceiveSubscriptions, type ReceiveStreamLike } from "../src/receive-subscriptions.js";

/** Mimics @discordjs/voice 0.19.2 VoiceReceiver.subscribe: returns the existing stream until it closes. */
class FakeStream extends EventEmitter implements ReceiveStreamLike {
  destroyed = false;
  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit("close");
    }
    return this;
  }
}
class FakeReceiver {
  readonly subscriptions = new Map<string, FakeStream>();
  subscribe(userId: string): FakeStream {
    const existing = this.subscriptions.get(userId);
    if (existing) return existing;
    const s = new FakeStream();
    s.once("close", () => this.subscriptions.delete(userId));
    this.subscriptions.set(userId, s);
    return s;
  }
}

function recorder() {
  const data: string[] = [];
  let ends = 0;
  return {
    data,
    ends: () => ends,
    h: (tag: string) => ({ onData: (b: Buffer) => data.push(`${tag}:${b.toString()}`), onEnd: () => ends++, onError: () => {} }),
  };
}

describe("receive subscriptions across a short disconnect (voice 0.19.2 subscribe semantics)", () => {
  it("destroys the old stream at the discontinuity so resubscribing never double-delivers packets", () => {
    const rx = new FakeReceiver();
    const subs = new ReceiveSubscriptions();
    const r = recorder();
    const a = rx.subscribe("u1");
    subs.add("u1", a, r.h("a"));
    a.emit("data", Buffer.from("1"));
    subs.dropAll(); // connection left Ready
    expect(a.destroyed).toBe(true);
    expect(rx.subscriptions.has("u1")).toBe(false);
    const b = rx.subscribe("u1"); // next speaking start
    expect(b).not.toBe(a);
    subs.add("u1", b, r.h("b"));
    b.emit("data", Buffer.from("2"));
    a.emit("data", Buffer.from("stale")); // late packet on the old stream
    expect(r.data).toEqual(["a:1", "b:2"]);
    expect(r.ends()).toBe(0); // dropAll does not report a silence end
  });

  it("never attaches a second listener when the receiver hands back the same live stream", () => {
    const rx = new FakeReceiver();
    const subs = new ReceiveSubscriptions();
    const r = recorder();
    const a = rx.subscribe("u1");
    subs.add("u1", a, r.h("a"));
    subs.add("u1", rx.subscribe("u1"), r.h("again"));
    a.emit("data", Buffer.from("x"));
    expect(r.data).toEqual(["a:x"]);
    expect(a.listenerCount("data")).toBe(1);
  });

  it("a late end/close from a replaced stream does not end the current subscription", () => {
    const subs = new ReceiveSubscriptions();
    const r = recorder();
    const a = new FakeStream();
    const b = new FakeStream();
    subs.add("u1", a, r.h("a"));
    subs.add("u1", b, r.h("b")); // replaces (and destroys) a
    a.emit("end");
    expect(subs.has("u1")).toBe(true);
    expect(r.ends()).toBe(0);
    b.emit("end");
    b.emit("close");
    expect(subs.has("u1")).toBe(false);
    expect(r.ends()).toBe(1);
  });
});
