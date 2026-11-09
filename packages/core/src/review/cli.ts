/**
 * `recap overrides` (T12): list, set and reconcile GM review overrides. Modules are loaded inside
 * each action so `recap --help` stays fast. Output goes to the GM's terminal; the logger only ever
 * gets IDs and counts, never transcript or override text.
 */
import type { Command } from 'commander';
import { LABELS, type ClassificationLabel } from '@sargas-recap/contracts';
import type { JobCliIo } from '../jobs/cli.ts';
import type { Logger } from '../log/index.ts';
import { isReviewError, ReviewError } from './errors.ts';
import type { SessionRef } from './session.ts';
import type {
  ExclusionReason,
  OverrideChanges,
  RecapInclusion,
  ReviewStatus,
  StoredOverride,
} from './store.ts';

export interface ReviewCliDeps {
  readonly logger?: Logger | undefined;
}

interface CommonOptions {
  campaign: string;
  session: string;
  dataRoot?: string;
  allowInRepo?: boolean;
  json?: boolean;
}

interface SetOptions extends CommonOptions {
  segment: string;
  label?: string;
  clearLabel?: boolean;
  inclusion?: string;
  text?: string;
  textFile?: string;
  clearText?: boolean;
  exclusion?: string;
  clearExclusions?: boolean;
  status?: string;
}

interface ReconcileOptions extends CommonOptions {
  override: string;
  segment?: string;
  discard?: boolean;
}

interface EffectiveOptions extends CommonOptions {
  text?: boolean;
}

const INCLUSIONS: readonly string[] = ['include', 'exclude', 'unresolved', 'default'];
const STATUSES: readonly string[] = ['pending', 'reviewed'];
const REASONS: readonly string[] = ['spoiler', 'privacy', 'off-topic'];

function addCommon(command: Command): Command {
  return command
    .requiredOption('--campaign <id>', 'campaign id (slug)')
    .requiredOption('--session <id>', 'session id (slug)')
    .option('--data-root <dir>', 'data root (default: RECAP_DATA_ROOT, then the per-user dir)')
    .option('--allow-in-repo', 'accept a data root inside a git working tree');
}

function usage(message: string): never {
  throw new ReviewError('REVIEW_USAGE', message);
}

function oneOf(flag: string, value: string, allowed: readonly string[]): string {
  if (!allowed.includes(value)) usage(`${flag} must be one of: ${allowed.join(', ')}`);
  return value;
}

async function textOption(options: SetOptions): Promise<string | null | undefined> {
  const given = [options.text, options.textFile, options.clearText].filter((v) => v !== undefined);
  if (given.length > 1) usage('use only one of --text, --text-file and --clear-text');
  if (options.clearText === true) return null;
  if (options.textFile === undefined) return options.text;
  const { readFile } = await import('node:fs/promises');
  let content: string;
  try {
    content = await readFile(options.textFile, 'utf8');
  } catch (error) {
    throw new ReviewError('REVIEW_USAGE', `cannot read ${options.textFile}`, { cause: error });
  }
  const body = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  return body.replace(/\r?\n$/, '');
}

function exclusionOption(options: SetOptions): readonly ExclusionReason[] | undefined {
  if (options.exclusion !== undefined && options.clearExclusions === true) {
    usage('use only one of --exclusion and --clear-exclusions');
  }
  if (options.clearExclusions === true) return [];
  if (options.exclusion === undefined) return undefined;
  return options.exclusion
    .split(',')
    .map((part) => oneOf('--exclusion', part.trim(), REASONS) as ExclusionReason);
}

async function changesFrom(options: SetOptions): Promise<OverrideChanges> {
  if (options.label !== undefined && options.clearLabel === true) {
    usage('use only one of --label and --clear-label');
  }
  const label =
    options.clearLabel === true
      ? null
      : options.label === undefined
        ? undefined
        : (oneOf('--label', options.label, LABELS) as ClassificationLabel);
  const inclusion =
    options.inclusion === undefined
      ? undefined
      : oneOf('--inclusion', options.inclusion, INCLUSIONS);
  const text = await textOption(options);
  const exclusions = exclusionOption(options);
  const status =
    options.status === undefined
      ? undefined
      : (oneOf('--status', options.status, STATUSES) as ReviewStatus);
  const changes: OverrideChanges = {
    ...(label === undefined ? {} : { labelOverride: label }),
    ...(inclusion === undefined
      ? {}
      : { recapInclusion: inclusion === 'default' ? null : (inclusion as RecapInclusion) }),
    ...(text === undefined ? {} : { textOverride: text }),
    ...(exclusions === undefined ? {} : { exclusionReasons: exclusions }),
    ...(status === undefined ? {} : { reviewStatus: status }),
  };
  if (Object.keys(changes).length === 0) usage('nothing to set: pass at least one change');
  return changes;
}

function describeOverride(override: StoredOverride): string {
  const parts = [override.override_id, override.segment_id];
  if (override.label_override !== undefined) parts.push(`label=${override.label_override}`);
  parts.push(`inclusion=${override.recap_inclusion ?? 'default'}`);
  if (override.exclusion_reasons.length > 0) {
    parts.push(`exclusions=${override.exclusion_reasons.join(',')}`);
  }
  if (override.text_override !== undefined) parts.push('cleaned-text');
  parts.push(`status=${override.review_status}`, `rev=${String(override.revision)}`);
  return parts.join(' ');
}

async function reportReviewError(io: JobCliIo, error: unknown): Promise<void> {
  if (isReviewError(error)) {
    io.err(`recap: ${error.message}\n`);
    if (error.hint !== undefined) io.err(`  fix: ${error.hint}\n`);
    process.exitCode = error.code === 'REVIEW_USAGE' ? 2 : 1;
    return;
  }
  const { reportError } = await import('../jobs/cli.ts');
  await reportError(io, error);
}

export function registerReviewCommands(
  program: Command,
  io: JobCliIo,
  deps: ReviewCliDeps = {},
): void {
  const withSession = async (
    options: CommonOptions,
    action: (ref: SessionRef) => Promise<void>,
  ): Promise<void> => {
    try {
      const { assertSlug, openDataRoot } = await import('../paths/index.ts');
      const { openStateDatabase } = await import('../db/index.ts');
      assertSlug('campaign_id', options.campaign);
      assertSlug('session_id', options.session);
      const { paths } = openDataRoot({ flag: options.dataRoot, allowInRepo: options.allowInRepo });
      const { db } = await openStateDatabase(paths, { logger: deps.logger });
      try {
        await action({ db, paths, campaignId: options.campaign, sessionId: options.session });
      } finally {
        db.close();
      }
    } catch (error) {
      await reportReviewError(io, error);
    }
  };

  const logged = (event: string, ref: SessionRef): void => {
    deps.logger?.info(event, { campaignId: ref.campaignId, sessionId: ref.sessionId, count: 1 });
  };

  const group = program
    .command('overrides')
    .description('list and set GM review overrides of a session');

  addCommon(group.command('list').description('list overrides, unreconciled ones first'))
    .option('--json', 'print review-override records as JSON')
    .action(async (options: CommonOptions) => {
      await withSession(options, async (ref) => {
        const { loadSessionReview } = await import('./session.ts');
        const { unreconciledExclusions } = await import('./project.ts');
        const { toReviewOverride } = await import('./store.ts');
        const { view, overrides } = await loadSessionReview(ref);
        if (options.json === true) {
          io.out(
            `${JSON.stringify(
              {
                campaign_id: view.campaign_id,
                session_id: view.session_id,
                transcription_run_id: view.transcription_run_id,
                classification_run_id: view.classification_run_id,
                needs_reconciliation: view.needs_reconciliation,
                overrides: overrides.map(toReviewOverride),
              },
              null,
              2,
            )}\n`,
          );
          return;
        }
        io.out(
          `${view.campaign_id}/${view.session_id}: transcription ${view.transcription_run_id}, classification ${view.classification_run_id ?? 'none'}\n`,
        );
        if (view.needs_reconciliation.length > 0) {
          io.out(`needs reconciliation (${String(view.needs_reconciliation.length)}):\n`);
          for (const entry of view.needs_reconciliation) {
            const exclusions =
              entry.exclusion_reasons.length > 0
                ? ` exclusions=${entry.exclusion_reasons.join(',')}`
                : '';
            io.out(`  ${entry.override_id} ${entry.segment_id} ${entry.reason}${exclusions}\n`);
          }
          if (unreconciledExclusions(view).length > 0) {
            io.out('  a recap is refused until the spoiler and privacy exclusions are handled\n');
          }
        }
        const attached = overrides.filter((o) => o.reconciliation === 'attached');
        io.out(`overrides (${String(attached.length)}):\n`);
        for (const override of attached) io.out(`  ${describeOverride(override)}\n`);
      });
    });

  addCommon(group.command('effective').description('show the effective transcript of the session'))
    .option('--json', 'print the effective-transcript-review record as JSON')
    .option('--text', 'also print the effective and original text')
    .action(async (options: EffectiveOptions) => {
      await withSession(options, async (ref) => {
        const { loadSessionReview } = await import('./session.ts');
        const { view } = await loadSessionReview(ref);
        if (options.json === true) {
          io.out(`${JSON.stringify(view, null, 2)}\n`);
          return;
        }
        for (const s of view.segments) {
          const flags = [...s.segment_flags, ...s.classification_flags];
          io.out(
            `${s.segment_id} ${s.label ?? 'unclassified'}/${s.label_source} ${s.recap_inclusion} ${s.review_status}` +
              `${s.review_required ? ' review-required' : ''}${flags.length > 0 ? ` [${flags.join(',')}]` : ''}\n`,
          );
          if (options.text === true) {
            io.out(`  ${s.text_source}: ${s.text}\n`);
            if (s.text_source !== 'original') io.out(`  original: ${s.text_original}\n`);
          }
        }
      });
    });

  addCommon(group.command('set').description('create or change the override of one segment'))
    .requiredOption('--segment <id>', 'segment of the active transcription run')
    .option('--label <label>', `label override: ${LABELS.join(', ')}`)
    .option('--clear-label', 'remove the label override')
    .option(
      '--inclusion <value>',
      'include, exclude, unresolved, or default (no decision: follow the label)',
    )
    .option('--text <text>', 'cleaned text')
    .option('--text-file <file>', 'read the cleaned text from a UTF-8 file')
    .option('--clear-text', 'remove the cleaned text')
    .option('--exclusion <reasons>', 'comma-separated: spoiler, privacy, off-topic (replaces)')
    .option('--clear-exclusions', 'remove all exclusions')
    .option('--status <status>', 'review status: pending or reviewed')
    .option('--json', 'print the resulting review-override record as JSON')
    .action(async (options: SetOptions) => {
      await withSession(options, async (ref) => {
        const { setSegmentOverride } = await import('./session.ts');
        const { toReviewOverride } = await import('./store.ts');
        const override = await setSegmentOverride(ref, options.segment, await changesFrom(options));
        logged('review.override-set', ref);
        io.out(
          options.json === true
            ? `${JSON.stringify(toReviewOverride(override), null, 2)}\n`
            : `${describeOverride(override)}\n`,
        );
      });
    });

  addCommon(
    group
      .command('reconcile')
      .description('apply an unreconciled override to a chosen segment, or discard it'),
  )
    .requiredOption('--override <id>', 'override that needs reconciliation')
    .option('--segment <id>', 'target segment of the active run (repeat the command for a split)')
    .option('--discard', 'retire the override; it stays in history')
    .action(async (options: ReconcileOptions) => {
      await withSession(options, async (ref) => {
        if ((options.segment === undefined) === (options.discard !== true)) {
          usage('pass exactly one of --segment and --discard');
        }
        const { discardUnreconciled, reconcileToSegment } = await import('./session.ts');
        if (options.segment === undefined) {
          await discardUnreconciled(ref, options.override);
          logged('review.override-discarded', ref);
          io.out(`discarded ${options.override}\n`);
          return;
        }
        const created = await reconcileToSegment(ref, options.override, options.segment);
        logged('review.override-reconciled', ref);
        io.out(`${describeOverride(created)}\n`);
      });
    });

  addCommon(group.command('history').description('show every revision of one override'))
    .requiredOption('--override <id>', 'override id')
    .action(async (options: CommonOptions & { override: string }) => {
      await withSession(options, async (ref) => {
        const { getOverride, listOverrideHistory } = await import('./store.ts');
        const override = getOverride(ref.db, options.override);
        if (override?.campaign_id !== ref.campaignId || override.session_id !== ref.sessionId) {
          throw new ReviewError(
            'REVIEW_OVERRIDE_NOT_FOUND',
            `override ${options.override} is not in ${ref.campaignId}/${ref.sessionId}`,
          );
        }
        for (const entry of listOverrideHistory(ref.db, options.override)) {
          io.out(
            `rev ${String(entry.revision)} ${entry.changed_at} ${entry.action} label=${entry.label_override ?? '-'} ` +
              `inclusion=${entry.recap_inclusion ?? 'default'} exclusions=${entry.exclusion_reasons.join(',') || '-'} ` +
              `cleaned-text=${entry.text_override === null ? 'no' : 'yes'} status=${entry.review_status} ${entry.reconciliation}\n`,
          );
        }
      });
    });
}
