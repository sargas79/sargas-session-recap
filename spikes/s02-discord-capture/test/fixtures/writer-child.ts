/**
 * Child process for the offline forced-kill test: a CaptureSession on the REAL monotonic clock, fed a
 * synthetic packet every 20 ms by one opted-in speaker until the parent kills it. No network.
 */
import { systemClock } from "../../src/clock.js";
import { Allowlist } from "../../src/config.js";
import { CaptureSession } from "../../src/session.js";
import { PARAMS, P1, fakeDecoder, pkt } from "../helpers.js";

const root = process.argv[2]!;
const s = new CaptureSession({
  outputRoot: root,
  sessionId: "s02-killtest",
  clock: systemClock,
  allowlist: new Allowlist([{ user_id: P1, label: "p1" }]),
  params: { ...PARAMS, max_fragment_ms: 1000 },
  decoderFactory: fakeDecoder,
});
let n = 0;
setInterval(() => {
  s.onPacket(P1, pkt(1000 + (n % 100)), process.hrtime.bigint());
  n++;
  if (n === 75) process.stdout.write("READY\n");
}, 20);
