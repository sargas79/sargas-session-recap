/**
 * Minimal ambient types for the Foundry VTT globals this placeholder uses.
 *
 * Deliberately tiny: T16 decides whether to adopt a real Foundry type package
 * or keep hand-written declarations.
 */
interface FoundryHooks {
  once(hook: 'init', fn: () => void): number;
}

declare const Hooks: FoundryHooks;
