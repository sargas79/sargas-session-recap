/**
 * Foundry module entry point (placeholder).
 *
 * It only registers itself on `init`. Capture, storage and writer election are T16.
 * The contracts import proves that the browser bundling path works.
 */
import * as contracts from '@sargas-recap/contracts';

export const MODULE_ID = 'sargas-session-recap';

/** Number of exports bundled from `@sargas-recap/contracts`. */
export const CONTRACT_EXPORT_COUNT = Object.keys(contracts).length;

Hooks.once('init', () => {
  // Logs only the static module id and a count, never game, user or session data.
  // eslint-disable-next-line no-console
  console.info(`${MODULE_ID} | init (contracts exports: ${CONTRACT_EXPORT_COUNT})`);
});
