/** What `fy gc` and `fy tidy` print. Copied from today's `lib/scratch/render.ts` and `lib/tidy/render.ts`, in 5.0's words. */
import type { ScratchPlanView, ScratchSweepView, TidyPlan } from '../../contract/index.ts';

/** Compact byte counts. */
function humanBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(0)} kB`;
}

/** A dry-run inventory, including why every retained ferret is ineligible. */
export function renderScratchPlan(plan: readonly ScratchPlanView[]): string {
  const lines: string[] = [];
  const eligible = plan.filter(item => item.eligible);
  const total = eligible.reduce((sum, item) => sum + item.bytes, 0);
  for (const item of plan) {
    const mark = item.eligible ? 'FREE' : 'keep';
    lines.push(
      `${mark}  ${item.ferret}  ${humanBytes(item.bytes).padStart(8)}  ${item.name ?? ''}${
        item.eligible ? '' : `  (${item.reason})`
      }`,
    );
    if (item.eligible)
      for (const entry of item.entries.slice(0, 8))
        lines.push(
          `        ${humanBytes(entry.bytes).padStart(8)}  ${entry.name}${entry.kind === 'directory' ? '/' : ''}`,
        );
  }
  lines.push(`would free ${humanBytes(total)} from ${eligible.length} ferret(s) — nothing was deleted`);
  return lines.join('\n');
}

/** The result of a real sweep; partial deletion failures remain visible. */
export function renderScratchSweep(result: ScratchSweepView): string {
  const failures = result.failures === 0 ? '' : `; ${result.failures} entr(ies) could not be removed (see daemon log)`;
  return `reclaimed ${humanBytes(result.bytes)} from ${result.ferrets} ferret(s)${failures}`;
}

const clip = (text: string, width: number): string => {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
};

const TITLE_WIDTH = 70;

/** One card or ask the tidy touched, or failed to touch. */
export interface TidyOutcome {
  readonly reference: string;
  readonly title: string;
  readonly error?: string | undefined;
}

export interface TidyResult {
  readonly dropped: readonly TidyOutcome[];
  readonly closed: readonly TidyOutcome[];
}

const card = (id: string) => `&${id}`;
const ask = (id: string) => `!${id}`;

function section(heading: string, rows: readonly string[]): string[] {
  return rows.length === 0 ? [] : ['', heading, ...rows.map(row => `  ${row}`)];
}

function lines(plan: TidyPlan): { drop: string[]; close: string[]; keep: string[] } {
  return {
    drop: plan.drop.map(each => `${card(each.id)}  ${clip(each.title, TITLE_WIDTH)} — ${each.why}`),
    close: plan.close.map(each => `${ask(each.id)}  ${clip(each.subject, TITLE_WIDTH)} — ${each.why}`),
    keep: plan.keep.map(each =>
      each.kind === 'card'
        ? `${card(each.id)}  ${clip(each.title, TITLE_WIDTH)} — ${each.why}`
        : `${ask(each.id)}  ${clip(each.title, TITLE_WIDTH)} — ${each.why}`,
    ),
  };
}

/** What a dry run prints: what would be dropped, closed and kept, each with its reason. */
export function renderDryRun(plan: TidyPlan, binary: string, ferret?: string): string {
  const { drop, close, keep } = lines(plan);
  if (drop.length === 0 && close.length === 0) {
    return [
      'Nothing to tidy: no card to drop and no ask to close.',
      ...section(`Kept (${String(keep.length)})`, keep),
    ].join('\n');
  }
  return [
    'Dry run: nothing changed.',
    ...section(`Would drop ${String(drop.length)} card(s)`, drop),
    ...section(`Would close ${String(close.length)} ask(s)`, close),
    ...section(`Would keep ${String(keep.length)}`, keep),
    '',
    `Apply it with: ${binary} tidy${ferret === undefined ? '' : ` --ferret ${ferret}`} --yes [--reason "<why>"]`,
  ].join('\n');
}

const outcomeRow = (outcome: TidyOutcome): string =>
  outcome.error === undefined
    ? `${outcome.reference}  ${clip(outcome.title, TITLE_WIDTH)}`
    : `${outcome.reference}  ${clip(outcome.title, TITLE_WIDTH)} — FAILED: ${outcome.error}`;

/** What `--yes` prints: what it did, each failure said, and what it kept. */
export function renderApplied(plan: TidyPlan, result: TidyResult): string {
  const done = (outcomes: readonly TidyOutcome[]) => outcomes.filter(outcome => outcome.error === undefined).length;
  const failed = [...result.dropped, ...result.closed].filter(outcome => outcome.error !== undefined).length;
  return [
    `Tidied: dropped ${String(done(result.dropped))} card(s), closed ${String(done(result.closed))} ask(s)${
      failed === 0 ? '.' : `; ${String(failed)} failed.`
    }`,
    ...section('Cards', result.dropped.map(outcomeRow)),
    ...section('Asks', result.closed.map(outcomeRow)),
    ...section(`Kept (${String(plan.keep.length)})`, lines(plan).keep),
  ].join('\n');
}
