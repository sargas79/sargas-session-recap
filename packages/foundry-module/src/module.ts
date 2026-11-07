/**
 * Foundry module entry point (placeholder).
 *
 * It only registers itself on `init`. Capture, storage and writer election are T16.
 * The contracts import proves that the browser bundling path works. Use named imports only, so
 * esbuild can drop the parts of contracts (e.g. the Ajv validators) that are not used.
 */
import { SCHEMA_VERSION_1 } from '@sargas-recap/contracts';

export const MODULE_ID = 'sargas-session-recap';

/** Contract schema version this build was compiled against. */
export const CONTRACT_SCHEMA_VERSION: number = SCHEMA_VERSION_1;

Hooks.once('init', () => {
  // Logs only the static module id and a count, never game, user or session data.
  // eslint-disable-next-line no-console
  console.info(`${MODULE_ID} | init (contracts schema v${String(CONTRACT_SCHEMA_VERSION)})`);
});
