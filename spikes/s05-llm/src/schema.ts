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
