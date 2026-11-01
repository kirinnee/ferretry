import { z } from 'zod';
import {
  AccountKeySchema,
  type SignInId,
  SignInIdSchema,
  type TaskPlanStageId,
  TaskPlanStageIdSchema,
} from './account-ids.ts';
import { AccountRefSchema, type Place, PlaceKeySchema, PlaceSchema, placeKeys } from './accounts.ts';
import { AgendaIdSchema } from './agenda.ts';
import { canonicalJson } from './canonical-json.ts';
import { InstantSchema } from './common.ts';
import {
  LOGIN_MATCH_MAX,
  LOGIN_USERNAME_MAX_LENGTH,
  LoginDomainSchema,
  LoginFieldRoleSchema,
  LoginMatchSchema,
  oneLine,
} from './login-entries.ts';
import { LOGIN_OBSERVED_MAX, LoginObservedSecondFactorSchema } from './login-recipes.ts';
import { sha256Hex } from './mcp-oauth.ts';
import {
  COPY_PLAN_DEFAULT_LIFETIME_SECONDS,
  COPY_PLAN_MAX_ITEMS,
  COPY_PLAN_MAX_LIFETIME_SECONDS,
  COPY_PLAN_WHY_MAX_CHARS,
  type CopyPlan,
  CopyPlanIdSchema,
  type CopyPlanItem,
  CopyRouteFromSchema,
  CopyRouteToSchema,
  RuleOwnerSchema,
} from './secure-copy.ts';
import { PASSKEY_CHALLENGE_TTL_SECONDS } from './step-up.ts';

export { TaskPlanStageIdSchema };
export type { TaskPlanStageId };

/**
 * THE TASK PLAN: one card on which a ferret asks, before a task, for the owner to pre-approve its sign-ins and its
 * pastes (docs/secure-copy.md, "Task plans"). Today's paste plan, widened to three kinds of line:
 *
 * - a **sign-in** on a page: Ferretry types the account's username, password and (only with its own tick) a code;
 * - a **terminal sign-in**: the account's password typed into `sudo`, `su` or `doas` on this machine;
 * - a **paste**: today's planned paste of a secure copy.
 *
 * ## A LINE NAMES ONLY WHAT THE OWNER ALREADY SAVED
 *
 * A line names a sign-in that exists (`si_…`), or a host or `tool@host` the owner already saved, as a lookup key. It
 * never carries an origin, a URL, a program path or a value of its own: the daemon RESOLVES each line against the
 * account listing, the card is drawn from what it resolved, and a fill is matched only on that sign-in's own login
 * domains, as the daemon observed them. The ferret's `why` is shown as its words, never as fact.
 *
 * ## THE OWNER ONLY NARROWS, AND A SIGN-IN NEEDS THE PASSKEY
 *
 * The owner ticks lines, picks one of the daemon's candidate accounts and ticks codes; nothing can raise a line's uses,
 * lengthen the plan or add a field. Any ticked sign-in line needs a fresh passkey (`approve-task-plan`, asked of every
 * caller, the machine included) bound to {@link taskPlanApprovalSubject} of exactly what was ticked. A selection of
 * paste lines only keeps the paste plan's rule.
 *
 * ## THE FERRET LEARNS NOTHING ABOUT AN ACCOUNT'S SECRET FIELDS
 *
 * Its view ({@link TaskPlanAgentViewSchema}) has no `can`, `history`, `flags`, `because` or code tick: telling it "no
 * password saved" or "codes not approved" would say which secret fields an account holds. A miss tells it one
 * sentence for every reason ({@link TASK_PLAN_MISS_AGENT_NOTE}).
 */

// ── Limits (the copy-plan constants are the owners where they already existed) ─────────────────────────

/** Most lines on one plan. */
export const TASK_PLAN_MAX_LINES = COPY_PLAN_MAX_ITEMS;
/** The longest reason a ferret gives for one line. */
export const TASK_PLAN_WHY_MAX_CHARS = COPY_PLAN_WHY_MAX_CHARS;
/** Uses one line allows when the ferret names none, and the most it may ask for. */
export const TASK_PLAN_LINE_DEFAULT_USES = 1;
export const TASK_PLAN_LINE_MAX_USES = 5;
/** How long a plan lasts from its raise: the default, the least and the most a ferret may ask for. */
export const TASK_PLAN_DEFAULT_LIFETIME_SECONDS = COPY_PLAN_DEFAULT_LIFETIME_SECONDS;
export const TASK_PLAN_MIN_LIFETIME_SECONDS = 300;
export const TASK_PLAN_MAX_LIFETIME_SECONDS = COPY_PLAN_MAX_LIFETIME_SECONDS;
/** Most accounts one line's picker shows. */
export const TASK_PLAN_MAX_CANDIDATES = 8;
/** Per session: plans waiting on the owner, plans approved and not yet ended, and plans raised an hour. */
export const TASK_PLAN_MAX_PENDING_PER_SESSION = 3;
export const TASK_PLAN_MAX_LIVE_PER_SESSION = 3;
export const TASK_PLAN_MAX_PROPOSALS_PER_HOUR = 6;
/** How long a staged selection waits for its passkey: as long as the challenge it is answered with. */
export const TASK_PLAN_STAGE_TTL_SECONDS = PASSKEY_CHALLENGE_TTL_SECONDS;
/**
 * The terminal tools a terminal sign-in line may be for: setuid-root programs that read the password with getpass.
 * Any other program runs in an environment and with config files the ferret controls (`LD_PRELOAD`, a registry in
 * `~/.npmrc`, `ProxyCommand` in `~/.ssh/config`), so proving WHICH file runs says nothing about where the password
 * goes. A line for another tool is `unavailable` (`tool-not-covered`).
 */
export const TASK_PLAN_TERMINAL_TOOLS = ['sudo', 'su', 'doas'] as const;

/** Whether a terminal place key (`sudo@kirin-box`) is for a tool a line may cover. A key with no host is no terminal key. */
export const taskPlanCoversTool = (placeKey: string): boolean => {
  const at = placeKey.indexOf('@');
  return (
    at > 0 &&
    at < placeKey.length - 1 &&
    (TASK_PLAN_TERMINAL_TOOLS as readonly string[]).includes(placeKey.slice(0, at))
  );
};

// ── Why a line did not apply (one closed list, one sentence each) ────────────────────────────────────

/**
 * WHY A PRE-APPROVAL DID NOT FILL, or why a line can't be pre-approved at all. Each has one fixed sentence
 * ({@link grantMissWords}); the ferret is never told which ({@link TASK_PLAN_MISS_AGENT_NOTE}).
 */
export const GRANT_MISS_REASONS = [
  'expired',
  'other-session',
  'stopped',
  'used-up',
  'sign-in-gone',
  'place-changed',
  'recipe-changed',
  'not-here',
  'field-not-covered',
  'code-not-ticked',
  'ferret-named-another',
  'account-lacks-field',
  'rate',
  'not-https',
  'frame',
  'password-field',
  'field-hidden',
  'challenge',
  'scripted',
  'code-target',
  'form-changed',
  'not-proved',
  'not-system',
  'did-not-move-on',
  // At propose time only: the line is `unavailable`.
  'not-in-accounts',
  'via-provider',
  'tool-not-covered',
] as const;
export const GrantMissReasonSchema = z.enum(GRANT_MISS_REASONS);
export type GrantMissReason = z.infer<typeof GrantMissReasonSchema>;

/** The reasons that make a line `unavailable` when the plan is proposed: it can't be ticked. */
export const TASK_PLAN_UNAVAILABLE_REASONS = [
  'not-in-accounts',
  'via-provider',
  'tool-not-covered',
] as const satisfies readonly GrantMissReason[];

/** The misses that STOP a line: every later fill under it asks. There is no resume; a new plan is a new passkey. */
export const GRANT_STOPPING_REASONS = [
  'place-changed',
  'recipe-changed',
  'form-changed',
  'did-not-move-on',
] as const satisfies readonly GrantMissReason[];

/**
 * The sentence for each reason, as the owner reads it after "Task plan line 2 didn't apply: ". `not-here` has none:
 * the plan was not about that place, so there is nothing to say on the card. A new reason fails typecheck until it has
 * words.
 */
const GRANT_MISS_WORDS = {
  expired: 'the plan had ended',
  'other-session': 'the plan belongs to another session',
  stopped: 'the line was stopped earlier',
  'used-up': 'its uses were all spent',
  'sign-in-gone': 'the sign-in was removed or moved to another account',
  'place-changed': "the sign-in's login domains changed since you approved it",
  'recipe-changed': "the sign-in's recipe changed since you approved it",
  'field-not-covered': 'the card asks for a field the line does not cover',
  'code-not-ticked': 'the card asks for a code, and you did not tick codes for this line',
  'ferret-named-another': 'the ferret named another account for this card',
  'account-lacks-field': "the account doesn't hold a value this card needs",
  rate: 'too many sign-ins were filled in the last hour',
  'not-https': 'the page is not on https',
  frame: 'a field is in a frame from another site',
  'password-field': 'the password field is not a visible password box',
  'field-hidden': 'a field is hidden or covered',
  challenge: 'the page is showing a human check',
  scripted: 'the ferret ran a page script in this session',
  'code-target': 'the code field did not check out',
  'form-changed': 'the sign-in form changed since you approved it',
  'not-proved': "Ferretry couldn't prove which program is asking",
  'not-system': 'the program asking is not sudo, su or doas running as root',
  'did-not-move-on': "the page didn't move on, so Ferretry emptied the password field",
  'not-in-accounts': "it isn't in Accounts: add it in Settings › Accounts, or you'll be asked",
  'via-provider': 'it signs in through another account: the ferret should plan that sign-in',
  'tool-not-covered': "Ferretry can't prove where this program sends the password",
} as const satisfies Record<Exclude<GrantMissReason, 'not-here'>, string>;

/** The owner's sentence for a reason, or `undefined` for one that draws no line (`not-here`). */
export const grantMissWords = (reason: GrantMissReason): string | undefined =>
  reason === 'not-here' ? undefined : GRANT_MISS_WORDS[reason];

/** "Task plan line 2 didn't apply: the sign-in form changed since you approved it." `line` is 0-based. */
export const grantMissLine = (line: number, reason: GrantMissReason): string | undefined => {
  const words = grantMissWords(reason);
  return words === undefined ? undefined : `Task plan line ${String(line + 1)} didn't apply: ${words}.`;
};

/** What the FERRET is told when a plan did not fill a card: the same sentence for every reason. */
export const TASK_PLAN_MISS_AGENT_NOTE = "Your task plan didn't cover this, so the owner was asked.";

// ── What the ferret sends (`task.plan`) ──────────────────────────────────────────────────────────────

const WhySchema = oneLine(TASK_PLAN_WHY_MAX_CHARS);
const UsesSchema = z.number().int().min(1).max(TASK_PLAN_LINE_MAX_USES).default(TASK_PLAN_LINE_DEFAULT_USES);
/** A line of a plan, numbered from 0 (the owner reads it from 1). */
export const TaskPlanLineNumberSchema = z
  .number()
  .int()
  .min(0)
  .max(TASK_PLAN_MAX_LINES - 1);

/** A field a sign-in line fills: the account's username, its password, or a code Ferretry makes from its 2FA key. */
export const SignInFieldSchema = LoginFieldRoleSchema;
export type SignInField = z.infer<typeof SignInFieldSchema>;

const exactlyOne =
  (first: string, second: string) =>
  (value: Readonly<Record<string, unknown>>, context: z.RefinementCtx): void => {
    if ((value[first] === undefined) === (value[second] === undefined))
      context.addIssue({ code: 'custom', path: [first], message: `name exactly one of ${first} or ${second}` });
  };

const uniqueFields = (value: { readonly fields: readonly string[] }, context: z.RefinementCtx): void => {
  if (new Set(value.fields).size !== value.fields.length)
    context.addIssue({ code: 'custom', path: ['fields'], message: 'name each field once' });
};

/**
 * A page sign-in: exactly one of `signIn` (a specific account's sign-in, as `account_hint` showed it) or `site` (a
 * host the owner already saved: a sign-in's login domain or what it is for; the owner picks the account). `site` is a
 * lookup key only: nothing is ever typed because of it.
 */
export const TaskPlanSignInAskSchema = z
  .strictObject({
    kind: z.literal('sign-in'),
    signIn: SignInIdSchema.optional(),
    site: LoginDomainSchema.optional(),
    fields: z.array(SignInFieldSchema).min(1).max(3),
    uses: UsesSchema,
    why: WhySchema,
  })
  .superRefine(exactlyOne('signIn', 'site'))
  .superRefine(uniqueFields);
export type TaskPlanSignInAsk = z.infer<typeof TaskPlanSignInAskSchema>;

/** A terminal place key a line may name: `tool@host`, as an existing terminal sign-in is keyed. */
const TerminalPlaceKeySchema = LoginMatchSchema.refine(key => key.includes('@'), 'a terminal key, like sudo@kirin-box');

/** A terminal sign-in: its password, typed into sudo / su / doas on this machine. Exactly one of `signIn` or `place`. */
export const TaskPlanTerminalAskSchema = z
  .strictObject({
    kind: z.literal('terminal-sign-in'),
    signIn: SignInIdSchema.optional(),
    place: TerminalPlaceKeySchema.optional(),
    uses: UsesSchema,
    why: WhySchema,
  })
  .superRefine(exactlyOne('signIn', 'place'));
export type TaskPlanTerminalAsk = z.infer<typeof TaskPlanTerminalAskSchema>;

/** A planned paste: today's paste-plan item, plus a use count. */
export const TaskPlanPasteAskSchema = z.strictObject({
  kind: z.literal('paste'),
  from: CopyRouteFromSchema,
  to: CopyRouteToSchema,
  uses: UsesSchema,
  why: WhySchema,
});
export type TaskPlanPasteAsk = z.infer<typeof TaskPlanPasteAskSchema>;

export const TaskPlanLineAskSchema = z.discriminatedUnion('kind', [
  TaskPlanSignInAskSchema,
  TaskPlanTerminalAskSchema,
  TaskPlanPasteAskSchema,
]);
export type TaskPlanLineAsk = z.infer<typeof TaskPlanLineAskSchema>;

/** What two sign-in lines would both be asking for: the same sign-in, or the same lookup key. */
const askKey = (ask: TaskPlanLineAsk): string | undefined => {
  if (ask.kind === 'paste') return undefined;
  if (ask.signIn !== undefined) return ask.signIn;
  return ask.kind === 'sign-in' ? `site:${ask.site ?? ''}` : `place:${ask.place ?? ''}`;
};

/**
 * `task.plan`: the agent-tool call, as the agent-tool union will carry it. Two lines naming the same sign-in (or the
 * same site or terminal key) are refused: one sign-in, one line.
 */
export const TaskPlanCallSchema = z
  .strictObject({
    tool: z.literal('task.plan'),
    lines: z.array(TaskPlanLineAskSchema).min(1).max(TASK_PLAN_MAX_LINES),
    expiresInSeconds: z
      .number()
      .int()
      .min(TASK_PLAN_MIN_LIFETIME_SECONDS)
      .max(TASK_PLAN_MAX_LIFETIME_SECONDS)
      .optional(),
  })
  .superRefine((call, context) => {
    const seen = new Set<string>();
    call.lines.forEach((ask, index) => {
      const key = askKey(ask);
      if (key === undefined) return;
      if (seen.has(key))
        context.addIssue({ code: 'custom', path: ['lines', index], message: 'name each sign-in on one line only' });
      seen.add(key);
    });
  });
export type TaskPlanCall = z.infer<typeof TaskPlanCallSchema>;

/** A paste plan's items (`secure.preapprove`) read as task-plan paste lines: one use each, as a paste plan allowed. */
export const taskPlanLinesOfCopyItems = (items: readonly CopyPlanItem[]): readonly TaskPlanPasteAsk[] =>
  items.map(item => ({
    kind: 'paste',
    from: item.from,
    to: item.to,
    uses: TASK_PLAN_LINE_DEFAULT_USES,
    why: item.why,
  }));

// ── What the daemon keeps (RAM only) and the owner reads ─────────────────────────────────────────────

/** One account a sign-in line may use, as the daemon found it in the listing. THE OWNER'S VIEW ONLY. */
export const TaskPlanCandidateSchema = z.strictObject({
  signIn: SignInIdSchema,
  account: AccountRefSchema,
  username: oneLine(LOGIN_USERNAME_MAX_LENGTH).optional(),
  /** The sign-in's place now; the line pins its keys when the selection is staged. */
  place: PlaceSchema,
  /** Whether the account can fill each field: a username, a saved password, an automatic-codes key. Never a value. */
  can: z.strictObject({ username: z.boolean(), password: z.boolean(), totp: z.boolean() }),
  /** At least one field identity here was seen masked and followed by the page moving on. */
  history: z.boolean(),
  /** The last second factor the daemon saw. Informational: it gates nothing. */
  lastSecondFactor: LoginObservedSecondFactorSchema.optional(),
});
export type TaskPlanCandidate = z.infer<typeof TaskPlanCandidateSchema>;

export const TaskPlanLineStateSchema = z.enum([
  /** Not answered yet. */
  'waiting',
  /** In force: uses left, not expired. */
  'approved',
  /** The owner left it unticked. */
  'declined',
  /** Can't be pre-approved: not in Accounts, a provider sign-in, a terminal tool other than sudo / su / doas. */
  'unavailable',
  'used-up',
  /** The daemon stopped it: the form or the recipe changed, or the page didn't move on. */
  'stopped',
  /** The plan expired, was revoked, or its session ended. */
  'ended',
]);
export type TaskPlanLineState = z.infer<typeof TaskPlanLineStateSchema>;

/** The daemon's flags on a sign-in line: drawn red (`root`, `one-factor`) or amber (`no-history`). */
export const TaskPlanLineFlagSchema = z.enum(['root', 'one-factor', 'no-history']);
export type TaskPlanLineFlag = z.infer<typeof TaskPlanLineFlagSchema>;

const LineBaseShape = {
  line: TaskPlanLineNumberSchema,
  uses: UsesSchema,
  why: WhySchema,
  state: TaskPlanLineStateSchema,
};

const SignInLineShape = {
  ...LineBaseShape,
  /** What the ferret asked for. A terminal line is always `['password']`. */
  fields: z.array(SignInFieldSchema).min(1).max(3),
  candidates: z.array(TaskPlanCandidateSchema).max(TASK_PLAN_MAX_CANDIDATES),
  /** Chosen before the owner looks: the account the ferret named, or the owner's own default. Never the ferret's pick on a picker. */
  preselect: z
    .strictObject({ signIn: SignInIdSchema, why: z.enum(['ferret', 'project', 'folder', 'site', 'only']) })
    .optional(),
  flags: z.array(TaskPlanLineFlagSchema).max(3),
  /** Why the line is `unavailable` or `stopped`: a fixed sentence ({@link grantMissWords}). */
  because: GrantMissReasonSchema.optional(),
  /** Set when the owner approved the line. */
  approved: z
    .strictObject({
      signIn: SignInIdSchema,
      totp: z.boolean(),
      remaining: z.number().int().min(0).max(TASK_PLAN_LINE_MAX_USES),
      lastUsedAt: InstantSchema.optional(),
    })
    .optional(),
};

/** States in which a line has been answered with a tick: its approval is recorded. */
const TICKED_STATES: ReadonlySet<TaskPlanLineState> = new Set(['approved', 'used-up']);
/** States in which a line was never ticked: nothing about an approval may be recorded. */
const UNTICKED_STATES: ReadonlySet<TaskPlanLineState> = new Set(['waiting', 'declined', 'unavailable']);
const EXPLAINED_STATES: ReadonlySet<TaskPlanLineState> = new Set(['unavailable', 'stopped']);

interface SignInLineFacts {
  readonly kind: 'sign-in' | 'terminal-sign-in';
  readonly uses: number;
  readonly state: TaskPlanLineState;
  readonly fields: readonly SignInField[];
  readonly candidates: readonly { readonly signIn: SignInId; readonly place: Place }[];
  readonly preselect?: { readonly signIn: SignInId } | undefined;
  readonly flags: readonly TaskPlanLineFlag[];
  readonly because?: GrantMissReason | undefined;
  readonly approved?: { readonly signIn: SignInId; readonly totp: boolean; readonly remaining: number } | undefined;
}

/**
 * Whether match keys are ones a line of this kind may fill at: a page line only at web hosts (never a `tool@host`), a
 * terminal line only at `sudo`, `su` or `doas` on a host. The one check behind the record, the candidates and the pins.
 */
export const taskPlanKeysFitLine = (kind: 'sign-in' | 'terminal-sign-in', keys: readonly string[]): boolean =>
  keys.length > 0 && keys.every(key => (kind === 'sign-in' ? !key.includes('@') : taskPlanCoversTool(key)));

/** What a sign-in line, as the daemon keeps it, may not be. */
export const taskPlanSignInLineProblems = (line: SignInLineFacts): readonly string[] => {
  const candidates = new Set(line.candidates.map(candidate => candidate.signIn));
  // An unavailable line can't be ticked, so it may show the owner a place it can't cover (an ssh sign-in, say).
  const misplaced =
    line.state !== 'unavailable' &&
    line.candidates.some(
      candidate =>
        candidate.place.kind !== (line.kind === 'sign-in' ? 'site' : 'terminal') ||
        (candidate.place.kind === 'terminal' && !taskPlanKeysFitLine(line.kind, placeKeys(candidate.place))),
    );
  return [
    ...(misplaced ? ['a page line offers sign-ins on sites, a terminal line sudo, su or doas only'] : []),
    ...(new Set(line.fields).size === line.fields.length ? [] : ['a line names each field once']),
    ...(line.kind === 'terminal-sign-in' && (line.fields.length !== 1 || line.fields[0] !== 'password')
      ? ['a terminal line fills the password only']
      : []),
    ...(candidates.size === line.candidates.length ? [] : ['a line lists each candidate once']),
    ...(new Set(line.flags).size === line.flags.length ? [] : ['a line carries each flag once']),
    ...(line.preselect === undefined || candidates.has(line.preselect.signIn)
      ? []
      : ['a line preselects one of its own candidates only']),
    ...(line.because === undefined || EXPLAINED_STATES.has(line.state)
      ? []
      : ['only an unavailable or stopped line says why']),
    ...(line.approved !== undefined && UNTICKED_STATES.has(line.state) ? ['an unticked line has no approval'] : []),
    ...(line.approved === undefined && TICKED_STATES.has(line.state) ? ['an approved line records its approval'] : []),
    ...(line.approved === undefined
      ? []
      : [
          ...(candidates.has(line.approved.signIn) ? [] : ['a line is approved for one of its own candidates only']),
          ...(line.approved.totp && !line.fields.includes('totp')
            ? ['codes are ticked only where they were asked']
            : []),
          ...(line.approved.remaining <= line.uses ? [] : ['a line never has more uses left than it asked for']),
        ]),
  ];
};

const refineSignInLine = (line: SignInLineFacts, context: z.RefinementCtx): void => {
  for (const message of taskPlanSignInLineProblems(line)) context.addIssue({ code: 'custom', message });
};

export const TaskPlanSignInLineSchema = z
  .strictObject({ kind: z.literal('sign-in'), ...SignInLineShape })
  .superRefine(refineSignInLine);
export const TaskPlanTerminalLineSchema = z
  .strictObject({ kind: z.literal('terminal-sign-in'), ...SignInLineShape })
  .superRefine(refineSignInLine);
export const TaskPlanPasteLineSchema = z
  .strictObject({
    kind: z.literal('paste'),
    ...LineBaseShape,
    from: CopyRouteFromSchema,
    to: CopyRouteToSchema,
    /** Uses left, once approved. */
    remaining: z.number().int().min(0).max(TASK_PLAN_LINE_MAX_USES).optional(),
  })
  .superRefine((line, context) => {
    if (line.remaining !== undefined && UNTICKED_STATES.has(line.state))
      context.addIssue({ code: 'custom', path: ['remaining'], message: 'an unticked line has no uses left' });
    if (line.remaining !== undefined && line.remaining > line.uses)
      context.addIssue({
        code: 'custom',
        path: ['remaining'],
        message: 'a line never has more uses left than it asked for',
      });
  });

export const TaskPlanLineSchema = z.discriminatedUnion('kind', [
  TaskPlanSignInLineSchema,
  TaskPlanTerminalLineSchema,
  TaskPlanPasteLineSchema,
]);
export type TaskPlanLine = z.infer<typeof TaskPlanLineSchema>;

export const TaskPlanStateSchema = z.enum(['pending', 'approved', 'declined', 'expired', 'revoked', 'ended']);
export type TaskPlanState = z.infer<typeof TaskPlanStateSchema>;

/**
 * A TASK PLAN, as the daemon keeps it in memory and the owner's card reads it. Its id is a paste plan's id, so the
 * paste-plan routes keep answering for it. A restart forgets every plan.
 */
export const TaskPlanSchema = z
  .strictObject({
    v: z.literal(1),
    id: CopyPlanIdSchema,
    sessionId: oneLine(128),
    agendaItemId: AgendaIdSchema,
    lines: z.array(TaskPlanLineSchema).min(1).max(TASK_PLAN_MAX_LINES),
    state: TaskPlanStateSchema,
    raisedAt: InstantSchema,
    /** From the raise, as a paste plan's. */
    expiresAt: InstantSchema,
    /** Who answered, and whether a passkey proved it. */
    answered: z.strictObject({ at: InstantSchema, by: RuleOwnerSchema, proof: z.enum(['passkey', 'none']) }).optional(),
    /** A selection staged at the machine (`fy plan approve`), waiting for the passkey in the app. */
    machineStage: z
      .strictObject({
        stage: TaskPlanStageIdSchema,
        lines: z.array(TaskPlanLineNumberSchema).min(1).max(TASK_PLAN_MAX_LINES),
        askedAt: InstantSchema,
      })
      .optional(),
  })
  .superRefine((plan, context) => {
    const problem = (message: string, path: (string | number)[] = []): void => {
      context.addIssue({ code: 'custom', message, path });
    };
    plan.lines.forEach((line, index) => {
      if (line.line !== index) problem('lines are numbered in order from 0', ['lines', index, 'line']);
    });
    if (plan.machineStage !== undefined) {
      const staged = plan.machineStage.lines;
      if (new Set(staged).size !== staged.length || staged.some(line => line >= plan.lines.length))
        problem("a staged selection names each of the plan's own lines once", ['machineStage', 'lines']);
      if (plan.state !== 'pending') problem('only a pending plan has a staged selection', ['machineStage']);
    }
    if (plan.state === 'pending' && plan.answered !== undefined) problem('a pending plan is unanswered', ['answered']);
    // A passkey lives only with a paired device: the machine's admin token can never have produced one.
    if (plan.answered?.proof === 'passkey' && plan.answered.by.kind !== 'device')
      problem('only a paired device proves a passkey', ['answered', 'by']);
    // The record itself refuses a sign-in line approved without the passkey, whoever wrote it.
    const signInApproved = plan.lines.some(line => line.kind !== 'paste' && line.approved !== undefined);
    if (signInApproved && plan.answered?.proof !== 'passkey')
      problem('a sign-in line is approved only with a passkey', ['answered', 'proof']);
    // One sign-in, one line: two lines approved for it would add their uses together.
    const approvedSignIns = plan.lines.flatMap(line =>
      line.kind === 'paste' || line.approved === undefined ? [] : [line.approved.signIn],
    );
    if (new Set(approvedSignIns).size !== approvedSignIns.length)
      problem('one sign-in is approved on one line only', ['lines']);
  });
export type TaskPlan = z.infer<typeof TaskPlanSchema>;

/** `GET /v1/task-plans`. */
export const TaskPlanListSchema = z.strictObject({ plans: z.array(TaskPlanSchema).max(100) });
export type TaskPlanList = z.infer<typeof TaskPlanListSchema>;

// ── What the ferret is told ──────────────────────────────────────────────────────────────────────────

/**
 * EVERYTHING A FERRET IS TOLD ABOUT ITS PLAN, in the `task.plan` result and when the plan is answered: each line's
 * state, the account the owner picked (a name, as `account_hint` already shows) and its uses left. Never a candidate's
 * `can` or `history`, a flag, a reason or the code tick: each would say which secret fields an account holds.
 */
export const TaskPlanAgentViewSchema = z.strictObject({
  id: CopyPlanIdSchema,
  agendaItemId: AgendaIdSchema,
  state: TaskPlanStateSchema,
  expiresAt: InstantSchema,
  lines: z
    .array(
      z.strictObject({
        line: TaskPlanLineNumberSchema,
        state: TaskPlanLineStateSchema,
        account: AccountRefSchema.optional(),
        remaining: z.number().int().min(0).max(TASK_PLAN_LINE_MAX_USES).optional(),
      }),
    )
    .max(TASK_PLAN_MAX_LINES),
});
export type TaskPlanAgentView = z.infer<typeof TaskPlanAgentViewSchema>;

/** The ferret's view of a plan: the one projection, so no other path can hand it more. */
export function taskPlanAgentView(plan: TaskPlan): TaskPlanAgentView {
  return {
    id: plan.id,
    agendaItemId: plan.agendaItemId,
    state: plan.state,
    expiresAt: plan.expiresAt,
    lines: plan.lines.map(line => {
      if (line.kind === 'paste')
        return {
          line: line.line,
          state: line.state,
          ...(line.remaining === undefined ? {} : { remaining: line.remaining }),
        };
      const picked = line.approved;
      const account =
        picked === undefined
          ? undefined
          : line.candidates.find(candidate => candidate.signIn === picked.signIn)?.account;
      return {
        line: line.line,
        state: line.state,
        ...(account === undefined ? {} : { account }),
        ...(picked === undefined ? {} : { remaining: picked.remaining }),
      };
    }),
  };
}

/**
 * A task plan as a paste plan (`secure.preapprove`'s answer and the paste-plan routes): its paste lines only, numbered
 * from 0 as items. `undefined` for a plan with no paste line. `approved` lists the items the owner ticked, once answered.
 */
export function copyPlanOf(plan: TaskPlan): CopyPlan | undefined {
  const pastes = plan.lines.filter(line => line.kind === 'paste');
  if (pastes.length === 0) return undefined;
  const ticked = pastes.flatMap((line, index) => (line.remaining === undefined ? [] : [index]));
  return {
    id: plan.id,
    sessionId: plan.sessionId,
    agendaItemId: plan.agendaItemId,
    items: pastes.map(line => ({ from: line.from, to: line.to, why: line.why })),
    state: plan.state === 'revoked' || plan.state === 'ended' ? 'expired' : plan.state,
    raisedAt: plan.raisedAt,
    expiresAt: plan.expiresAt,
    ...(plan.answered === undefined ? {} : { approved: ticked }),
  };
}

/**
 * The plan line a paste-plan item number stands for: the inverse of {@link copyPlanOf}'s numbering, which counts paste
 * lines only. `undefined` for an item the plan doesn't have. A paste-plan route reads an item through this and never as
 * a line number, so a legacy "approve item 0" can't land on sign-in line 0.
 */
export const taskPlanLineOfCopyItem = (plan: TaskPlan, item: number): number | undefined =>
  Number.isInteger(item) && item >= 0 ? plan.lines.filter(line => line.kind === 'paste')[item]?.line : undefined;

// ── The approval the owner sends, and the bytes its passkey is bound to ──────────────────────────────

/**
 * `POST /v1/sessions/:sid/task-plans/:pid/approval`: the lines the owner ticked. An empty list declines the plan. A
 * line with two or more candidates names the pick (`signIn`), which must be one of them; `totp` is the separate code
 * tick, only where the line asked for codes and the account can make them. A paste line takes neither.
 */
export const TaskPlanApprovalSchema = z
  .strictObject({
    lines: z
      .array(
        z.strictObject({
          line: TaskPlanLineNumberSchema,
          signIn: SignInIdSchema.optional(),
          totp: z.boolean().optional(),
        }),
      )
      .max(TASK_PLAN_MAX_LINES),
  })
  .refine(approval => new Set(approval.lines.map(line => line.line)).size === approval.lines.length, {
    path: ['lines'],
    message: 'tick each line once',
  });
export type TaskPlanApproval = z.infer<typeof TaskPlanApprovalSchema>;

/** One ticked line, narrowed to exactly what it allows. */
export type TaskPlanSelectedLine =
  | {
      readonly kind: 'sign-in' | 'terminal-sign-in';
      readonly line: number;
      readonly signIn: SignInId;
      /** What Ferretry may type: the asked fields, with `totp` only when it was ticked. Sorted. */
      readonly fields: readonly SignInField[];
      readonly uses: number;
    }
  | {
      readonly kind: 'paste';
      readonly line: number;
      readonly from: TaskPlanPasteAsk['from'];
      readonly to: TaskPlanPasteAsk['to'];
      readonly uses: number;
    };

export type TaskPlanSelection =
  | { readonly ok: true; readonly lines: readonly TaskPlanSelectedLine[] }
  | { readonly ok: false; readonly line?: number; readonly reason: string };

/**
 * What an approval selects of a plan, or why it can't: the owner may only NARROW what the ferret asked. Total and pure,
 * so the app, the daemon's stage and the tests read one answer. Sorted by line.
 */
export function taskPlanSelection(plan: TaskPlan, approval: TaskPlanApproval): TaskPlanSelection {
  if (plan.state !== 'pending') return { ok: false, reason: 'the plan is no longer waiting for an answer' };
  if (new Set(approval.lines.map(tick => tick.line)).size !== approval.lines.length)
    return { ok: false, reason: 'tick each line once' };
  const selected: TaskPlanSelectedLine[] = [];
  /** The sign-ins already ticked, and on which line: one sign-in, one line, or their uses would add together. */
  const picked = new Map<SignInId, number>();
  for (const tick of [...approval.lines].sort((left, right) => left.line - right.line)) {
    const refuse = (reason: string): TaskPlanSelection => ({ ok: false, line: tick.line, reason });
    const line = plan.lines[tick.line];
    if (line === undefined) return refuse('the plan has no such line');
    if (line.state !== 'waiting') return refuse("that line can't be ticked");
    if (line.kind === 'paste') {
      if (tick.signIn !== undefined || tick.totp !== undefined)
        return refuse('a paste line has no account or code tick');
      selected.push({ kind: 'paste', line: line.line, from: line.from, to: line.to, uses: line.uses });
      continue;
    }
    const only = line.candidates.length === 1 ? line.candidates[0] : undefined;
    const signIn = tick.signIn ?? only?.signIn;
    if (signIn === undefined) return refuse('pick one of the accounts first');
    const candidate = line.candidates.find(entry => entry.signIn === signIn);
    if (candidate === undefined) return refuse('pick one of the accounts the card lists');
    const already = picked.get(signIn);
    if (already !== undefined) return refuse(`this account is already ticked on line ${String(already + 1)}`);
    picked.set(signIn, line.line);
    const totp = tick.totp === true;
    if (totp && !line.fields.includes('totp')) return refuse('the ferret did not ask for codes on this line');
    if (totp && !candidate.can.totp) return refuse('this account has no automatic codes');
    const fields = line.fields.filter(field => field !== 'totp' || totp).sort();
    if (fields.length === 0) return refuse('tick the code, or leave the line unticked');
    selected.push({ kind: line.kind, line: line.line, signIn, fields, uses: line.uses });
  }
  return { ok: true, lines: selected };
}

/** Whether a selection needs the `approve-task-plan` passkey: it ticks a sign-in line. Paste lines only keep the old rule. */
export const taskPlanSelectionNeedsPasskey = (lines: readonly TaskPlanSelectedLine[]): boolean =>
  lines.some(line => line.kind !== 'paste');

/**
 * WHAT A TICKED SIGN-IN LINE IS PINNED TO, snapshotted when the selection is staged: the account's immutable key (a
 * rename can't redirect it), the sign-in's match keys (login domains, or `tool@host`; never a site's `match` hosts),
 * its recipe version, and the field identities it has history with (`undefined`: none yet; the first fill pins).
 * Part of the bound bytes, so the line the owner confirmed is exactly the line matched later.
 */
export const TaskPlanLinePinsSchema = z.strictObject({
  accountKey: AccountKeySchema,
  placeKeys: z.array(PlaceKeySchema).min(1).max(LOGIN_MATCH_MAX),
  recipeVersion: z.number().int().min(1).optional(),
  identities: z
    .array(z.string().regex(/^[0-9a-f]{16}$/u))
    .max(LOGIN_OBSERVED_MAX)
    .optional(),
});
export type TaskPlanLinePins = z.infer<typeof TaskPlanLinePinsSchema>;

export type TaskPlanCanonical =
  | { readonly ok: true; readonly text: string; readonly lines: readonly TaskPlanSelectedLine[] }
  | { readonly ok: false; readonly line?: number; readonly reason: string };

const sortedStrings = (values: readonly string[]): string[] => [...new Set(values)].sort();

/**
 * THE BYTES A TASK-PLAN PASSKEY IS BOUND TO: RFC 8785 JSON of the plan, its session and expiry, and every ticked line
 * with its pins, sorted by line. Changing any one of them changes the text, and so the subject. `pins` holds each
 * ticked sign-in line's {@link TaskPlanLinePins}, by line; a ticked sign-in line without valid pins is refused.
 */
export function canonicalTaskPlanApproval(
  plan: TaskPlan,
  approval: TaskPlanApproval,
  pins: ReadonlyMap<number, TaskPlanLinePins>,
): TaskPlanCanonical {
  const selection = taskPlanSelection(plan, approval);
  if (!selection.ok) return selection;
  const lines: unknown[] = [];
  for (const line of selection.lines) {
    if (line.kind === 'paste') {
      lines.push({ line: line.line, kind: line.kind, from: line.from, to: line.to, uses: line.uses });
      continue;
    }
    const pinned = TaskPlanLinePinsSchema.safeParse(pins.get(line.line));
    if (!pinned.success) return { ok: false, line: line.line, reason: 'the line has no pins to bind' };
    // Whatever the propose and the stage did, a page line binds only web hosts and a terminal line only sudo/su/doas.
    if (!taskPlanKeysFitLine(line.kind, pinned.data.placeKeys))
      return {
        ok: false,
        line: line.line,
        reason:
          line.kind === 'sign-in'
            ? 'a page sign-in is pinned to web hosts only'
            : 'a terminal sign-in is pinned to sudo, su or doas only',
      };
    lines.push({
      line: line.line,
      kind: line.kind,
      signIn: line.signIn,
      account: pinned.data.accountKey,
      placeKeys: sortedStrings(pinned.data.placeKeys),
      fields: sortedStrings(line.fields),
      uses: line.uses,
      recipeVersion: pinned.data.recipeVersion ?? null,
      identities: pinned.data.identities === undefined ? null : sortedStrings(pinned.data.identities),
    });
  }
  const text = canonicalJson({ v: 1, plan: plan.id, session: plan.sessionId, expiresAt: plan.expiresAt, lines });
  return text.ok ? { ok: true, text: text.text, lines: selection.lines } : { ok: false, reason: text.reason };
}

const TASK_PLAN_DOMAIN = 'ferretry.task-plan.v1';

/**
 * What an `approve-task-plan` passkey proof is bound to: `sha256("ferretry.task-plan.v1\0" + stage + "\0" +
 * sha256(canonical))`. The domain keeps it apart from every other bound act (`add-2fa-key`'s), and the stage keeps one
 * proof from committing another staging of the same selection.
 */
export const taskPlanApprovalSubject = (stage: TaskPlanStageId, canonical: string): string =>
  sha256Hex(`${TASK_PLAN_DOMAIN}\0${stage}\0${sha256Hex(canonical)}`);

/** The refusals the task-plan routes answer with, each a different next step for the person. */
export const TASK_PLAN_ERROR_CODES = {
  /** No such staged selection, or it was committed, dropped or timed out. */
  stageNotFound: 'stage_not_found',
  /** No device has a passkey yet, so no sign-in line can be approved: "Add a passkey in Settings › Security first". */
  passkeyRequired: 'passkey_required',
  /** The paste-plan approve route was asked to tick a sign-in line: that needs the passkey, in the app. */
  needsPasskey: 'needs_passkey',
} as const;
