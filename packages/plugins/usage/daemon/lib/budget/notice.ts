/**
 * The one notice a hard limit sends the owner (docs/budgets.md): which login, what it spent against which limit, which
 * ferrets were stopped, and the way forward. Ferretry never moves a ferret itself. Pure.
 *
 * It is said as text plus a stable reference and published as an event (`usage.budget-reached`); whoever shows the owner
 * what needs them (Agenda) subscribes. Usage raises nothing on anyone's list itself.
 */
import { budgetResetWords, usdWords } from '../../../contract/index.ts';
import type { BudgetNotice } from './service.ts';

/** One reference per login per period start, so the notice never repeats. */
export const budgetNoticeRef = (notice: Pick<BudgetNotice, 'login' | 'period' | 'resetsAtMs'>): string =>
  `budget:${notice.login}:${notice.period}:${new Date(notice.resetsAtMs).toISOString()}`;

export interface BudgetNoticeText {
  readonly ref: string;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
}

/** The notice for `notice`, in the words of `cli` (the binary's name) on `machine`. */
export function budgetNoticeText(notice: BudgetNotice, cli: string, machine: string): BudgetNoticeText {
  const span = notice.period === 'daily' ? 'today' : 'this week';
  const spent = `${usdWords(notice.spentUsd)} ${span} on ${machine}, past its ${usdWords(notice.hardUsd)} hard limit`;
  const relocated = notice.relocated ?? [];
  const ran = [
    ...(notice.stopped.length === 0
      ? []
      : [`Stopped, with their turns saved: ${notice.stopped.map(session => `:${session.name}`).join(', ')}.`]),
    ...(relocated.length === 0
      ? []
      : [`Moved to another login by the Warden: ${relocated.map(session => `:${session.name}`).join(', ')}.`]),
  ];
  const stoppedWords = ran.length === 0 ? 'No ferret was running on it.' : ran.join(' ');
  const failedWords =
    notice.failed.length === 0
      ? []
      : [
          `Could not stop yet (tried again every minute): ${notice.failed.map(session => `:${session.name}`).join(', ')}.`,
        ];
  const reset = budgetResetWords(notice.resetsAtMs, notice.timeZone);
  const next =
    notice.stopped.length + notice.failed.length === 0
      ? `Start new work on another login, such as ${notice.alternative ?? 'one within its budget'}.`
      : `To carry on now, start the same work on another login${notice.alternative === undefined ? '' : `, such as ${notice.alternative}`}. Ferretry does not move them for you.`;
  return {
    ref: budgetNoticeRef(notice),
    title: `${notice.login} hit its hard limit`,
    summary: `${notice.login} spent ${spent}.`,
    body: [
      `Login "${notice.login}" spent ${spent}. ${stoppedWords}`,
      ...failedWords,
      `The budget resets ${reset}.`,
      next,
      `Or wait for the reset and resume them with \`${cli} resume <id>\`.`,
      'Or raise the limit in usage.yaml (a raise waits for your confirmation).',
    ].join('\n'),
  };
}
