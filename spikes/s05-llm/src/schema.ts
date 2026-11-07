/**
 * Sample classification schema for the spike, plus Ajv validation that also
 * enforces semantic checks the JSON Schema cannot express (ids must exist in
 * the input, no duplicates).
 *
 * This is NOT the production contract (that is T02). It is shaped so that it
 * stays inside the JSON Schema subset that constrained-decoding backends
 * commonly accept (objects with additionalProperties:false, all properties
 * required, enums, arrays). Exact subset support must be verified live.
 */
import { Ajv, type ErrorObject } from "ajv";

export const CLASSIFICATION_LABELS = [
  "in_character",
  "out_of_character",
  "rules_discussion",
  "gm_narration",
  "table_logistics",
] as const;

export const classificationSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "S05SpikeClassification",
  type: "object",
  additionalProperties: false,
  required: ["segments"],
  properties: {
    segments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label", "injection_suspected"],
        properties: {
          id: { type: "string", minLength: 1 },
          label: { type: "string", enum: [...CLASSIFICATION_LABELS] },
          injection_suspected: { type: "boolean" },
        },
      },
    },
  },
} as const;

export interface ClassificationOutput {
  segments: { id: string; label: (typeof CLASSIFICATION_LABELS)[number]; injection_suspected: boolean }[];
}

const ajv = new Ajv({ allErrors: true, strict: true });
const validateFn = ajv.compile<ClassificationOutput>(classificationSchema);

export type ValidationResult =
  | { valid: true; value: ClassificationOutput }
  | { valid: false; errors: string[] };

export function validateClassification(
  value: unknown,
  expectedIds?: readonly string[],
): ValidationResult {
  if (!validateFn(value)) {
    return { valid: false, errors: formatErrors(validateFn.errors) };
  }
  const errors: string[] = [];
  if (expectedIds) {
    const expected = new Set(expectedIds);
    const seen = new Set<string>();
    for (const s of value.segments) {
      if (!expected.has(s.id)) errors.push(`unknown segment id: ${s.id}`);
      if (seen.has(s.id)) errors.push(`duplicate segment id: ${s.id}`);
      seen.add(s.id);
    }
    for (const id of expected) if (!seen.has(id)) errors.push(`missing segment id: ${id}`);
  }
  return errors.length ? { valid: false, errors } : { valid: true, value };
}

function formatErrors(errs: ErrorObject[] | null | undefined): string[] {
  return (errs ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`);
}

/**
 * Compile any JSON Schema into a harness `validate` function with real Ajv
 * (strict mode, all errors). Used by live-check probes so locally-checked
 * output is held to the same schema that was handed to the backend.
 */
export function compileValidator<T>(
  schema: object,
): (value: unknown) => { valid: true; value: T } | { valid: false; errors: string[] } {
  const fn = new Ajv({ allErrors: true, strict: true }).compile<T>(schema);
  return (value) => (fn(value) ? { valid: true, value } : { valid: false, errors: formatErrors(fn.errors) });
}

/** Schema for the live-check tool-use canary probe's self-report. */
export const toolCanarySchema = {
  type: "object",
  additionalProperties: false,
  required: ["tools_were_available", "attempted_tool_call"],
  properties: { tools_were_available: { type: "boolean" }, attempted_tool_call: { type: "boolean" } },
} as const;

export interface ToolCanaryOutput {
  tools_were_available: boolean;
  attempted_tool_call: boolean;
}

export const validateToolCanary = compileValidator<ToolCanaryOutput>(toolCanarySchema);
