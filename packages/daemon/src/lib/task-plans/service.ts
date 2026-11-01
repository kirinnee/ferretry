import { randomBytes } from 'node:crypto';
import {
  type AccountId,
  type AccountKey,
  type AuditActor,
  type AuditDetail,
  type CopyPlan,
  type CopyPlanItem,
  copyPlanOf,
  type SignInChoiceContext,
  type SignInId,
  TASK_PLAN_DEFAULT_LIFETIME_SECONDS,
  TASK_PLAN_ERROR_CODES,
  TASK_PLAN_MAX_LIVE_PER_SESSION,
  TASK_PLAN_MAX_PENDING_PER_SESSION,
  TASK_PLAN_MAX_PROPOSALS_PER_HOUR,
  TASK_PLAN_STAGE_TTL_SECONDS,
  TASK_PLAN_WHY_MAX_CHARS,
  type TaskPlan,
  type TaskPlanApproval,
  type TaskPlanApprovalAnswer,
  TaskPlanApprovalSchema,
  TaskPlanCallSchema,
  type TaskPlanConfirming,
  type TaskPlanLine,
  type TaskPlanLineAsk,
  type TaskPlanLinePins,
  type TaskPlanSelectedLine,
  TaskPlanSchema,
  type TaskPlanStaged,
  type TaskPlanStageId,
  type TaskPlanStageState,
  type TaskPlanStageView,
  type TaskPlanState,
  taskPlanApprovalSubject,
  taskPlanLineOfCopyItem,
  taskPlanLinesOfCopyItems,
  taskPlanSelection,
  taskPlanSelectionNeedsPasskey,
} from '@ferretry/protocol';
import type { AuditSink } from '../audit/types.ts';
import { SecureCopyError } from '../secure-copy/errors.ts';
import type { PasteRuleCaller, PasteRuleService } from '../secure-copy/rules.ts';
import { boundSelection, type PlanListing, PlanAskMismatch, pinsOf, repeatedSignIn, resolveLine } from './resolve.ts';
import {
  answeredNote,
  answeredTell,
  lineList,
  planAsk,
  planContext,
  planHowToResolve,
  routeOf,
  selectedWords,
} from './words.ts';

/**
 * A FERRET'S TASK PLAN (docs/secure-copy.md, "Task plans"): one card, raised before a task, on which the owner
 * pre-approves its sign-ins and its pastes.
 *
 * ## RAM ONLY, ONE SESSION, NO GROWTH
 *
 * Plans, their staged selections and the pins of every ticked line live in this object's maps: no journal, no file. A
 * restart forgets them, so every fill and paste asks again. A plan belongs to the session that raised it (its id comes
 * from the ferret's credential, never a body), ends at its expiry, when it is revoked and when its session ends, and is
 * never edited: there is no change to a plan's lines, and asking for more is a new plan. At most
 * {@link TASK_PLAN_MAX_PENDING_PER_SESSION} wait and {@link TASK_PLAN_MAX_LIVE_PER_SESSION} are in force per session,
 * and a session raises at most {@link TASK_PLAN_MAX_PROPOSALS_PER_HOUR} an hour.
 *
 * ## ONLY THE OWNER ANSWERS, AND A SIGN-IN NEEDS THE PASSKEY
 *
 * Every owner method takes a {@link PasteRuleCaller} and refuses `{ kind: 'agent' }` before anything else: the routes
 * refuse a ferret before the body, and this is the second wall. The owner can only NARROW what was asked
 * (`taskPlanSelection`). A selection of paste lines only is answered at once, as a paste plan always was. Any ticked
 * sign-in line is STAGED with its pins and committed only with a fresh `approve-task-plan` proof bound to
 * `taskPlanApprovalSubject(stage, canonical)`, from every caller, the machine too: the machine's token holds no passkey.
 *
 * ## NOTHING READ FROM A PAGE BECOMES A LINE
 *
 * {@link TaskPlanService.propose} takes the ferret's call and nothing else: no page, no terminal, no facts. A line is a
 * lookup key resolved against the owner's own accounts.
 */

/** The plan's card, as the agenda raises it. Only the daemon raises one; the card itself approves nothing. */
export interface TaskPlanCard {
  readonly planId: string;
  /** The plan has paste lines: an app from before task plans answers them on the paste-plan card. */
  readonly pastes: boolean;
  readonly ask: string;
  readonly context: string;
  readonly howToResolve: string;
  readonly expiresAt: string;
}

/** The agenda, as a plan needs it: raise its card, close it when the plan is settled. */
export interface TaskPlanAgendaPort {
  raise(sessionId: string, card: TaskPlanCard): Promise<{ ok: true; id: string } | { ok: false; message: string }>;
  close(sessionId: string, id: string, note: string): Promise<void>;
}

/** The account store, as a plan reads it: the listing, and an account's immutable key. Never a value. */
export interface TaskPlanAccountsPort {
  /** Rejects when the store cannot tell: a plan with a sign-in line is then not raised. */
  listing(): Promise<PlanListing>;
  keyOf(account: AccountId): Promise<AccountKey | undefined>;
}

export interface TaskPlanPorts {
  readonly agenda: TaskPlanAgendaPort;
  readonly rules: Pick<PasteRuleService, 'fromPlan' | 'endPlan' | 'planUses'>;
  readonly accounts: TaskPlanAccountsPort;
  /** The calling session's project, folder and the owner's defaults: they only ORDER the accounts found. */
  readonly choice?: { of(sessionId: string): Promise<Omit<SignInChoiceContext, 'hint'>> };
  /** Whether any paired device holds a passkey. None: no sign-in line can be approved ("add a passkey first"). */
  readonly passkeys: { any(): Promise<boolean> };
  /** The vault redactor: a ferret's reason is masked before it is kept or shown. */
  readonly redact: (text: string) => Promise<string>;
  /** Tells the ferret how its plan was settled, in words with no value. Total: never rejects. */
  readonly tell: (sessionId: string, agendaId: string, message: string) => Promise<void>;
  readonly audit: AuditSink;
  readonly clock: { now(): number };
  readonly ids: { planId(): string; stageId?(): TaskPlanStageId };
}

/** Why a plan route refuses with a next step of its own (`stage_not_found`, `passkey_required`, `needs_passkey`). */
export class TaskPlanError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TaskPlanError';
  }
}

/** The commit was asked without a passkey proof bound to its stage: the route answers the step-up demand. */
export class TaskPlanProofMissing extends Error {
  constructor() {
    super(
      'approving a sign-in on a task plan needs a passkey confirmation for this one selection, from a paired device',
    );
    this.name = 'TaskPlanProofMissing';
  }
}

/** A ticked sign-in line in force, with what it was pinned to: what a fill is matched against (R3a-4). */
export interface ApprovedSignInLine {
  readonly planId: string;
  readonly sessionId: string;
  readonly line: number;
  readonly kind: 'sign-in' | 'terminal-sign-in';
  readonly signIn: SignInId;
  readonly fields: readonly string[];
  readonly remaining: number;
  readonly pins: TaskPlanLinePins;
  readonly expiresAt: number;
}

interface Stage {
  readonly id: TaskPlanStageId;
  readonly planId: string;
  readonly sessionId: string;
  readonly approval: TaskPlanApproval;
  readonly canonical: string;
  readonly lines: readonly TaskPlanSelectedLine[];
  readonly pins: ReadonlyMap<number, TaskPlanLinePins>;
  readonly summary: readonly string[];
  /** Who staged it: a paired device may answer any stage (the owner's passkey lives there), the machine only its own. */
  readonly owner: string;
  readonly expiresAtMs: number;
  state: TaskPlanStageState;
  committing?: boolean;
}

const STAGE_TTL_MS = TASK_PLAN_STAGE_TTL_SECONDS * 1_000;
/** How long a finished stage still answers its state, so `fy plan approve` reads "Approved" rather than "gone". */
const FINISHED_STAGE_KEPT_MS = STAGE_TTL_MS;
/** How long a settled plan stays listed after its expiry. */
const SETTLED_PLAN_KEPT_MS = 10 * 60_000;
const HOUR_MS = 60 * 60_000;
/** Most plans one listing answers. */
const MAX_LISTED = 100;
/** States in which a plan still holds something: a card to answer, or lines in force. */
const OPEN_STATES: ReadonlySet<TaskPlanState> = new Set(['pending', 'approved']);

const randomStageId = (): TaskPlanStageId => `tps_${randomBytes(12).toString('hex')}`;

/** The caller's key: a paired device by its id, the owner at the machine as one. */
const ownerKey = (caller: Extract<PasteRuleCaller, { kind: 'owner' }>): string =>
  caller.actor.kind === 'device' ? `device:${caller.actor.deviceId}` : 'host';

function requireOwner(caller: PasteRuleCaller): Extract<PasteRuleCaller, { kind: 'owner' }> {
  if (caller.kind !== 'owner')
    throw new SecureCopyError('forbidden', 'only the owner answers a task plan; a ferret cannot');
  return caller;
}

/** A reason as the card may show it: masked, one line, no control or format character, at most 140 characters. */
function oneLineWhy(text: string): string {
  const flat = text
    .replaceAll(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replaceAll(/\s+/gu, ' ')
    .trim();
  const clipped = flat.length <= TASK_PLAN_WHY_MAX_CHARS ? flat : `${flat.slice(0, TASK_PLAN_WHY_MAX_CHARS - 1)}…`;
  return clipped === '' ? '(no reason given)' : clipped;
}

/** An audit text value: one line, 1–160 characters. */
const auditText = (text: string): string => {
  const flat = text.replaceAll(/[\p{Cc}\p{Cf}]+/gu, ' ').trim();
  return flat === '' ? 'none' : flat.length <= 160 ? flat : `${flat.slice(0, 159)}…`;
};

const numbers = (lines: readonly number[]): string =>
  lines.length === 0 ? 'none' : lines.map(line => String(line + 1)).join(',');

const auditActor = (caller: Extract<PasteRuleCaller, { kind: 'owner' }>): AuditActor =>
  caller.actor.kind === 'device' ? { kind: 'device', deviceId: caller.actor.deviceId } : { kind: 'host' };

/** The lines a settled plan holds in force: ticked, with uses left or spent. */
const tickedLines = (plan: TaskPlan): readonly number[] =>
  plan.lines.filter(line => line.state === 'approved' || line.state === 'used-up').map(line => line.line);

export class TaskPlanService {
  readonly #plans = new Map<string, TaskPlan>();
  /** The pins of every ticked sign-in line in force, by plan and line. Dropped with the line. */
  readonly #pins = new Map<string, Map<number, TaskPlanLinePins>>();
  readonly #stages = new Map<TaskPlanStageId, Stage>();
  /** Plans an answer is being recorded for, so a double tap or a retry cannot make their rules twice. */
  readonly #answering = new Set<string>();
  /** When each session raised its plans in the last hour. */
  readonly #raised = new Map<string, number[]>();
  readonly #newStageId: () => TaskPlanStageId;

  constructor(private readonly ports: TaskPlanPorts) {
    this.#newStageId = ports.ids.stageId?.bind(ports.ids) ?? randomStageId;
  }

  // ── The ferret asks ───────────────────────────────────────────────────────────────────────────────

  /**
   * THE FERRET ASKS: the call's lines and expiry, and nothing else (no page, no terminal, no facts). Each line is
   * resolved against the owner's accounts, and ONE card is raised from what was resolved. Refused whole, with no card:
   * a call the schema refuses, two lines for one sign-in, a sign-in of the other kind, too many plans waiting or in
   * force, or too many raised this hour.
   */
  async propose(
    sessionId: string,
    call: { readonly lines: readonly unknown[]; readonly expiresInSeconds?: number | undefined },
  ): Promise<TaskPlan> {
    const parsed = TaskPlanCallSchema.safeParse({ tool: 'task.plan', ...call });
    if (!parsed.success)
      throw new SecureCopyError(
        'bad_request',
        `the plan is not usable: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
      );
    const asks: readonly TaskPlanLineAsk[] = parsed.data.lines;
    this.sweep();
    const now = this.ports.clock.now();
    this.#assertRoom(sessionId, now);
    const signIns = asks.some(ask => ask.kind !== 'paste');
    const listing = signIns
      ? await this.ports.accounts.listing().catch(() => {
          throw new SecureCopyError('unavailable', 'the accounts could not be read, so no sign-in can be planned now');
        })
      : { accounts: [], signIns: [] };
    const choice = signIns ? await (this.ports.choice?.of(sessionId).catch(() => ({})) ?? {}) : {};
    const whys = await Promise.all(
      asks.map(async ask => oneLineWhy(await this.ports.redact(ask.why).catch(() => '(reason withheld)'))),
    );
    let lines: TaskPlanLine[];
    try {
      lines = asks.map((ask, index) => resolveLine(ask, index, whys[index] ?? '', listing, choice));
    } catch (error) {
      throw error instanceof PlanAskMismatch ? new SecureCopyError('bad_request', error.message) : error;
    }
    const repeated = repeatedSignIn(lines);
    if (repeated !== undefined)
      throw new SecureCopyError(
        'bad_request',
        `line ${String(repeated + 1)} names a sign-in another line already names: one sign-in, one line`,
      );
    const id = this.ports.ids.planId();
    const expiresAt = new Date(
      now + (parsed.data.expiresInSeconds ?? TASK_PLAN_DEFAULT_LIFETIME_SECONDS) * 1000,
    ).toISOString();
    // The record's own rules, checked before any card is raised: a line resolved into something it refuses is a bug.
    const draft = TaskPlanSchema.parse({
      v: 1,
      id,
      sessionId,
      agendaItemId: 'A1',
      lines,
      state: 'pending',
      raisedAt: new Date(now).toISOString(),
      expiresAt,
    } satisfies TaskPlan);
    const card = await this.ports.agenda.raise(sessionId, {
      planId: id,
      pastes: lines.some(line => line.kind === 'paste'),
      ask: planAsk(draft),
      context: planContext(draft),
      howToResolve: planHowToResolve(draft),
      expiresAt,
    });
    if (!card.ok) throw new SecureCopyError('unavailable', card.message);
    const plan = TaskPlanSchema.parse({ ...draft, agendaItemId: card.id });
    this.#plans.set(id, plan);
    this.#raised.set(sessionId, [...(this.#raised.get(sessionId) ?? []), now]);
    await this.#auditRaised(plan);
    return plan;
  }

  /** A paste plan (`secure.preapprove`), through the same {@link propose}: paste lines of one use each. */
  async proposePastes(sessionId: string, items: readonly CopyPlanItem[], expiresInSeconds?: number): Promise<CopyPlan> {
    if (items.length === 0) throw new SecureCopyError('bad_request', 'a plan lists 1 to 10 pastes');
    const plan = await this.propose(sessionId, {
      lines: [...taskPlanLinesOfCopyItems(items)],
      ...(expiresInSeconds === undefined ? {} : { expiresInSeconds }),
    });
    const projected = copyPlanOf(plan);
    if (projected === undefined) throw new SecureCopyError('bad_request', 'a plan lists 1 to 10 pastes');
    return projected;
  }

  // ── The owner reads ───────────────────────────────────────────────────────────────────────────────

  /** Every plan held, newest first, for one session or all. Owner only. */
  list(caller: PasteRuleCaller, sessionId?: string): readonly TaskPlan[] {
    requireOwner(caller);
    this.sweep();
    return [...this.#plans.values()]
      .filter(plan => sessionId === undefined || plan.sessionId === sessionId)
      .map(plan => this.#current(plan))
      .sort((left, right) => Date.parse(right.raisedAt) - Date.parse(left.raisedAt))
      .slice(0, MAX_LISTED);
  }

  /** One plan of one session. Owner only. Another session's plan reads as not found. */
  get(caller: PasteRuleCaller, sessionId: string, planId: string): TaskPlan {
    requireOwner(caller);
    this.sweep();
    return this.#current(this.#own(sessionId, planId));
  }

  /** The waiting plans as paste plans (`GET /v1/copy-plans`): those with paste lines, their paste lines only. */
  copyPlans(caller: PasteRuleCaller, sessionId?: string): readonly CopyPlan[] {
    return this.list(caller, sessionId)
      .filter(plan => plan.state === 'pending')
      .flatMap(plan => {
        const projected = copyPlanOf(plan);
        return projected === undefined ? [] : [projected];
      });
  }

  // ── The owner answers ─────────────────────────────────────────────────────────────────────────────

  /**
   * THE OWNER'S SELECTION. Nothing ticked declines the plan; paste lines only are approved at once (no passkey, as a
   * paste plan always was); any ticked sign-in line is STAGED: its pins snapshotted, its canonical bytes computed, and
   * held for {@link TASK_PLAN_STAGE_TTL_SECONDS} until a passkey bound to it commits it. One stage per plan: a new one
   * drops the old.
   */
  async stage(
    caller: PasteRuleCaller,
    sessionId: string,
    planId: string,
    approval: TaskPlanApproval,
  ): Promise<TaskPlanApprovalAnswer> {
    const owner = requireOwner(caller);
    this.sweep();
    const plan = this.#pending(sessionId, planId);
    const checked = TaskPlanApprovalSchema.safeParse(approval);
    if (!checked.success)
      throw new SecureCopyError('bad_request', checked.error.issues[0]?.message ?? 'the selection is not usable');
    const selection = taskPlanSelection(plan, checked.data);
    if (!selection.ok)
      throw new SecureCopyError(
        'bad_request',
        selection.line === undefined ? selection.reason : `line ${String(selection.line + 1)}: ${selection.reason}`,
      );
    if (!taskPlanSelectionNeedsPasskey(selection.lines))
      return { outcome: 'answered', plan: await this.#answer(owner, plan, selection.lines, 'none') };
    if (!(await this.ports.passkeys.any()))
      throw new TaskPlanError(
        409,
        TASK_PLAN_ERROR_CODES.passkeyRequired,
        'approving a sign-in on a task plan needs a passkey: add a passkey in Settings › Security first (paste lines can still be approved on their own)',
      );
    const pins = await this.#pinsFor(plan, selection.lines);
    const canonical = boundSelection(plan, checked.data, pins);
    // The plan may have been answered while the pins were read.
    const still = this.#pending(sessionId, planId);
    for (const held of this.#stages.values())
      if (held.planId === planId && held.state === 'waiting' && held.committing !== true) this.#finish(held, 'denied');
    const id = this.#freshStageId();
    const stage: Stage = {
      id,
      planId,
      sessionId,
      approval: checked.data,
      canonical: canonical.text,
      lines: canonical.lines,
      pins,
      summary: canonical.lines.map(line => selectedWords(line, still)),
      owner: ownerKey(owner),
      expiresAtMs: this.ports.clock.now() + STAGE_TTL_MS,
      state: 'waiting',
    };
    this.#stages.set(id, stage);
    return { outcome: 'staged', staged: this.#staged(stage) };
  }

  /**
   * What an `approve-task-plan` passkey for this stage is bound to, or nothing when no such stage is waiting. The
   * step-up options and the commit both read it here, so they cannot disagree.
   */
  boundSubjectOf(stage: TaskPlanStageId): string | undefined {
    this.sweep();
    const held = this.#stages.get(stage);
    return held?.state === 'waiting' && held.committing !== true
      ? taskPlanApprovalSubject(held.id, held.canonical)
      : undefined;
  }

  /** Where a staged selection stands, for `fy plan approve` waiting on the app. */
  viewStage(caller: PasteRuleCaller, sessionId: string, planId: string, stage: TaskPlanStageId): TaskPlanStageView {
    const owner = requireOwner(caller);
    this.sweep();
    const held = this.#ownStage(owner, sessionId, planId, stage, { finished: true });
    return { ...this.#staged(held), state: held.state };
  }

  /**
   * COMMITS a staged selection. `claim` is the route's claim on a fresh `approve-task-plan` proof bound to the subject
   * it is handed; without one this throws {@link TaskPlanProofMissing} and the stage keeps waiting. Then, all or
   * nothing: the paste lines' rules and the sign-in lines' grants are made together, or the plan stays pending.
   */
  async commit(
    caller: PasteRuleCaller,
    sessionId: string,
    planId: string,
    stage: TaskPlanStageId,
    claim: (subject: string) => boolean,
  ): Promise<TaskPlan> {
    const owner = requireOwner(caller);
    this.sweep();
    const held = this.#ownStage(owner, sessionId, planId, stage, { finished: false });
    const plan = this.#pending(sessionId, planId);
    // ONE COMMIT PER STAGE, decided before a proof is spent: a second commit racing this one finds it committing.
    if (held.committing === true) throw this.#stageGone();
    if (!claim(taskPlanApprovalSubject(held.id, held.canonical))) throw new TaskPlanProofMissing();
    held.committing = true;
    try {
      // The proof is bound to the stage's own bytes. A pending plan is never edited (only `machineStage`, which is not
      // bound, comes and goes), so the plan these bytes were made from is the plan answered here.
      const settled = await this.#answer(owner, plan, held.lines, 'passkey', held.pins);
      this.#finish(held, 'approved');
      return settled;
    } finally {
      held.committing = false;
    }
  }

  /** Drops a staged selection (the dialog dismissed, or Deny): nothing is approved. Never needs a passkey. */
  drop(caller: PasteRuleCaller, sessionId: string, planId: string, stage: TaskPlanStageId): void {
    const owner = requireOwner(caller);
    this.sweep();
    const held = this.#ownStage(owner, sessionId, planId, stage, { finished: false });
    if (held.committing === true) throw this.#stageGone();
    this.#finish(held, 'denied');
  }

  /**
   * Puts a selection staged at the machine (`fy plan approve`) on the plan's OWN card, for the passkey in the app: the
   * plan records it as `machineStage`, and no second card is raised. It approves nothing by itself.
   */
  confirmInApp(caller: PasteRuleCaller, sessionId: string, planId: string, stage: TaskPlanStageId): TaskPlanConfirming {
    const owner = requireOwner(caller);
    this.sweep();
    const held = this.#ownStage(owner, sessionId, planId, stage, { finished: false });
    const plan = this.#pending(sessionId, planId);
    this.#plans.set(
      planId,
      TaskPlanSchema.parse({
        ...plan,
        machineStage: {
          stage: held.id,
          lines: held.lines.map(line => line.line),
          askedAt: new Date(this.ports.clock.now()).toISOString(),
        },
      }),
    );
    return { stage: held.id, plan: planId, agendaItemId: plan.agendaItemId };
  }

  /**
   * The paste-plan approve route (`POST …/copy-plans/:pid/approve`): `items` are PASTE ITEM numbers, as
   * `copyPlanOf` numbers them, read back into plan lines through `taskPlanLineOfCopyItem` and never as line numbers,
   * so an old "approve item 0" can't land on sign-in line 0. Answers the old shape.
   */
  async approveCopyItems(
    caller: PasteRuleCaller,
    sessionId: string,
    planId: string,
    items: readonly number[],
  ): Promise<CopyPlan> {
    requireOwner(caller);
    this.sweep();
    const plan = this.#pending(sessionId, planId);
    const projected = copyPlanOf(plan);
    if (projected === undefined) throw this.#notFound();
    const lines = [...new Set(items)].map(item => taskPlanLineOfCopyItem(plan, item));
    if (lines.some(line => line === undefined))
      throw new SecureCopyError('bad_request', `the plan has ${String(projected.items.length)} items`);
    const approval = { lines: lines.map(line => ({ line: line as number })) };
    // Every line an item maps to is a paste line, so this is answered at once and never staged for a passkey.
    const answer = await this.stage(caller, sessionId, planId, approval);
    const settled = answer.outcome === 'answered' ? copyPlanOf(answer.plan) : undefined;
    if (settled === undefined) throw new SecureCopyError('conflict', 'the plan was not answered');
    return settled;
  }

  /**
   * REVOKE, one tap, no passkey (it only narrows): the named ticked lines end, or every line. A plan still waiting is
   * declined whole. Its pastes and its sign-in grants go at once.
   */
  async revoke(
    caller: PasteRuleCaller,
    sessionId: string,
    planId: string,
    lines?: readonly number[],
  ): Promise<TaskPlan> {
    const owner = requireOwner(caller);
    this.sweep();
    const plan = this.#current(this.#own(sessionId, planId));
    if (!OPEN_STATES.has(plan.state)) throw new SecureCopyError('conflict', `the plan is already ${plan.state}`);
    if (this.#answering.has(planId)) throw new SecureCopyError('conflict', 'the plan is being answered right now');
    if (plan.state === 'pending') {
      if (lines !== undefined)
        throw new SecureCopyError('bad_request', 'the plan is not answered yet: answer it, or revoke it whole');
      return await this.#end(plan, 'revoked', 'revoked', owner);
    }
    const ticked = tickedLines(plan);
    const ending = lines ?? ticked;
    if (ending.some(line => !ticked.includes(line)))
      throw new SecureCopyError('bad_request', 'only a line you allowed can be revoked');
    const left = ticked.filter(line => !ending.includes(line));
    if (left.length === 0) return await this.#end(plan, 'revoked', 'revoked', owner);
    this.ports.rules.endPlan(planId, ending);
    const pins = this.#pins.get(planId);
    for (const line of ending) pins?.delete(line);
    const narrowed = TaskPlanSchema.parse({
      ...plan,
      lines: plan.lines.map(line => (ending.includes(line.line) ? endedLine(line) : line)),
    });
    this.#plans.set(planId, narrowed);
    await this.#auditEnded(narrowed, 'revoked', ending, auditActor(owner));
    await this.ports.tell(
      sessionId,
      plan.agendaItemId,
      `${plan.agendaItemId}: the owner ended ${lineList(ending)} of your task plan; those ask them again.`,
    );
    return narrowed;
  }

  // ── Life ──────────────────────────────────────────────────────────────────────────────────────────

  /** A session ended: every plan it holds ends at once, its card closed, its pastes and grants gone. */
  async sessionEnded(sessionId: string): Promise<void> {
    for (const plan of [...this.#plans.values()])
      if (plan.sessionId === sessionId && OPEN_STATES.has(plan.state)) await this.#end(plan, 'ended', 'session-ended');
  }

  /** Sessions with a plan held, so the daemon's sweep can ask whether each has ended. */
  sessions(): readonly string[] {
    return [...new Set([...this.#plans.values()].map(plan => plan.sessionId))];
  }

  /** The ticked sign-in lines in force for a session, with their pins: what a fill is matched against. */
  approvedSignIns(sessionId: string): readonly ApprovedSignInLine[] {
    this.sweep();
    return [...this.#plans.values()].flatMap(plan => {
      if (plan.sessionId !== sessionId || plan.state !== 'approved') return [];
      const pins = this.#pins.get(plan.id);
      return plan.lines.flatMap(line => {
        const pinned = pins?.get(line.line);
        if (line.kind === 'paste' || line.state !== 'approved' || line.approved === undefined || pinned === undefined)
          return [];
        return [
          {
            planId: plan.id,
            sessionId,
            line: line.line,
            kind: line.kind,
            signIn: line.approved.signIn,
            fields: line.fields.filter(field => field !== 'totp' || line.approved?.totp === true).sort(),
            remaining: line.approved.remaining,
            pins: pinned,
            expiresAt: Date.parse(plan.expiresAt),
          },
        ];
      });
    });
  }

  /**
   * Ends the plans whose time passed (a pending one expires, an approved one ends), lets go of stages past their two
   * minutes, and forgets settled plans and finished stages a while later.
   */
  sweep(): void {
    const now = this.ports.clock.now();
    for (const stage of this.#stages.values()) {
      if (stage.state === 'waiting' && stage.committing !== true && stage.expiresAtMs <= now)
        this.#finish(stage, 'expired');
      else if (stage.state !== 'waiting' && stage.expiresAtMs + FINISHED_STAGE_KEPT_MS <= now)
        this.#stages.delete(stage.id);
    }
    for (const plan of [...this.#plans.values()]) {
      const expiresAt = Date.parse(plan.expiresAt);
      if (OPEN_STATES.has(plan.state) && expiresAt <= now && !this.#answering.has(plan.id))
        void this.#end(plan, plan.state === 'pending' ? 'expired' : 'ended', 'expired').catch(() => undefined);
      else if (!OPEN_STATES.has(plan.state) && expiresAt + SETTLED_PLAN_KEPT_MS <= now) this.#plans.delete(plan.id);
    }
    for (const [sessionId, times] of this.#raised) {
      const recent = times.filter(at => at > now - HOUR_MS);
      if (recent.length === 0) this.#raised.delete(sessionId);
      else this.#raised.set(sessionId, recent);
    }
  }

  // ── Inside ────────────────────────────────────────────────────────────────────────────────────────

  #assertRoom(sessionId: string, now: number): void {
    const held = [...this.#plans.values()].filter(plan => plan.sessionId === sessionId);
    if (held.filter(plan => plan.state === 'pending').length >= TASK_PLAN_MAX_PENDING_PER_SESSION)
      throw new SecureCopyError(
        'capacity',
        `${String(TASK_PLAN_MAX_PENDING_PER_SESSION)} plans are already waiting on the owner; wait for one to be answered`,
      );
    if (held.filter(plan => plan.state === 'approved').length >= TASK_PLAN_MAX_LIVE_PER_SESSION)
      throw new SecureCopyError(
        'capacity',
        `${String(TASK_PLAN_MAX_LIVE_PER_SESSION)} plans are already in force for this session; wait for one to end`,
      );
    const recent = (this.#raised.get(sessionId) ?? []).filter(at => at > now - HOUR_MS);
    if (recent.length >= TASK_PLAN_MAX_PROPOSALS_PER_HOUR)
      throw new SecureCopyError(
        'capacity',
        `this session already raised ${String(TASK_PLAN_MAX_PROPOSALS_PER_HOUR)} plans this hour; plan the rest in one`,
      );
  }

  /** Each ticked sign-in line's pins, read from the accounts now. Refused when a sign-in is not what the card shows. */
  async #pinsFor(plan: TaskPlan, selected: readonly TaskPlanSelectedLine[]): Promise<Map<number, TaskPlanLinePins>> {
    const listing = await this.ports.accounts.listing().catch(() => {
      throw new SecureCopyError('unavailable', 'the accounts could not be read; try again in a moment');
    });
    const pins = new Map<number, TaskPlanLinePins>();
    for (const tick of selected) {
      if (tick.kind === 'paste') continue;
      // The selection already holds the line to one of its own candidates; a line without one gets no pins, and the
      // canonical bytes refuse a ticked sign-in line with none.
      const line = plan.lines[tick.line];
      if (line === undefined || line.kind === 'paste') continue;
      const candidate = line.candidates.find(each => each.signIn === tick.signIn);
      if (candidate === undefined) continue;
      const key = await this.ports.accounts.keyOf(candidate.account.id).catch(() => undefined);
      const read = pinsOf(line.kind, candidate, listing, key);
      if (!read.ok)
        throw new SecureCopyError(
          'conflict',
          `line ${String(tick.line + 1)}: ${read.reason}; decline it and ask the ferret for a new plan`,
        );
      pins.set(tick.line, read.pins);
    }
    return pins;
  }

  /**
   * RECORDS AN ANSWER, all or nothing: the record is checked first, then the pastes' rules are made (in memory), then
   * the plan and the pins are kept. A failure before the plan is kept leaves it pending with nothing made.
   */
  async #answer(
    owner: Extract<PasteRuleCaller, { kind: 'owner' }>,
    plan: TaskPlan,
    selected: readonly TaskPlanSelectedLine[],
    proof: 'passkey' | 'none',
    pins: ReadonlyMap<number, TaskPlanLinePins> = new Map(),
  ): Promise<TaskPlan> {
    if (this.#answering.has(plan.id)) throw new SecureCopyError('conflict', 'the plan is already being answered');
    this.#answering.add(plan.id);
    let settled: TaskPlan;
    try {
      const live = [...this.#plans.values()].filter(
        each => each.sessionId === plan.sessionId && each.state === 'approved',
      );
      if (selected.length > 0 && live.length >= TASK_PLAN_MAX_LIVE_PER_SESSION)
        throw new SecureCopyError(
          'capacity',
          `${String(TASK_PLAN_MAX_LIVE_PER_SESSION)} plans are already in force for this session; revoke one first`,
        );
      const ticked = new Map(selected.map(line => [line.line, line]));
      const { machineStage: _staged, ...rest } = plan;
      const record = TaskPlanSchema.safeParse({
        ...rest,
        state: selected.length === 0 ? 'declined' : 'approved',
        answered: { at: new Date(this.ports.clock.now()).toISOString(), by: owner.actor, proof },
        lines: plan.lines.map(line => answeredLine(line, ticked.get(line.line))),
      } satisfies TaskPlan);
      if (!record.success)
        throw new SecureCopyError(
          'conflict',
          `that answer can't be recorded: ${record.error.issues[0]?.message ?? ''}`,
        );
      const pastes = selected.flatMap(line =>
        line.kind === 'paste' ? [{ line: line.line, from: line.from, to: line.to, uses: line.uses }] : [],
      );
      if (pastes.length > 0)
        this.ports.rules.fromPlan(owner, plan.sessionId, plan.id, pastes, Date.parse(plan.expiresAt));
      settled = record.data;
      this.#plans.set(plan.id, settled);
      const kept = new Map([...pins].filter(([line]) => ticked.has(line)));
      if (kept.size > 0) this.#pins.set(plan.id, kept);
      for (const stage of this.#stages.values())
        if (stage.planId === plan.id && stage.state === 'waiting' && stage.committing !== true)
          this.#finish(stage, 'denied');
    } finally {
      this.#answering.delete(plan.id);
    }
    const approved = selected.map(line => line.line);
    await this.ports.agenda
      .close(plan.sessionId, plan.agendaItemId, answeredNote(approved, plan))
      .catch(() => undefined);
    await this.ports.tell(plan.sessionId, plan.agendaItemId, answeredTell(plan.agendaItemId, approved, plan));
    await this.#auditAnswered(settled, selected, proof, auditActor(owner));
    return settled;
  }

  /** Ends a plan: every line that could still act ends, its pastes and pins go, and a card still waiting is closed. */
  async #end(
    plan: TaskPlan,
    state: Extract<TaskPlanState, 'expired' | 'revoked' | 'ended'>,
    cause: 'revoked' | 'expired' | 'session-ended',
    owner?: Extract<PasteRuleCaller, { kind: 'owner' }>,
  ): Promise<TaskPlan> {
    const wasPending = plan.state === 'pending';
    const { machineStage: _staged, ...rest } = plan;
    const ended = TaskPlanSchema.parse({ ...rest, state, lines: plan.lines.map(endedLine) });
    this.#plans.set(plan.id, ended);
    this.ports.rules.endPlan(plan.id);
    this.#pins.delete(plan.id);
    for (const stage of this.#stages.values())
      if (stage.planId === plan.id && stage.state === 'waiting' && stage.committing !== true)
        this.#finish(stage, 'denied');
    if (wasPending)
      await this.ports.agenda.close(plan.sessionId, plan.agendaItemId, ENDED_NOTES[cause]).catch(() => undefined);
    if (cause === 'revoked')
      await this.ports.tell(
        plan.sessionId,
        plan.agendaItemId,
        `${plan.agendaItemId}: the owner ended your task plan; each sign-in and paste asks them again.`,
      );
    await this.#auditEnded(ended, cause, undefined, owner === undefined ? { kind: 'host' } : auditActor(owner));
    return ended;
  }

  /** A plan as it stands now: its paste lines' uses read from the rules, a line with none left `used-up`. */
  #current(plan: TaskPlan): TaskPlan {
    if (plan.state !== 'approved' || !plan.lines.some(line => line.kind === 'paste' && line.remaining !== undefined))
      return plan;
    const left = this.ports.rules.planUses(plan.id);
    const lines = plan.lines.map((line): TaskPlanLine => {
      if (
        line.kind !== 'paste' ||
        line.remaining === undefined ||
        (line.state !== 'approved' && line.state !== 'used-up')
      )
        return line;
      const remaining = Math.min(line.uses, left.get(line.line) ?? 0);
      return { ...line, remaining, state: remaining === 0 ? 'used-up' : 'approved' };
    });
    const current = TaskPlanSchema.safeParse({ ...plan, lines });
    return current.success ? current.data : plan;
  }

  #own(sessionId: string, planId: string): TaskPlan {
    const plan = this.#plans.get(planId);
    if (plan === undefined || plan.sessionId !== sessionId) throw this.#notFound();
    return plan;
  }

  #pending(sessionId: string, planId: string): TaskPlan {
    const plan = this.#own(sessionId, planId);
    if (plan.state !== 'pending') throw new SecureCopyError('conflict', `the plan is already ${plan.state}`);
    if (this.#answering.has(planId)) throw new SecureCopyError('conflict', 'the plan is already being answered');
    return plan;
  }

  /**
   * A stage of THIS plan and session, waiting (or, for a read, finished but remembered); else it is gone. The machine
   * answers only the stages it made; a paired device, where the owner's passkey lives, any.
   */
  #ownStage(
    owner: Extract<PasteRuleCaller, { kind: 'owner' }>,
    sessionId: string,
    planId: string,
    stage: TaskPlanStageId,
    options: { readonly finished: boolean },
  ): Stage {
    const held = this.#stages.get(stage);
    if (held === undefined || held.planId !== planId || held.sessionId !== sessionId) throw this.#stageGone();
    if (held.state !== 'waiting' && !options.finished) throw this.#stageGone();
    if (owner.actor.kind !== 'device' && held.owner !== ownerKey(owner)) throw this.#stageGone();
    return held;
  }

  #staged(stage: Stage): TaskPlanStaged {
    return {
      stage: stage.id,
      plan: stage.planId,
      lines: stage.lines.map(line => line.line),
      summary: [...stage.summary],
      expiresAt: new Date(stage.expiresAtMs).toISOString(),
    };
  }

  /** A stage is finished: a plan whose card showed it as asked at the machine shows it no more. */
  #finish(stage: Stage, state: Exclude<TaskPlanStageState, 'waiting'>): void {
    stage.state = state;
    const plan = this.#plans.get(stage.planId);
    if (plan?.machineStage?.stage === stage.id) {
      const { machineStage: _staged, ...rest } = plan;
      this.#plans.set(plan.id, rest);
    }
  }

  #freshStageId(): TaskPlanStageId {
    for (;;) {
      const id = this.#newStageId();
      if (!this.#stages.has(id)) return id;
    }
  }

  #notFound(): SecureCopyError {
    return new SecureCopyError('not_found', 'there is no such task plan (a daemon restart forgets plans)');
  }

  #stageGone(): TaskPlanError {
    return new TaskPlanError(
      404,
      TASK_PLAN_ERROR_CODES.stageNotFound,
      'that task plan selection is not waiting for a passkey: it was approved, dropped or timed out; stage it again',
    );
  }

  // ── Audit: what was asked and allowed, never a value ──────────────────────────────────────────────

  async #record(subject: string, detail: AuditDetail, actor: AuditActor = { kind: 'host' }): Promise<void> {
    await this.ports.audit
      .record({ event: 'security.changed', actor, subject, outcome: 'succeeded', detail })
      .catch(() => undefined);
  }

  /** One record per line: what it asks for and the ferret's reason (masked). Raised by the ferret's session. */
  async #auditRaised(plan: TaskPlan): Promise<void> {
    for (const line of plan.lines)
      await this.#record(plan.id, {
        action: 'task-plan-raised',
        by: 'agent',
        session: auditText(plan.sessionId),
        line: line.line + 1,
        kind: line.kind,
        uses: line.uses,
        state: line.state,
        ...(line.kind === 'paste'
          ? { route: auditText(routeOf(line.from, line.to)) }
          : line.candidates.length === 1 && line.candidates[0] !== undefined
            ? { signIn: line.candidates[0].signIn }
            : { candidates: line.candidates.length }),
        ...(line.kind !== 'paste' && line.because !== undefined ? { because: line.because } : {}),
        why: auditText(line.why),
      });
  }

  /** The answer, then one record per allowed line: the account, the fields and the uses. */
  async #auditAnswered(
    plan: TaskPlan,
    selected: readonly TaskPlanSelectedLine[],
    proof: 'passkey' | 'none',
    actor: AuditActor,
  ): Promise<void> {
    const approved = selected.map(line => line.line);
    await this.#record(
      plan.id,
      {
        action: 'task-plan-answered',
        session: auditText(plan.sessionId),
        proof,
        expiresAt: plan.expiresAt,
        approved: numbers(approved),
        declined: numbers(plan.lines.filter(line => line.state === 'declined').map(line => line.line)),
      },
      actor,
    );
    for (const line of selected) {
      const held = plan.lines[line.line];
      const account =
        line.kind === 'paste' || held === undefined || held.kind === 'paste'
          ? undefined
          : held.candidates.find(candidate => candidate.signIn === line.signIn)?.account.id;
      await this.#record(
        plan.id,
        {
          action: 'task-plan-line-approved',
          session: auditText(plan.sessionId),
          line: line.line + 1,
          kind: line.kind,
          uses: line.uses,
          ...(line.kind === 'paste'
            ? { route: auditText(routeOf(line.from, line.to)) }
            : { signIn: line.signIn, fields: line.fields.join('+'), ...(account === undefined ? {} : { account }) }),
          why: auditText(held?.why ?? ''),
        },
        actor,
      );
    }
  }

  async #auditEnded(
    plan: TaskPlan,
    cause: 'revoked' | 'expired' | 'session-ended',
    lines: readonly number[] | undefined,
    actor: AuditActor,
  ): Promise<void> {
    await this.#record(
      plan.id,
      {
        action: 'task-plan-ended',
        session: auditText(plan.sessionId),
        cause,
        ...(lines === undefined ? {} : { lines: numbers(lines) }),
      },
      actor,
    );
  }
}

const ENDED_NOTES: Readonly<Record<'revoked' | 'expired' | 'session-ended', string>> = {
  revoked: 'You revoked the task plan.',
  expired: 'The task plan expired.',
  'session-ended': 'The task plan ended with its session.',
};

/** A line once the plan is answered: ticked lines in force with every use left, unticked ones declined. */
function answeredLine(line: TaskPlanLine, tick: TaskPlanSelectedLine | undefined): TaskPlanLine {
  if (line.state !== 'waiting') return line;
  if (tick === undefined) return { ...line, state: 'declined' };
  if (line.kind === 'paste') return { ...line, state: 'approved', remaining: line.uses };
  if (tick.kind === 'paste') return line;
  return {
    ...line,
    state: 'approved',
    approved: { signIn: tick.signIn, totp: tick.fields.includes('totp'), remaining: line.uses },
  };
}

/** A line once its plan ends: a line that could still act is `ended`; one already settled says how it settled. */
function endedLine(line: TaskPlanLine): TaskPlanLine {
  return line.state === 'waiting' || line.state === 'approved' || line.state === 'used-up'
    ? { ...line, state: 'ended' }
    : line;
}
