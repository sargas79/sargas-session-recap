/**
 * The schema shown to the provider. Structured output accepts only a subset of JSON Schema (no string
 * or numeric bounds, no `if`/`then`), and the top level must be an object. So the provider gets the
 * contract's shape, and the full contract is enforced locally with Ajv on every response.
 */
import { toJsonSchema, type ContractName } from '@sargas-recap/contracts';

const KEPT_KEYWORDS = new Set([
  'type',
  'enum',
  'const',
  'format',
  'description',
  'required',
  'additionalProperties',
]);

type Json = Record<string, unknown>;

function reduce(schema: unknown): unknown {
  if (typeof schema !== 'object' || schema === null) return schema;
  const source = schema as Json;
  const out: Json = {};
  for (const [key, value] of Object.entries(source)) {
    if (KEPT_KEYWORDS.has(key)) {
      out[key] = value;
    } else if (key === 'items') {
      out[key] = reduce(value);
    } else if (key === 'anyOf' && Array.isArray(value)) {
      out[key] = value.map(reduce);
    } else if (key === 'properties') {
      out[key] = Object.fromEntries(
        Object.entries(value as Json).map(([name, property]) => [name, reduce(property)]),
      );
    }
  }
  return out;
}

export function modelSchema(contract: ContractName): Json {
  return reduce(toJsonSchema(contract)) as Json;
}

/** A contract that holds one record, as the array of records one model call returns. */
export function modelListSchema(contract: ContractName): Json {
  return {
    type: 'object',
    properties: { results: { type: 'array', items: modelSchema(contract) } },
    required: ['results'],
    additionalProperties: false,
  };
}
