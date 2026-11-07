// S01 spike validator: JSON Schema (2020-12) check plus the semantic rules the schema
// cannot express. Throwaway; T02 (#18) owns the canonical contracts.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";

export const DEFAULT_SCHEMA_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/evaluation/label.schema.json",
);

export type IssueCode =
  | "schema"
  | "segment_end_not_after_start"
  | "range_empty"
  | "split_overlap"
  | "duplicate_segment"
  | "same_speaker_overlap"
  | "segment_not_in_split"
  | "segment_in_multiple_ranges";

export interface Issue {
  code: IssueCode;
  path: string;
  message: string;
}

export interface Range {
  start_ms: number;
  end_ms: number;
}

interface SegmentRef extends Range {
  speaker: string;
}

interface LabelSet {
  split: { tuning: Range[]; held_out: Range[]; excluded?: Range[] };
  labels: { segment: SegmentRef }[];
}

type Subset = "tuning" | "held_out" | "excluded";
const SUBSETS: readonly Subset[] = ["tuning", "held_out", "excluded"];

export type Validator = (data: unknown) => Issue[];

export function loadValidator(schemaPath: string = DEFAULT_SCHEMA_PATH): Validator {
  const schema: unknown = JSON.parse(readFileSync(schemaPath, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false });
  ajv.addKeyword("x-spike");
  const check = ajv.compile(schema as object);

  return (data: unknown): Issue[] => {
    if (!check(data)) {
      return (check.errors ?? []).map(schemaIssue);
    }
    return semanticIssues(data as LabelSet);
  };
}

// Ajv error params that only ever carry schema-derived values. Anything else (notably
// `additionalProperty` and `propertyName`) can echo input-derived text and is dropped.
const SAFE_PARAMS = new Set([
  "missingProperty",
  "allowedValue",
  "allowedValues",
  "type",
  "limit",
  "comparison",
  "pattern",
  "format",
  "multipleOf",
  "failingKeyword",
]);

function schemaIssue(e: ErrorObject): Issue {
  const safe = Object.fromEntries(Object.entries(e.params ?? {}).filter(([k]) => SAFE_PARAMS.has(k)));
  const detail = Object.keys(safe).length ? ` ${JSON.stringify(safe)}` : "";
  return { code: "schema", path: e.instancePath || "/", message: `${e.message ?? "invalid"}${detail}` };
}

/** Half-open [start, end) intervals overlap. */
export function overlaps(a: Range, b: Range): boolean {
  return a.start_ms < b.end_ms && b.start_ms < a.end_ms;
}

/** Fully inside a half-open range. */
function contains(outer: Range, inner: Range): boolean {
  return outer.start_ms <= inner.start_ms && inner.end_ms <= outer.end_ms;
}

export function semanticIssues(doc: LabelSet): Issue[] {
  const issues: Issue[] = [];

  // 1. Split ranges: non-empty and pairwise disjoint (within and across subsets).
  const ranges: { subset: Subset; index: number; range: Range }[] = [];
  for (const subset of SUBSETS) {
    (doc.split[subset] ?? []).forEach((range, index) => {
      if (range.end_ms <= range.start_ms) {
        issues.push({
          code: "range_empty",
          path: `/split/${subset}/${index}`,
          message: `range end_ms (${range.end_ms}) must be greater than start_ms (${range.start_ms})`,
        });
      }
      ranges.push({ subset, index, range });
    });
  }
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      const a = ranges[i]!;
      const b = ranges[j]!;
      if (overlaps(a.range, b.range)) {
        issues.push({
          code: "split_overlap",
          path: `/split/${b.subset}/${b.index}`,
          message: `overlaps /split/${a.subset}/${a.index} ([${a.range.start_ms}, ${a.range.end_ms}) vs [${b.range.start_ms}, ${b.range.end_ms}))`,
        });
      }
    }
  }

  // 2. Segments: positive duration, unique refs, no same-speaker overlap, exactly one split range.
  const seen = new Map<string, number>();
  doc.labels.forEach(({ segment }, i) => {
    const path = `/labels/${i}/segment`;
    if (segment.end_ms <= segment.start_ms) {
      issues.push({
        code: "segment_end_not_after_start",
        path,
        message: `end_ms (${segment.end_ms}) must be greater than start_ms (${segment.start_ms})`,
      });
    }

    const key = `${segment.speaker}@${segment.start_ms}-${segment.end_ms}`;
    const prior = seen.get(key);
    if (prior !== undefined) {
      issues.push({ code: "duplicate_segment", path, message: `same segment ref as /labels/${prior}/segment (${key})` });
    } else {
      seen.set(key, i);
    }

    const containing = ranges.filter((r) => contains(r.range, segment));
    if (containing.length === 0) {
      issues.push({
        code: "segment_not_in_split",
        path,
        message: `segment ${key} is not fully inside any tuning/held_out/excluded range (straddling a boundary is not allowed)`,
      });
    } else if (containing.length > 1) {
      issues.push({
        code: "segment_in_multiple_ranges",
        path,
        message: `segment ${key} is inside ${containing.map((r) => `/split/${r.subset}/${r.index}`).join(", ")}`,
      });
    }
  });

  for (let i = 0; i < doc.labels.length; i++) {
    for (let j = i + 1; j < doc.labels.length; j++) {
      const a = doc.labels[i]!.segment;
      const b = doc.labels[j]!.segment;
      const sameRef = a.start_ms === b.start_ms && a.end_ms === b.end_ms;
      if (a.speaker === b.speaker && !sameRef && overlaps(a, b)) {
        issues.push({
          code: "same_speaker_overlap",
          path: `/labels/${j}/segment`,
          message: `overlaps /labels/${i}/segment on the same speaker track '${a.speaker}' (overlap across different speakers is allowed)`,
        });
      }
    }
  }

  return issues;
}

/** Which subset each label falls into; useful for reporting counts. Assumes a valid document. */
export function subsetCounts(doc: LabelSet): Record<Subset, number> {
  const counts: Record<Subset, number> = { tuning: 0, held_out: 0, excluded: 0 };
  for (const { segment } of doc.labels) {
    for (const subset of SUBSETS) {
      if ((doc.split[subset] ?? []).some((r) => contains(r, segment))) counts[subset]++;
    }
  }
  return counts;
}
