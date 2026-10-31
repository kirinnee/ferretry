/**
 * The one notice a hard limit sends the owner (docs/budgets.md): which login, what it spent against which
 * limit, which ferrets were stopped, and the way forward — `fy migrate` onto a login within its budget.
 * Ferretry never moves a ferret itself. Pure.
 */
import { budgetResetWords, usdWords } from '@ferretry/fleet';
import {
  AGENDA_PUSH_BODY_LENGTH,
  AGENDA_PUSH_TITLE_LENGTH,
  MAX_AGENDA_DETAIL_LENGTH,
  MAX_AGENDA_REASON_LENGTH,
} from '@ferretry/protocol';
import type { RaiseAgendaRequest } from '../agenda/state-machine.ts';
import type { BudgetNotice } from './service.ts';

/** The agenda source reference of a hard-limit notice: one per login per period start, so it never repeats. */
export const budgetNoticeRef = (notice: Pick<BudgetNotice, 'login' | 'period' | 'resetsAtMs'>): string =>
  `budget:${notice.login}:${notice.period}:${new Date(notice.resetsAtMs).toISOString()}`;

const clamp = (text: string, length: number): string =>
  text.length <= length ? text : `${text.slice(0, length - 1)}…`;

/** The raise for `notice`, in the words of `cli` (the binary's name) on `machine`. */
export function budgetNoticeRequest(
  notice: BudgetNotice,
  cli: string,
  machine: string,
  at: string,
): RaiseAgendaRequest {
  const span = notice.period === 'daily' ? 'today' : 'this week';
  const spent = `${usdWords(notice.spentUsd)} ${span} on ${machine}, past its ${usdWords(notice.hardUsd)} hard limit`;
  const stoppedWords =
    notice.stopped.length === 0
      ? 'No ferret was running on it.'
      : `Stopped, with their turns saved: ${notice.stopped.map(session => `:${session.name}`).join(', ')}.`;
  const failedWords =
    notice.failed.length === 0
      ? []
      : [
          `Could not stop yet (tried again every minute): ${notice.failed.map(session => `:${session.name}`).join(', ')}.`,
        ];
  const target = notice.alternative ?? '<runtime>';
  const moved = [...notice.stopped, ...notice.failed];
  const migrate =
    moved.length === 0
      ? `Start new work on another login, such as ${notice.alternative ?? 'one within its budget'}.`
      : `To carry on now, move each one to another login: ${moved
          .map(session => `\`${cli} migrate ${session.id} -a ${target}\``)
          .join(', ')}. Ferretry does not move them for you.`;
  const reset = budgetResetWords(notice.resetsAtMs, notice.timeZone);
  return {
    source: 'agent-raised',
    sourceRef: budgetNoticeRef(notice),
    title: clamp(`${notice.login} hit its hard limit`, AGENDA_PUSH_TITLE_LENGTH),
    subject: clamp(`${notice.login} spent ${spent}.`, AGENDA_PUSH_BODY_LENGTH),
    why: clamp(`Login "${notice.login}" spent ${spent}. ${stoppedWords}`, MAX_AGENDA_DETAIL_LENGTH),
    premise: clamp(
      'A login past its hard spend limit has its running ferrets stopped; nothing new starts on it until the budget resets. The spend counted is this machine’s only.',
      MAX_AGENDA_REASON_LENGTH,
    ),
    context: clamp([stoppedWords, ...failedWords, `The budget resets ${reset}.`].join('\n'), MAX_AGENDA_DETAIL_LENGTH),
    howToResolve: clamp(
      [
        migrate,
        `Or wait for the reset (${reset}) and resume them with \`${cli} resume <id>\`.`,
        `Or raise the limit in logins/${notice.login}.yaml (a raise waits for your confirmation).`,
      ].join('\n'),
      MAX_AGENDA_DETAIL_LENGTH,
    ),
    waitingSince: at,
    notice: true,
    ping: true,
    kind: 'info',
  };
}
