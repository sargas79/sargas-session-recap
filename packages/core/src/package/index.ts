/**
 * Package: session package validation, safe artifact paths, hashing, atomic finalization, sealing
 * and purge (T03, ADR-006).
 */
export const MODULE_NAME = 'package';

export * from './atomic.ts';
export * from './hash.ts';
export * from './issues.ts';
export * from './lifecycle.ts';
export * from './safe-path.ts';
export * from './validate.ts';
export { registerPackageCommands, type PackageCliDeps, type PackageCliIo } from './cli.ts';
