/**
 * Runs the transcribe stage in its own process, so a test can kill it mid-run:
 *
 *   node resume-worker.ts <dataRoot> <control.json> <campaign.json> <glossary.json>
 *
 * Contracts resolve to their source, as in vitest, so no build is needed.
 */
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const contracts = fileURLToPath(new URL('../../../contracts/src/index.ts', import.meta.url));
registerHooks({
  resolve(specifier, context, next) {
    return specifier === '@sargas-recap/contracts'
      ? { url: pathToFileURL(contracts).href, shortCircuit: true }
      : next(specifier, context);
  },
});

const [dataRoot, control, campaignFile, glossaryFile] = process.argv.slice(2);
if (
  dataRoot === undefined ||
  control === undefined ||
  campaignFile === undefined ||
  glossaryFile === undefined
) {
  throw new Error('usage: resume-worker.ts <dataRoot> <control> <campaign> <glossary>');
}

const { configVersion } = await import('../../src/config/index.ts');
const { openStateDatabase } = await import('../../src/db/index.ts');
const { runStage } = await import('../../src/jobs/runner.ts');
const { createLogger } = await import('../../src/log/index.ts');
const { createDataPaths } = await import('../../src/paths/index.ts');
const { CAMPAIGN, SESSION, stagesFor } = await import('./whisper-helpers.ts');

const paths = createDataPaths(dataRoot);
const { db } = await openStateDatabase(paths);
const campaign = JSON.parse(readFileSync(campaignFile, 'utf8')) as Parameters<
  typeof configVersion
>[0];
const glossary = JSON.parse(readFileSync(glossaryFile, 'utf8')) as Parameters<
  typeof configVersion
>[1];
await runStage({
  db,
  campaignId: CAMPAIGN,
  sessionId: SESSION,
  stage: 'transcribe',
  stages: stagesFor(control),
  paths,
  config: { campaign, glossary, version: configVersion(campaign, glossary) },
  logger: createLogger({ level: 'error' }),
});
db.close();
