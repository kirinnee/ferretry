import {
  type CopyRouteFrom,
  type CopyRouteTo,
  grantMissWords,
  MAX_AGENDA_DETAIL_LENGTH,
  MAX_AGENDA_SUBJECT_LENGTH,
  placeWords,
  TASK_PLAN_SUMMARY_LINE_MAX_CHARS,
  type TaskPlan,
  type TaskPlanCandidate,
  type TaskPlanLine,
  type TaskPlanSelectedLine,
} from '@ferretry/protocol';

/**
 * THE DAEMON'S WORDS FOR A TASK PLAN: the card's ask and context, the passkey dialog's summary, and what the ferret is
 * told. Every word about a line comes from what the daemon RESOLVED (the account, the place, the fields); the ferret's
 * own reason is shown only after "The ferret says", as its words. No word here is a value, and nothing the ferret is
 * told says which secret fields an account holds.
 */

/**
 * The one line every plan card carries while no ferret on this machine can be walled off from Ferretry's own files
 * (RF-5): what a plan does and does not protect against.
 */
export const TASK_PLAN_HONEST_LIMIT =
  "Ferrets here can read Ferretry's own files, so this stops misuse through their tools and page text, not a ferret that goes around Ferretry.";

/** "a copy from gh → the vercel program in a terminal", in plain words. */
export function routeOf(from: CopyRouteFrom, to: CopyRouteTo): string {
  const source =
    from.kind === 'command'
      ? `what ${from.program} prints`
      : from.kind === 'browser'
        ? `text from ${from.origin}`
        : `the clipboard of ${from.origin}`;
  const destination =
    to.kind === 'terminal'
      ? `${to.program} in a terminal`
      : to.kind === 'browser'
        ? `a field on ${to.origin}`
        : `the secret ${to.name}`;
  return `${source} → ${destination}`;
}

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
const uses = (count: number): string => (count === 1 ? '1 use' : `${String(count)} uses`);

/** "GitHub · kirinnee on github.com". */
export const candidateWords = (candidate: TaskPlanCandidate): string =>
  `${candidate.account.label}${candidate.username === undefined ? '' : ` · ${candidate.username}`} ${placeWords(candidate.place)}`;

/** "username, password and codes". */
const fieldWords = (fields: readonly string[]): string => {
  const named = fields.map(field => (field === 'totp' ? 'codes' : field));
  return named.length <= 1 ? (named[0] ?? '') : `${named.slice(0, -1).join(', ')} and ${named.at(-1) ?? ''}`;
};

/** What one line asks, in the daemon's words, before the owner has picked an account. */
function lineAsk(line: TaskPlanLine): string {
  if (line.kind === 'paste') return `Paste ${routeOf(line.from, line.to)} (${uses(line.uses)})`;
  const [only] = line.candidates;
  const who =
    line.candidates.length === 1 && only !== undefined
      ? candidateWords(only)
      : line.candidates.length === 0
        ? 'an account not in Accounts'
        : `one of ${String(line.candidates.length)} accounts`;
  const what =
    line.kind === 'terminal-sign-in'
      ? `Type the password of ${who} (root there)`
      : `Sign in as ${who} with its ${fieldWords(line.fields)}`;
  const because = line.because === undefined ? undefined : grantMissWords(line.because);
  return `${what} (${uses(line.uses)})${line.state === 'unavailable' && because !== undefined ? `: can't be pre-approved, ${because}` : ''}`;
}

const expiryWords = (expiresAt: string): string => `${expiresAt.slice(0, 16).replace('T', ' ')} UTC`;

/** The card's ask: the subject line. */
export function planAsk(plan: Pick<TaskPlan, 'lines' | 'expiresAt'>): string {
  const count = plan.lines.length;
  return clip(
    `Allow ${count === 1 ? 'this' : `these ${String(count)}`} for this task, without asking, until ${expiryWords(plan.expiresAt)}?`,
    MAX_AGENDA_SUBJECT_LENGTH,
  );
}

/** The card's context: one numbered line each, the ferret's words marked as its own, and the honest limit. */
export function planContext(plan: Pick<TaskPlan, 'lines'>): string {
  const room = Math.floor((MAX_AGENDA_DETAIL_LENGTH - TASK_PLAN_HONEST_LIMIT.length - 8) / plan.lines.length) - 2;
  const lines = plan.lines.map(line =>
    clip(`${String(line.line + 1)}. ${lineAsk(line)}. The ferret says: ${line.why}`, room),
  );
  return clip([...lines, '', TASK_PLAN_HONEST_LIMIT].join('\n'), MAX_AGENDA_DETAIL_LENGTH);
}

/** How the card is answered: on the card, and (paste lines only) at the machine as today. */
export function planHowToResolve(plan: Pick<TaskPlan, 'id' | 'lines'>): string {
  return plan.lines.every(line => line.kind === 'paste')
    ? `Tick the pastes you allow on the card, or at the machine: \`fy copy plan approve ${plan.id} <numbers>\`.`
    : 'Tick the lines you allow on the card in the app; a sign-in line is confirmed with your passkey.';
}

/**
 * The passkey dialog's words for one ticked line: the account, the place and the fields as the daemon will fill them,
 * from the pins it bound, never from the ferret.
 */
export function selectedWords(line: TaskPlanSelectedLine, plan: TaskPlan): string {
  const number = `Line ${String(line.line + 1)}`;
  if (line.kind === 'paste')
    return clip(
      `${number}: paste ${routeOf(line.from, line.to)}, ${uses(line.uses)}`,
      TASK_PLAN_SUMMARY_LINE_MAX_CHARS,
    );
  const held = plan.lines[line.line];
  const candidate =
    held === undefined || held.kind === 'paste' ? undefined : held.candidates.find(each => each.signIn === line.signIn);
  const who = candidate === undefined ? line.signIn : candidateWords(candidate);
  const words =
    line.kind === 'terminal-sign-in'
      ? `${number}: type the password of ${who}; this gives the ferret root there, ${uses(line.uses)}`
      : `${number}: sign in as ${who} with its ${fieldWords(line.fields)}, ${uses(line.uses)}`;
  return clip(words, TASK_PLAN_SUMMARY_LINE_MAX_CHARS);
}

/** "lines 1, 3". */
export const lineList = (lines: readonly number[]): string =>
  `${lines.length === 1 ? 'line' : 'lines'} ${lines.map(line => String(line + 1)).join(', ')}`;

/** How the card closes once the plan is answered. */
export function answeredNote(approved: readonly number[], plan: Pick<TaskPlan, 'expiresAt'>): string {
  return approved.length === 0
    ? 'You declined the plan.'
    : `You allowed ${lineList(approved)} until ${expiryWords(plan.expiresAt)}.`;
}

/**
 * What the ferret is told when its plan is answered: the lines allowed and until when, nothing about an account's
 * secret fields or the code tick.
 */
export function answeredTell(
  agendaItemId: string,
  approved: readonly number[],
  plan: Pick<TaskPlan, 'expiresAt'>,
): string {
  return approved.length === 0
    ? `${agendaItemId}: the owner declined your task plan; each sign-in and paste will ask them.`
    : `${agendaItemId}: the owner allowed ${lineList(approved)} of your task plan, until ${plan.expiresAt}. Raise browser_request_input / terminal_request_input and secure.paste as usual; the rest ask the owner.`;
}
