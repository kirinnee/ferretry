import {
  AUTOMATED_CODE_WARNING,
  agendaDeepLinkFragment,
  DAEMON_FEATURES,
  namesSignIn,
  placeKeys,
  TASK_PLAN_FIRST_FILL_WORDS,
  TASK_PLAN_HONEST_LIMIT,
  TASK_PLAN_MAX_LINES,
  TASK_PLAN_STAGE_TTL_SECONDS,
  type TaskPlan,
  type TaskPlanApproval,
  type TaskPlanLine,
  taskPlanLineFirstFill,
  taskPlanRootHost,
  taskPlanRootWords,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { showUntrusted } from '../input/render.ts';
import { fromText, refuseFerret, toText, unique } from './controller.ts';
import type { PlanPorts } from './ports.ts';

/** Options every `fy plan` command accepts. */
export interface PlanCommandOptions {
  readonly session?: string | undefined;
  readonly json?: boolean | undefined;
}

/** `fy plan approve` flags. `pick` is `<line>=<account or si_…>` and `totp` a line number, each repeatable. */
export interface PlanApproveOptions extends PlanCommandOptions {
  readonly pick?: readonly string[] | undefined;
  readonly totp?: readonly string[] | undefined;
  /** `--i-understand-one-factor`: the owner read {@link AUTOMATED_CODE_WARNING}; `--totp` is refused without it. */
  readonly iUnderstandOneFactor?: boolean | undefined;
  /** Opens the plan's card in this host's browser once the selection is staged. */
  readonly open?: boolean | undefined;
}

const POLL_MS = 1_000;
const LISTING = 'plan ls';

const lineWords = (line: TaskPlanLine): string => {
  if (line.kind === 'paste') return `paste ${fromText(line.from)} → ${toText(line.to)}`;
  const where = line.kind === 'terminal-sign-in' ? 'sign in at a terminal' : 'sign in on a page';
  const who =
    line.candidates.length === 0
      ? 'no saved account'
      : line.candidates
          .map(
            candidate =>
              `${showUntrusted(candidate.account.id)} (${showUntrusted(candidate.account.label)}) at ${placeKeys(candidate.place).join(', ')}${candidate.can.totp ? ', can make codes' : ''}`,
          )
          .join('; ');
  return `${where}: ${line.fields.join(', ')} — ${who}`;
};

const lineStatus = (line: TaskPlanLine): string => {
  if (line.state === 'approved' || line.state === 'used-up') {
    const left = line.kind === 'paste' ? line.remaining : line.approved?.remaining;
    return `${line.state}${left === undefined ? '' : `, ${String(left)} of ${String(line.uses)} left`}`;
  }
  return line.state;
};

/** Lines whose flags still matter: one the owner may tick, or one in force. */
const FLAGGED_STATES: ReadonlySet<TaskPlanLine['state']> = new Set(['waiting', 'approved']);

/**
 * The daemon's flags on a sign-in line, in the protocol's words, one a line under it: root (red), the one-factor code
 * (red) and the first fill (amber), as the plan's card draws them. The account the line is approved for decides the
 * root host and the first fill once there is one; the line's own candidates decide while there is none.
 */
function lineFlags(line: TaskPlanLine): readonly string[] {
  if (line.kind === 'paste' || !FLAGGED_STATES.has(line.state)) return [];
  const picked = line.approved?.signIn;
  const places = line.candidates.filter(each => picked === undefined || each.signIn === picked).map(each => each.place);
  const number = String(line.line + 1);
  return [
    ...(line.kind === 'terminal-sign-in' || line.flags.includes('root')
      ? [taskPlanRootWords(taskPlanRootHost(places))]
      : []),
    ...(line.approved?.totp === true
      ? [AUTOMATED_CODE_WARNING]
      : line.state === 'waiting' && line.flags.includes('one-factor')
        ? [`with --totp ${number}: ${AUTOMATED_CODE_WARNING}`]
        : []),
    ...(taskPlanLineFirstFill(line, picked) ? [TASK_PLAN_FIRST_FILL_WORDS] : []),
  ].map(words => `      ! ${words}`);
}

function renderPlan(plan: TaskPlan): string {
  const lines = plan.lines.flatMap(line => [
    `   ${String(line.line + 1)}. [${lineStatus(line)}] ${lineWords(line)}  the ferret says: ${showUntrusted(line.why)}`,
    ...lineFlags(line),
  ]);
  return [
    `${plan.id.slice(0, 8)}  !${plan.agendaItemId}  ${plan.state}  session ${plan.sessionId}  until ${plan.expiresAt}`,
    ...lines,
  ].join('\n');
}

const lineList = (lines: readonly number[]): string => lines.map(line => String(line + 1)).join(', ');

/**
 * `--totp` needs `--i-understand-one-factor`, the same rule and words as `fy rules`: a ticked code makes the sign-in
 * one factor, so it is never ticked by a flag alone. One without the other is refused before anything is read.
 */
function acknowledged(options: PlanApproveOptions): void {
  const codes = (options.totp ?? []).length > 0;
  if (codes && options.iUnderstandOneFactor !== true)
    throw new Error(
      `--totp makes the sign-in one factor. ${AUTOMATED_CODE_WARNING} Add --i-understand-one-factor to go on.`,
    );
  if (!codes && options.iUnderstandOneFactor === true)
    throw new Error('--i-understand-one-factor goes with --totp only');
}

/** `3` as the owner reads it, line 2 as the daemon numbers it. */
function lineNumber(text: string, plan: TaskPlan, flag: string): number {
  const number = Number(text.trim());
  if (!Number.isInteger(number) || number < 1 || number > Math.min(plan.lines.length, TASK_PLAN_MAX_LINES))
    throw new Error(`${flag} "${text}" is not one of the plan's lines 1 to ${String(plan.lines.length)}`);
  return number - 1;
}

/**
 * Drives `fy plan` (and its alias `fy copy plan`): the owner reads the plans ferrets raised, stages the lines to allow
 * and revokes. A sign-in line is NEVER approved here: it is staged, shown on the plan's own card, and committed by a
 * passkey in the app. There is no commit call in {@link IPlanGateway} for this to make, and the machine's token could
 * not make its proof anyway. Refused inside a ferret's pane, and again by the daemon.
 */
export class PlanController {
  constructor(private readonly ports: PlanPorts) {}

  async list(options: PlanCommandOptions): Promise<void> {
    refuseFerret(this.ports);
    const { plans } = await this.ports.gateway.plans(options.session?.trim() || undefined);
    this.ports.out.success(
      options.json === true
        ? JSON.stringify({ plans }, null, 2)
        : plans.length === 0
          ? 'no plans are waiting'
          : [...plans.map(renderPlan), '', TASK_PLAN_HONEST_LIMIT].join('\n'),
    );
  }

  /**
   * Allows the numbered lines (1-based, as listed); none declines the plan. Nothing is sent unless every named line,
   * pick and code tick is one this plan lists.
   */
  async approve(reference: string, numbers: readonly string[], options: PlanApproveOptions): Promise<void> {
    refuseFerret(this.ports);
    acknowledged(options);
    const plan = await this.#plan(reference);
    if (plan.state !== 'pending') throw new Error(`the plan ${plan.id.slice(0, 8)} is ${plan.state}, not waiting`);
    const approval = this.#approval(plan, numbers, options);
    if (
      approval.lines.some(tick => plan.lines[tick.line]?.kind !== 'paste') &&
      !(await this.ports.gateway.features()).includes(DAEMON_FEATURES.taskPlan)
    )
      throw new Error(
        'a sign-in line can only be confirmed on the plan card in the app, and this daemon does not report that card yet: nothing was staged',
      );
    const answer = await this.ports.gateway.stage(plan.sessionId, plan.id, approval);
    // Answered at once only for a decline, or by a daemon from before every tick needed the passkey (!A244).
    if (answer.outcome === 'answered') {
      this.ports.out.success(
        options.json === true ? JSON.stringify(answer.plan, null, 2) : this.#answered(answer.plan, approval),
      );
      return;
    }
    const { staged } = answer;
    const say = (message: string): void =>
      options.json === true ? this.ports.out.diagnostic(message) : this.ports.out.success(message);
    for (const words of staged.summary) say(`  ${showUntrusted(words)}`);
    say(TASK_PLAN_HONEST_LIMIT);
    const card = await this.ports.gateway.confirmInApp(plan.sessionId, plan.id, staged.stage);
    say(
      `Confirm it with your passkey on the plan's card !${card.agendaItemId} in the app's Inbox (session ${plan.sessionId}).\nNothing is approved until you do; waiting up to ${String(TASK_PLAN_STAGE_TTL_SECONDS / 60)} minutes…`,
    );
    await this.#showCard(plan, card.agendaItemId, options, say);
    const state = await this.#wait(plan, staged.stage);
    const inForce = state === 'approved' ? undefined : await this.#inForce(plan);
    const final = inForce === undefined ? { state } : { state: 'approved' as const, plan: inForce };
    this.ports.out.success(
      options.json === true
        ? JSON.stringify(final, null, 2)
        : inForce === undefined
          ? OUTCOME[state](plan)
          : `Approved in the app. Line ${lineList(inForce.lines.filter(line => line.state === 'approved').map(line => line.line))} of the plan ${plan.id.slice(0, 8)} are in force; each goes through for the uses it asked.`,
    );
  }

  /** Prints the link that opens the plan's card, and opens it with `--open`. It carries no secret: it only picks a card. */
  async #showCard(
    plan: TaskPlan,
    agendaItemId: string,
    options: PlanApproveOptions,
    say: (message: string) => void,
  ): Promise<void> {
    const { appOrigin, appOriginNote, openLink } = this.ports;
    if (appOrigin === undefined) {
      if (options.open === true) say('--open has nowhere to open: this machine does not know the app address.');
      return;
    }
    const link = `${appOrigin.replace(/\/+$/u, '')}/${agendaDeepLinkFragment(agendaItemId, plan.sessionId)}`;
    if (appOriginNote !== undefined) say(appOriginNote);
    say(`Open the card: ${link}`);
    if (options.open !== true) return;
    say(
      openLink !== undefined && (await openLink(link))
        ? 'Opened it in your browser.'
        : 'Could not open a browser here; use the link above.',
    );
  }

  /** Ends the numbered lines of a plan (every line when none is named). It only narrows: no passkey. */
  async revoke(reference: string, numbers: readonly string[], options: PlanCommandOptions): Promise<void> {
    refuseFerret(this.ports);
    const plan = await this.#plan(reference);
    const lines = [...new Set(numbers.map(number => lineNumber(number, plan, 'line')))];
    const revoked = await this.ports.gateway.revoke(plan.sessionId, plan.id, lines.length === 0 ? undefined : lines);
    this.ports.out.success(
      options.json === true
        ? JSON.stringify(revoked, null, 2)
        : lines.length === 0
          ? `Revoked the plan ${plan.id.slice(0, 8)}: every line is ended.`
          : `Revoked line ${lineList(lines)} of the plan ${plan.id.slice(0, 8)}.`,
    );
  }

  /** The approval to send, or the reason it can't be: checked in full before anything is staged. */
  #approval(plan: TaskPlan, numbers: readonly string[], options: PlanApproveOptions): TaskPlanApproval {
    const ticked = [...new Set(numbers.map(number => lineNumber(number, plan, 'line')))].sort((x, y) => x - y);
    const picks = new Map<number, string>();
    for (const pick of options.pick ?? []) {
      const [text, ...rest] = pick.split('=');
      const account = rest.join('=').trim();
      if (text === undefined || account === '') throw new Error(`--pick "${pick}" is not <line>=<account or si_…>`);
      const line = lineNumber(text, plan, '--pick');
      if (!ticked.includes(line))
        throw new Error(`--pick names line ${String(line + 1)}, which you did not list to allow`);
      if (picks.has(line)) throw new Error(`--pick names line ${String(line + 1)} twice`);
      picks.set(line, account);
    }
    const codes = new Set<number>();
    for (const text of options.totp ?? []) {
      const line = lineNumber(text, plan, '--totp');
      if (!ticked.includes(line))
        throw new Error(`--totp names line ${String(line + 1)}, which you did not list to allow`);
      codes.add(line);
    }
    return {
      lines: ticked.map(line => {
        const entry = plan.lines[line] as TaskPlanLine;
        const label = `line ${String(line + 1)}`;
        if (entry.state !== 'waiting') throw new Error(`${label} can't be allowed: it is ${entry.state}`);
        if (entry.kind === 'paste') {
          if (picks.has(line) || codes.has(line))
            throw new Error(`${label} is a paste: it has no account or code to pick`);
          return { line };
        }
        const wanted = picks.get(line);
        const candidate =
          wanted === undefined
            ? entry.candidates.length === 1
              ? entry.candidates[0]
              : undefined
            : this.#candidate(entry, wanted, label);
        if (candidate === undefined)
          throw new Error(
            `${label} has ${entry.candidates.length === 0 ? 'no account to sign in with' : 'more than one account'}: ${entry.candidates.length === 0 ? 'save one in Accounts first' : `choose with --pick ${String(line + 1)}=<account or si_…> (${entry.candidates.map(c => c.account.id).join(', ')})`}`,
          );
        if (codes.has(line) && !entry.fields.includes('totp'))
          throw new Error(`${label}: the ferret did not ask for codes`);
        if (codes.has(line) && !candidate.can.totp)
          throw new Error(`${label}: ${candidate.account.id} has no automatic codes`);
        return { line, signIn: candidate.signIn, ...(codes.has(line) ? { totp: true } : {}) };
      }),
    };
  }

  #candidate(
    line: Extract<TaskPlanLine, { readonly candidates: unknown }>,
    wanted: string,
    label: string,
  ): (typeof line.candidates)[number] {
    const found = line.candidates.filter(candidate =>
      namesSignIn(wanted) ? candidate.signIn === wanted : candidate.account.id === wanted,
    );
    if (found.length === 0)
      throw new Error(
        `${label}: "${wanted}" is not one of its accounts (${line.candidates.map(c => c.account.id).join(', ')}): nothing was staged`,
      );
    if (found.length > 1)
      throw new Error(`${label}: "${wanted}" has more than one sign-in here: name one by its si_… id`);
    return found[0] as (typeof line.candidates)[number];
  }

  #answered(plan: TaskPlan, approval: TaskPlanApproval): string {
    const id = plan.id.slice(0, 8);
    if (approval.lines.length === 0 || plan.state === 'declined') return `Declined the plan ${id}.`;
    return `Allowed line ${lineList(approval.lines.map(tick => tick.line))} of the plan ${id}: each goes through for the uses it asked, until ${plan.expiresAt}.`;
  }

  /** The plan as the daemon holds it now, when the owner answered it in the app by another stage than this one. */
  async #inForce(plan: TaskPlan): Promise<TaskPlan | undefined> {
    const { plans } = await this.ports.gateway.plans(plan.sessionId);
    return plans.find(found => found.id === plan.id && found.state === 'approved');
  }

  async #wait(plan: TaskPlan, stage: string): Promise<keyof typeof OUTCOME> {
    const until = this.ports.nowMs() + (TASK_PLAN_STAGE_TTL_SECONDS + 5) * 1_000;
    for (;;) {
      const view = await this.ports.gateway.view(plan.sessionId, plan.id, stage).catch((error: unknown) => {
        if (error instanceof FyHttpError && error.status === 404) return undefined;
        throw error;
      });
      if (view === undefined) return 'expired';
      if (view.state !== 'waiting') return view.state;
      if (this.ports.nowMs() >= until) return 'expired';
      await this.ports.sleep(POLL_MS);
    }
  }

  async #plan(reference: string): Promise<TaskPlan> {
    const { plans } = await this.ports.gateway.plans();
    return unique(
      plans.filter(candidate => candidate.id.startsWith(reference.trim())),
      reference,
      'plan',
      LISTING,
    );
  }
}

const OUTCOME: Readonly<Record<'approved' | 'denied' | 'expired', (plan: TaskPlan) => string>> = {
  approved: plan =>
    `Approved. The plan ${plan.id.slice(0, 8)} is in force; each line goes through for the uses it asked.`,
  denied: plan => `Denied. Nothing on the plan ${plan.id.slice(0, 8)} was approved.`,
  expired: plan => `Timed out. Nothing on the plan ${plan.id.slice(0, 8)} was approved; run the command again.`,
};
