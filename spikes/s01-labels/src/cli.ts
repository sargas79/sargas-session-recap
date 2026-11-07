#!/usr/bin/env node
// Usage: node src/cli.ts [--schema <path>] <label-set.json> [...more]
// Exit codes: 0 all valid, 1 at least one invalid file, 2 usage/IO error.
// Prints issue codes and JSON paths only, never segment text, so it is safe to run on real labels.
import { readFileSync } from "node:fs";
import { DEFAULT_SCHEMA_PATH, loadValidator, subsetCounts } from "./validate.ts";

function main(argv: string[]): number {
  let schemaPath = DEFAULT_SCHEMA_PATH;
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--schema") {
      const next = argv[++i];
      if (!next) return usage("--schema needs a path");
      schemaPath = next;
    } else if (arg === "-h" || arg === "--help") {
      return usage();
    } else {
      files.push(arg);
    }
  }
  if (files.length === 0) return usage("no input files");

  const validate = loadValidator(schemaPath);
  let failed = 0;
  for (const file of files) {
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      console.error(`ERROR ${file}: cannot read/parse JSON (${(err as Error).message})`);
      return 2;
    }
    const issues = validate(data);
    if (issues.length === 0) {
      const counts = subsetCounts(data as Parameters<typeof subsetCounts>[0]);
      console.log(`OK    ${file} (tuning=${counts.tuning} held_out=${counts.held_out} excluded=${counts.excluded})`);
    } else {
      failed++;
      console.log(`FAIL  ${file}`);
      for (const issue of issues) console.log(`  [${issue.code}] ${issue.path}: ${issue.message}`);
    }
  }
  return failed > 0 ? 1 : 0;
}

function usage(error?: string): number {
  if (error) console.error(`error: ${error}`);
  console.error("usage: node src/cli.ts [--schema <label.schema.json>] <label-set.json> [...]");
  return error ? 2 : 0;
}

process.exitCode = main(process.argv.slice(2));
