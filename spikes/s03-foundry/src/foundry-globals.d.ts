// Minimal ambient declarations for the Foundry runtime. Deliberately `any`: this throwaway spike does not pin a
// community type package, and every API used is a candidate to verify on v14 (see docs/spikes/S03-foundry.md).
declare const foundry: any;
declare const game: any;
declare const Hooks: any;
declare const ui: any;
declare const CONST: any;
declare function getDocumentClass(name: string): any;
