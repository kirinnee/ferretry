import type { TidyPlan } from '@ferretry/protocol';

const clip = (text: string, width: number): string => {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
};

const TITLE_WIDTH = 70;

/** One card or item the tidy touched, or failed to touch. */
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
const item = (id: string) => `!${id}`;

function section(heading: string, rows: readonly string[]): string[] {
  return rows.length === 0 ? [] : ['', heading, ...rows.map(row => `  ${row}`)];
}

function lines(plan: TidyPlan): { drop: string[]; close: string[]; keep: string[] } {
  return {
    drop: plan.drop.map(each => `${card(each.id)}  ${clip(each.title, TITLE_WIDTH)} — ${each.why}`),
    close: plan.close.map(each => `${item(each.id)}  ${clip(each.subject, TITLE_WIDTH)} — ${each.why}`),
    keep: plan.keep.map(each =>
      each.kind === 'task'
        ? `${card(each.id)}  ${clip(each.title, TITLE_WIDTH)} — ${each.why}`
        : `${item(each.id)}  ${clip(each.title, TITLE_WIDTH)} — ${each.why}`,
    ),
  };
}

/** What a dry run prints: what would be dropped, closed and kept, each with its reason. */
export function renderDryRun(plan: TidyPlan, binary: string): string {
  const { drop, close, keep } = lines(plan);
  if (drop.length === 0 && close.length === 0) {
    return [
      'Nothing to tidy: no card to drop and no agenda item to close.',
      ...section(`Kept (${String(keep.length)})`, keep),
    ].join('\n');
  }
  return [
    'Dry run: nothing changed.',
    ...section(`Would drop ${String(drop.length)} card(s)`, drop),
    ...section(`Would close ${String(close.length)} agenda item(s)`, close),
    ...section(`Would keep ${String(keep.length)}`, keep),
    '',
    `Apply it with: ${binary} tidy --yes [--reason "<why>"]`,
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
    `Tidied: dropped ${String(done(result.dropped))} card(s), closed ${String(done(result.closed))} agenda item(s)${
      failed === 0 ? '.' : `; ${String(failed)} failed.`
    }`,
    ...section('Cards', result.dropped.map(outcomeRow)),
    ...section('Agenda items', result.closed.map(outcomeRow)),
    ...section(`Kept (${String(plan.keep.length)})`, lines(plan).keep),
  ].join('\n');
}
