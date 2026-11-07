/**
 * Offline tools (THROWAWAY), no network:
 *   npm run recover -- <output_root> [--kill-hr-ns <ns>]   run startup recovery, print report
 *   npm run analyze -- <session_dir>                       beep-onset timing per speaker per mark
 */
import { analyzeSession } from "./analyze.js";
import { recoverAll } from "./recovery.js";

const [cmd, target, ...rest] = process.argv.slice(2);
if (!cmd || !target) {
  console.error("usage: cli.ts recover <output_root> [--kill-hr-ns N] | analyze <session_dir>");
  process.exit(2);
}
if (cmd === "recover") {
  const k = rest.indexOf("--kill-hr-ns");
  const killHrNs = k >= 0 && rest[k + 1] ? BigInt(rest[k + 1]!) : undefined;
  console.log(JSON.stringify(recoverAll(target, killHrNs === undefined ? {} : { killHrNs }), null, 2));
} else if (cmd === "analyze") {
  console.log(JSON.stringify(analyzeSession(target), null, 2));
} else {
  console.error(`unknown command ${cmd}`);
  process.exit(2);
}
