/**
 * S02 harness entry point (THROWAWAY). Usage: npm start -- [path/to/s02.config.json]
 * Token: environment variable S02_DISCORD_TOKEN only. Runs startup recovery before connecting.
 */
import { loadConfig, readToken } from "./config.js";
import { recoverAll } from "./recovery.js";
import { SpikeBot, log } from "./bot.js";

const cfgPath = process.argv[2] ?? "s02.config.json";
const cfg = loadConfig(cfgPath);

for (const r of recoverAll(cfg.output_root)) {
  if (r.actions.length || r.abnormal_end) {
    log("startup recovery", {
      session_dir: r.session_dir,
      abnormal_end: r.abnormal_end,
      manifest_truncated_tail: r.manifest_truncated_tail,
      interrupted: r.interrupted.length,
    });
  }
}

const token = readToken();
const bot = new SpikeBot(cfg);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log(`received ${sig}, stopping`);
    bot.shutdown(sig.toLowerCase());
    void bot.client.destroy().finally(() => process.exit(0));
  });
}
await bot.client.login(token);
