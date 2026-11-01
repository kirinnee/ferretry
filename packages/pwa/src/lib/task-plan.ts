/**
 * The browser's half of task plans (docs/secure-copy.md, "Task plans"): the owner's routes for a ferret's planned
 * sign-ins and pastes, and the pure rules the card draws from. Nothing here is a value: a line is a place, an account's
 * name and username, counts and times, and those names come only from the secrets-gated plan routes, never from the
 * agenda item's text. Nothing is cached at module scope, because plans belong to a machine.
 */

import {
  type GrantMissReason,
  grantMissWords,
  type IFyApiClient,
  LOGIN_TOTP_WARNING,
  type Place,
  placeWords,
  type SignInId,
  TASK_PLAN_ERROR_CODES,
  TASK_PLAN_HONEST_LIMIT,
  TaskPlanApprovalAnswerSchema,
  type TaskPlan,
  type TaskPlanApproval,
  type TaskPlanApprovalAnswer,
  type TaskPlanCandidate,
  type TaskPlanLine,
  type TaskPlanList,
  TaskPlanListSchema,
  TaskPlanSchema,
  type TaskPlanStageId,
  type TaskPlanStageView,
  TaskPlanStageViewSchema,
  taskPlanSelection,
} from '@ferretry/protocol';
import { z } from 'zod';

export type TaskPlanClient = Pick<IFyApiClient, 'request'>;

type SignInLine = Extract<TaskPlanLine, { readonly kind: 'sign-in' | 'terminal-sign-in' }>;
type PasteLine = Extract<TaskPlanLine, { readonly kind: 'paste' }>;

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const planPath = (plan: Pick<TaskPlan, 'id' | 'sessionId'>): string =>
  `/v1/sessions/${encodeURIComponent(plan.sessionId)}/task-plans/${encodeURIComponent(plan.id)}`;

const StageDroppedSchema = z.strictObject({ stage: z.string(), dropped: z.literal(true) });

/** Every live plan on the machine (`secrets.use`: it names accounts). */
export async function listTaskPlans(client: TaskPlanClient): Promise<TaskPlanList> {
  return await client.request('/v1/task-plans', TaskPlanListSchema);
}

/** STAGE: paste-only or empty selections are answered at once; a ticked sign-in line comes back staged for its passkey. */
async function stageApproval(
  client: TaskPlanClient,
  plan: Pick<TaskPlan, 'id' | 'sessionId'>,
  approval: TaskPlanApproval,
): Promise<TaskPlanApprovalAnswer> {
  return await client.request(`${planPath(plan)}/approval`, TaskPlanApprovalAnswerSchema, json(approval));
}

export async function readStage(
  client: TaskPlanClient,
  plan: Pick<TaskPlan, 'id' | 'sessionId'>,
  stage: TaskPlanStageId,
): Promise<TaskPlanStageView> {
  return await client.request(`${planPath(plan)}/approval/${encodeURIComponent(stage)}`, TaskPlanStageViewSchema);
}

/** COMMIT: only after the `approve-task-plan` passkey bound to this stage. */
async function commitStage(
  client: TaskPlanClient,
  plan: Pick<TaskPlan, 'id' | 'sessionId'>,
  stage: TaskPlanStageId,
): Promise<TaskPlan> {
  return await client.request(`${planPath(plan)}/approval/${encodeURIComponent(stage)}/commit`, TaskPlanSchema, {
    method: 'POST',
  });
}

/** DROP: nothing was approved. */
export async function dropStage(
  client: TaskPlanClient,
  plan: Pick<TaskPlan, 'id' | 'sessionId'>,
  stage: TaskPlanStageId,
): Promise<void> {
  await client.request(`${planPath(plan)}/approval/${encodeURIComponent(stage)}`, StageDroppedSchema, {
    method: 'DELETE',
  });
}

/** REVOKE: the named lines, or every line when none is named. One tap; it only narrows. */
export async function revokeLines(
  client: TaskPlanClient,
  plan: Pick<TaskPlan, 'id' | 'sessionId'>,
  lines?: readonly number[],
): Promise<TaskPlan> {
  return await client.request(
    `${planPath(plan)}/revoke`,
    TaskPlanSchema,
    json(lines === undefined ? {} : { lines: [...lines] }),
  );
}

// ── Words (the daemon's closed lists; nothing here comes from a ferret) ───────────────────────────────

/** Under the title of every plan card while no ferret here can be walled off from Ferretry's own files (RF-5). */
export const HONEST_CLIENT_LINE = TASK_PLAN_HONEST_LIMIT;

/** The one-factor warning under a ticked code. */
export const TOTP_TICK_WARNING = LOGIN_TOTP_WARNING;

export const TOTP_IMPOSSIBLE_WORDS = 'No automatic codes for this account';
export const NO_HISTORY_WORDS = 'First time Ferretry fills this sign-in: it checks the page and remembers the form';
export const PICK_FIRST_WORDS = 'Pick an account to tick this line';
export const DISMISSED_PLAN_WORDS = 'The passkey was dismissed, so nothing was approved. Tick the lines to try again.';
const NO_PASSKEY_DEVICE_WORDS =
  'This device cannot confirm with a passkey, so it cannot approve a sign-in line. Paste lines can still be approved.';
const STAGE_GONE_WORDS = 'That selection timed out or was already answered. Tick the lines again.';

/** What a plan can't cover, listed on every plan card under "You'll still be asked" (r3a-plan §5). */
export const STILL_ASKED: readonly { readonly what: string; readonly instead: string }[] = [
  { what: 'Push approvals (Okta Verify, Duo, a Google prompt)', instead: 'you approve on your phone' },
  { what: 'Security keys and passkeys', instead: 'handed to you; passkeys stay off in the agent browser' },
  { what: 'Captchas and human checks', instead: 'the ferret asks you to do it' },
  { what: 'Sign-ins not in Accounts, and sign-ins through another account', instead: 'the normal card' },
  { what: 'ssh, scp, npm or docker login, gh and any program but sudo, su and doas', instead: 'the normal card' },
  { what: 'SMS and email codes, and a code you did not tick', instead: 'the ferret reads its inbox, or you type it' },
  { what: 'Anything after a line stopped', instead: 'the normal card, with the reason' },
];

/** "kirin-box" from `sudo@kirin-box`, or the place's own words. */
const placeLabel = (place: Place): string => placeWords(place);

/** The host a terminal line types its password at. */
export const rootHost = (candidate: TaskPlanCandidate | undefined, line: SignInLine): string | undefined => {
  if (line.kind !== 'terminal-sign-in') return undefined;
  const place = (candidate ?? line.candidates[0])?.place;
  return place?.kind === 'terminal' ? place.host : undefined;
};

/** "Ferretry types kirin's password into sudo on kirin-box: this gives the ferret root on kirin-box". */
export const rootWords = (host: string | undefined, username: string | undefined): string =>
  host === undefined
    ? 'Ferretry types a password into sudo here: this gives the ferret root on this machine'
    : `Ferretry types ${username === undefined ? 'the' : `${username}’s`} password into sudo on ${host}: this gives the ferret root on ${host}`;

export const rootBadge = (host: string | undefined): string =>
  host === undefined ? 'root on this machine' : `root on ${host}`;

/** "Default for this project" and the like: why a line already has an account chosen. */
export const preselectWords = (why: NonNullable<SignInLine['preselect']>['why']): string | undefined =>
  ({
    ferret: 'Ferret chose this',
    project: 'Default for this project',
    folder: 'Default for this folder',
    site: 'Default for this site',
    only: undefined,
  })[why];

/** "Uses: 1" / "2 uses". */
export const usesWords = (count: number): string => (count === 1 ? '1 use' : `${String(count)} uses`);

/** "2 of 3 uses left". */
export const usesLeftWords = (left: number, asked: number): string => `${String(left)} of ${usesWords(asked)} left`;

export const timeWords = (instant: string): string => `${instant.slice(0, 16).replace('T', ' ')} UTC`;

/** "14:02" in the owner's own clock. */
export const clockWords = (instant: string): string => {
  const at = new Date(instant);
  return Number.isNaN(at.getTime())
    ? instant.slice(11, 16)
    : at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
};

/** "1", "1 and 3", "1, 3 and 4": lines as the owner counts them, from 1. */
const lineList = (lines: readonly number[]): string => {
  const numbers = [...lines].sort((left, right) => left - right).map(line => String(line + 1));
  return numbers.length <= 1 ? (numbers[0] ?? '') : `${numbers.slice(0, -1).join(', ')} and ${numbers.at(-1) ?? ''}`;
};

/** "Asked at the machine by `fy` at 14:02: lines 1 and 3. If you didn't just run this, Deny." */
export const machineStageWords = (stage: { readonly lines: readonly number[]; readonly askedAt: string }): string =>
  `Asked at the machine by fy at ${clockWords(stage.askedAt)}: line${stage.lines.length === 1 ? '' : 's'} ${lineList(stage.lines)}. If you didn’t just run this, Deny.`;

/** The sentence a stopping or unavailable line says for its reason. */
export const becauseWords = (reason: GrantMissReason | undefined): string | undefined =>
  reason === undefined ? undefined : grantMissWords(reason);

// ── Ticks and picks (the owner only narrows) ─────────────────────────────────────────────────────────

/** What the owner has done to one line. A line starts unticked, with no pick unless the owner's own default made one. */
export interface LineTick {
  readonly ticked: boolean;
  readonly signIn?: SignInId;
  readonly totp: boolean;
}

export type Ticks = Readonly<Record<number, LineTick>>;

const isSignIn = (line: TaskPlanLine): line is SignInLine => line.kind !== 'paste';

/**
 * The first state of a card: NOTHING IS TICKED. A line's account is chosen only where the line has one candidate, or the
 * owner's own default (project, folder, site) preselected one; a ferret's pick on a picker is never one.
 */
export function initialTicks(plan: TaskPlan): Ticks {
  const ticks: Record<number, LineTick> = {};
  for (const line of plan.lines) {
    const signIn = isSignIn(line) ? (line.preselect?.signIn ?? onlyCandidate(line)?.signIn) : undefined;
    ticks[line.line] = { ticked: false, totp: false, ...(signIn === undefined ? {} : { signIn }) };
  }
  return ticks;
}

const onlyCandidate = (line: SignInLine): TaskPlanCandidate | undefined =>
  line.candidates.length === 1 ? line.candidates[0] : undefined;

export const pickedCandidate = (line: SignInLine, tick: LineTick | undefined): TaskPlanCandidate | undefined =>
  line.candidates.find(candidate => candidate.signIn === (tick?.signIn ?? onlyCandidate(line)?.signIn));

/** A line may be ticked while it is waiting and, if it is a sign-in, has an account picked. */
export function mayTick(line: TaskPlanLine, tick: LineTick | undefined): boolean {
  if (line.state !== 'waiting') return false;
  return !isSignIn(line) || pickedCandidate(line, tick) !== undefined;
}

/** Whether a line asked for a code, and whether the picked account could make one. */
export const totpState = (line: TaskPlanLine, tick: LineTick | undefined): 'not-asked' | 'impossible' | 'available' => {
  if (!isSignIn(line) || !line.fields.includes('totp')) return 'not-asked';
  const picked = pickedCandidate(line, tick);
  return picked?.can.totp === true ? 'available' : 'impossible';
};

/** Another line already ticked the same account: one sign-in, one line. */
export function accountTakenElsewhere(plan: TaskPlan, ticks: Ticks, line: SignInLine): boolean {
  const mine = pickedCandidate(line, ticks[line.line])?.signIn;
  if (mine === undefined) return false;
  return plan.lines.some(
    other =>
      other.line !== line.line &&
      isSignIn(other) &&
      ticks[other.line]?.ticked === true &&
      pickedCandidate(other, ticks[other.line])?.signIn === mine,
  );
}

/** The ticked lines as the approval the daemon stages. A paste line carries neither a pick nor a code tick. */
export function approvalOf(plan: TaskPlan, ticks: Ticks): TaskPlanApproval {
  return {
    lines: plan.lines.flatMap(line => {
      const tick = ticks[line.line];
      if (tick?.ticked !== true) return [];
      if (!isSignIn(line)) return [{ line: line.line }];
      const signIn = pickedCandidate(line, tick)?.signIn;
      return [
        {
          line: line.line,
          ...(signIn === undefined ? {} : { signIn }),
          ...(tick.totp && totpState(line, tick) === 'available' ? { totp: true } : {}),
        },
      ];
    }),
  };
}

/** Why the ticks can't be sent, in the protocol's own words, or `undefined` when they can. The daemon checks again. */
export function selectionProblem(plan: TaskPlan, ticks: Ticks): string | undefined {
  const selection = taskPlanSelection(plan, approvalOf(plan, ticks));
  return selection.ok ? undefined : selection.reason;
}

/** Whether any ticked line is a sign-in (so the passkey is needed). */
export const ticksNeedPasskey = (plan: TaskPlan, ticks: Ticks): boolean =>
  plan.lines.some(line => isSignIn(line) && ticks[line.line]?.ticked === true);

// ── Grouping (lines sit under the account they would use) ────────────────────────────────────────────

export interface LineGroup {
  readonly key: string;
  /** The account's name and username, or the section it stands for. */
  readonly title: string;
  readonly lines: readonly TaskPlanLine[];
}

/** The words for an account: "GitHub · kirinnee". */
export const candidateName = (candidate: TaskPlanCandidate): string =>
  candidate.username === undefined ? candidate.account.label : `${candidate.account.label} · ${candidate.username}`;

/**
 * Lines grouped by the account they would use: one account, one group, in the order the lines come. A line that has
 * not got one account yet (a picker, or none in Accounts) sits under "Choose an account" or "Not in Accounts"; pastes
 * sit together under "Pastes".
 */
export function groupLines(plan: TaskPlan, ticks: Ticks): readonly LineGroup[] {
  const groups = new Map<string, { title: string; lines: TaskPlanLine[] }>();
  const add = (key: string, title: string, line: TaskPlanLine): void => {
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { title, lines: [line] });
    else group.lines.push(line);
  };
  for (const line of plan.lines) {
    if (!isSignIn(line)) {
      add('pastes', 'Pastes', line);
      continue;
    }
    if (line.candidates.length === 0) {
      add('none', 'Not in Accounts', line);
      continue;
    }
    const picked = pickedCandidate(line, ticks[line.line]);
    if (picked === undefined) add('choose', 'Choose an account', line);
    else add(`account:${picked.account.id}`, candidateName(picked), line);
  }
  return [...groups.entries()].map(([key, group]) => ({ key, title: group.title, lines: group.lines }));
}

/** What a line is about, in plain words, from the daemon's resolved facts and never the ferret's. */
export function lineTitle(line: TaskPlanLine, tick?: LineTick): string {
  if (line.kind === 'paste') return `Paste from ${fromTo(line)}`;
  const place = (pickedCandidate(line, tick) ?? line.candidates[0])?.place;
  const where = place === undefined ? 'a place not in Accounts' : placeLabel(place);
  const fields = line.fields.map(field => (field === 'totp' ? 'code' : field));
  const what = fields.length === 1 ? (fields[0] ?? '') : `${fields.slice(0, -1).join(', ')} and ${fields.at(-1) ?? ''}`;
  return line.kind === 'terminal-sign-in' ? `Type the password ${where}` : `Fill ${what} ${where}`;
}

const fromTo = (line: PasteLine): string => {
  const from =
    line.from.kind === 'command'
      ? `what ${line.from.program} prints`
      : line.from.kind === 'browser'
        ? `text on ${line.from.origin}`
        : `the clipboard of ${line.from.origin}`;
  const to =
    line.to.kind === 'terminal'
      ? `${line.to.program} in a terminal`
      : line.to.kind === 'browser'
        ? `a field on ${line.to.origin}`
        : `the secret ${line.to.name}`;
  return `${from} → ${to}`;
};

// ── Where a plan stands ──────────────────────────────────────────────────────────────────────────────

/** A line's state as the owner reads it. */
export const LINE_STATE_WORDS = {
  waiting: 'Waiting for you',
  approved: 'Allowed',
  declined: 'Not allowed',
  unavailable: 'Can’t be pre-approved',
  'used-up': 'All uses spent',
  stopped: 'Stopped',
  ended: 'Ended',
} as const satisfies Record<TaskPlanLine['state'], string>;

/** The line's uses left, once approved. */
export function remainingOf(line: TaskPlanLine): number | undefined {
  return line.kind === 'paste' ? line.remaining : line.approved?.remaining;
}

/** The lines in force: approved with a use left. */
const liveLines = (plan: TaskPlan): readonly TaskPlanLine[] =>
  plan.state === 'approved' ? plan.lines.filter(line => line.state === 'approved') : [];

/** What a settled plan says at the top of its card. */
export function settledWords(plan: TaskPlan): string {
  const allowed = plan.lines.filter(line => line.state === 'approved' || line.state === 'used-up');
  switch (plan.state) {
    case 'pending':
      return '';
    case 'approved':
      return `You allowed ${allowed.length === 1 ? 'line' : 'lines'} ${lineList(allowed.map(line => line.line))} until ${timeWords(plan.expiresAt)}.`;
    case 'declined':
      return 'Declined: each fill and paste will ask you.';
    case 'revoked':
      return 'Revoked: each fill and paste will ask you.';
    case 'expired':
      return 'This plan ended on time: each fill and paste will ask you.';
    case 'ended':
      return 'This plan ended with its session: each fill and paste will ask you.';
  }
}

/** A failed route's sentence for the owner. */
export function failureWords(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export const isPlanLive = (plan: TaskPlan): boolean =>
  plan.state === 'pending' || (plan.state === 'approved' && liveLines(plan).length > 0);

// ── Ticking a line ───────────────────────────────────────────────────────────────────────────────────

/** A line that asked for nothing but a code: ticking it IS the code tick, and says so. */
export const codeOnly = (line: TaskPlanLine): boolean =>
  isSignIn(line) && line.fields.length === 1 && line.fields[0] === 'totp';

/** The ticks after the owner ticks or unticks one line. Unticking also drops the code tick; the pick stays. */
export function withTicked(plan: TaskPlan, ticks: Ticks, lineNumber: number, on: boolean): Ticks {
  const line = plan.lines[lineNumber];
  const tick = ticks[lineNumber];
  if (line === undefined || tick === undefined) return ticks;
  if (on && !mayTick(line, tick)) return ticks;
  const totp = on && codeOnly(line) && totpState(line, tick) === 'available';
  return { ...ticks, [lineNumber]: { ...tick, ticked: on, totp: on ? totp || tick.totp : false } };
}

/** The ticks after the owner picks an account: a changed pick unticks the line, so a tick never survives a different account. */
export function withPick(ticks: Ticks, lineNumber: number, signIn: SignInId | undefined): Ticks {
  const tick = ticks[lineNumber];
  if (tick === undefined) return ticks;
  const { signIn: _before, ...rest } = tick;
  return {
    ...ticks,
    [lineNumber]: { ...rest, ticked: false, totp: false, ...(signIn === undefined ? {} : { signIn }) },
  };
}

/** The ticks after the owner ticks or unticks a line's code. Only a ticked line can have one. */
export function withCode(plan: TaskPlan, ticks: Ticks, lineNumber: number, on: boolean): Ticks {
  const line = plan.lines[lineNumber];
  const tick = ticks[lineNumber];
  if (line === undefined || tick === undefined) return ticks;
  if (on && (!tick.ticked || totpState(line, tick) !== 'available')) return ticks;
  return { ...ticks, [lineNumber]: { ...tick, totp: on } };
}

// ── The approval itself: stage → passkey → commit ────────────────────────────────────────────────────

/** What the card shows while an approval is under way. */
export type ApprovalProgress = 'staging' | 'passkey' | 'committing';

export type ApprovalOutcome =
  | { readonly kind: 'settled'; readonly plan: TaskPlan }
  | { readonly kind: 'dismissed' }
  | { readonly kind: 'failed'; readonly words: string };

export interface ApprovalPorts {
  readonly client: TaskPlanClient;
  /**
   * Asks for the `approve-task-plan` passkey bound to the stage. `words` is the DAEMON's summary of the staged bytes,
   * one line each; nothing a ferret wrote reaches it. `undefined` when this device cannot ask.
   */
  readonly askPasskey: ((stage: TaskPlanStageId, words: string) => Promise<boolean>) | undefined;
  readonly report?: (progress: ApprovalProgress) => void;
}

const codeOf = (cause: unknown): string | undefined =>
  typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string'
    ? cause.code
    : undefined;

/** The sentence for a refused route, by the code the daemon answered with. */
function approvalFailureWords(cause: unknown): string {
  switch (codeOf(cause)) {
    case TASK_PLAN_ERROR_CODES.passkeyRequired:
      return 'Add a passkey in Settings › Security first: a sign-in line is approved with a passkey.';
    case TASK_PLAN_ERROR_CODES.stageNotFound:
      return STAGE_GONE_WORDS;
    default:
      return failureWords(cause);
  }
}

/** The passkey dialog's body: the daemon's lines, one per line. */
const summaryWords = (summary: readonly string[]): string => summary.join('\n');

/** Asks for the passkey bound to a stage and, once it is given, commits the stage. */
async function confirmStage(
  ports: ApprovalPorts,
  plan: Pick<TaskPlan, 'id' | 'sessionId'>,
  stage: TaskPlanStageId,
  summary: readonly string[],
  dropOnDismiss: boolean,
): Promise<ApprovalOutcome> {
  const { client, askPasskey, report } = ports;
  if (askPasskey === undefined) {
    if (dropOnDismiss) await dropStage(client, plan, stage).catch(() => undefined);
    return { kind: 'failed', words: NO_PASSKEY_DEVICE_WORDS };
  }
  report?.('passkey');
  let given: boolean;
  try {
    given = await askPasskey(stage, summaryWords(summary));
  } catch (cause) {
    if (dropOnDismiss) await dropStage(client, plan, stage).catch(() => undefined);
    return { kind: 'failed', words: failureWords(cause) };
  }
  if (!given) {
    // A stage the owner walked away from is not left waiting on this app: nothing was approved.
    if (dropOnDismiss) await dropStage(client, plan, stage).catch(() => undefined);
    return { kind: 'dismissed' };
  }
  report?.('committing');
  return { kind: 'settled', plan: await commitStage(client, plan, stage) };
}

/**
 * THE OWNER'S APPROVAL: stage the ticks, ask for the passkey bound to the stage (the dialog shows the daemon's summary),
 * then commit. A selection with no sign-in line is answered by the stage route at once. A dismissed passkey drops the
 * stage and approves nothing.
 */
export async function runApproval(
  ports: ApprovalPorts,
  plan: Pick<TaskPlan, 'id' | 'sessionId'>,
  approval: TaskPlanApproval,
): Promise<ApprovalOutcome> {
  try {
    ports.report?.('staging');
    const answer = await stageApproval(ports.client, plan, approval);
    if (answer.outcome === 'answered') return { kind: 'settled', plan: answer.plan };
    return await confirmStage(ports, plan, answer.staged.stage, answer.staged.summary, true);
  } catch (cause) {
    return { kind: 'failed', words: approvalFailureWords(cause) };
  }
}

/**
 * A SELECTION STAGED AT THE MACHINE, confirmed here: the stage is read back so the dialog shows the daemon's own summary
 * of it, then the same passkey and commit. A dismissed passkey leaves the machine's stage waiting (Deny drops it).
 */
export async function runMachineConfirm(
  ports: ApprovalPorts,
  plan: Pick<TaskPlan, 'id' | 'sessionId'>,
  stage: TaskPlanStageId,
): Promise<ApprovalOutcome> {
  try {
    ports.report?.('staging');
    const view = await readStage(ports.client, plan, stage);
    if (view.state !== 'waiting') return { kind: 'failed', words: STAGE_GONE_WORDS };
    return await confirmStage(ports, plan, stage, view.summary, false);
  } catch (cause) {
    return { kind: 'failed', words: approvalFailureWords(cause) };
  }
}
