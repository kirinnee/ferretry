/**
 * The browser's half of STANDING SIGN-IN RULES (docs/secure-copy.md, "Sign-in rules"): the owner's routes for a rule,
 * the stage a passkey is bound to, and the pure rules every rule screen draws from. Nothing here is a value. Names
 * (an account's label, a username) come only from the secrets-gated rule routes, never from an agenda item's text, and
 * every warning is drawn from the daemon's STRUCTURED flags (`root`, `totp`, `autoRecipe`), never parsed from the
 * summary's words, which may be clipped (secrev-1268 N1, secrev-1301 L2). Nothing is cached at module scope, because a
 * rule belongs to a machine.
 */

import {
  type IFyApiClient,
  type Place,
  SIGN_IN_RULE_ERROR_CODES,
  SIGN_IN_RULE_HONEST_LIMIT,
  SIGN_IN_RULE_INELIGIBLE_WORDS,
  SIGN_IN_RULE_MAX_USES,
  SIGN_IN_RULE_REFUSAL_WORDS,
  SIGN_IN_RULE_ROOT_WARNING,
  SIGN_IN_RULE_TERMINAL_HONEST_LIMIT,
  SIGN_IN_RULE_TERMINAL_RESIDUAL,
  SIGN_IN_RULE_TOTP_WARNING,
  type SignInId,
  type SignInRuleDraft,
  type SignInRuleEligibility,
  SignInRuleEligibilitySchema,
  type SignInRuleFlag,
  type SignInRuleId,
  type SignInRuleList,
  SignInRuleListSchema,
  type SignInRuleNarrow,
  type SignInRuleRow,
  type SignInRuleScope,
  type SignInRuleStaged,
  SignInRuleStagedSchema,
  type SignInRuleStageId,
  type SignInRuleSuggestionList,
  SignInRuleSuggestionListSchema,
  type SignInRuleSurface,
  type SignInRuleView,
  SignInRuleViewSchema,
  signInRuleLifetime,
  signInRuleSuspensionWords,
  signInRuleWords,
  type TwoFactorKeySummary,
} from '@ferretry/protocol';
import { z } from 'zod';
import type { StepUpWords } from './step-up-gate.ts';

export type RuleClient = Pick<IFyApiClient, 'request'>;

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const stagePath = (stage: SignInRuleStageId): string => `/v1/sign-in-rules/stages/${encodeURIComponent(stage)}`;

const StageDroppedSchema = z.strictObject({ stage: z.string(), dropped: z.literal(true) });
const RuleRevokedSchema = z.strictObject({ id: z.string(), revoked: z.literal(true) });
const SuggestionDismissedSchema = z.strictObject({ id: z.string(), dismissed: z.boolean() });

// ── Routes ───────────────────────────────────────────────────────────────────────────────────────────

/** Every rule on the machine and the stages waiting in the app (`secrets.use`: it names accounts). */
export async function listRules(client: RuleClient): Promise<SignInRuleList> {
  return await client.request('/v1/sign-in-rules', SignInRuleListSchema);
}

/** Whether a sign-in could have a rule now, and why not. */
export async function readEligibility(client: RuleClient, signIn: SignInId): Promise<SignInRuleEligibility> {
  return await client.request(
    `/v1/sign-in-rules/eligibility?signIn=${encodeURIComponent(signIn)}`,
    SignInRuleEligibilitySchema,
  );
}

/** STAGE: builds the body and holds it for its passkey. Approves nothing. */
async function stageRule(client: RuleClient, draft: SignInRuleDraft): Promise<SignInRuleStaged> {
  return await client.request('/v1/sign-in-rules/stages', SignInRuleStagedSchema, json(draft));
}

/** A paired device TAKES a machine stage (`fy rules add`) to approve it with its own passkey. */
async function bindRuleStage(client: RuleClient, stage: SignInRuleStageId): Promise<SignInRuleStaged> {
  return await client.request(`${stagePath(stage)}/bind`, SignInRuleStagedSchema, { method: 'POST' });
}

/** COMMIT: only after the `approve-sign-in-rule` passkey bound to this stage. */
async function commitRuleStage(client: RuleClient, stage: SignInRuleStageId): Promise<SignInRuleView> {
  return await client.request(`${stagePath(stage)}/commit`, SignInRuleViewSchema, { method: 'POST' });
}

/** DROP: nothing was approved. */
export async function dropRuleStage(client: RuleClient, stage: SignInRuleStageId): Promise<void> {
  await client.request(stagePath(stage), StageDroppedSchema, { method: 'DELETE' });
}

/** NARROW: drop the code, end earlier, lower the cap. No passkey: it only takes away. */
export async function narrowRule(
  client: RuleClient,
  rule: SignInRuleId,
  narrow: SignInRuleNarrow,
): Promise<SignInRuleView> {
  return await client.request(
    `/v1/sign-in-rules/${encodeURIComponent(rule)}/narrow`,
    SignInRuleViewSchema,
    json(narrow),
  );
}

/** REVOKE: one tap, no passkey. */
export async function revokeRule(client: RuleClient, rule: SignInRuleId): Promise<void> {
  await client.request(`/v1/sign-in-rules/${encodeURIComponent(rule)}`, RuleRevokedSchema, { method: 'DELETE' });
}

export async function listSuggestions(client: RuleClient): Promise<SignInRuleSuggestionList> {
  return await client.request('/v1/sign-in-rules/suggestions', SignInRuleSuggestionListSchema);
}

export async function dismissSuggestion(client: RuleClient, suggestion: string): Promise<void> {
  await client.request(`/v1/sign-in-rules/suggestions/${encodeURIComponent(suggestion)}`, SuggestionDismissedSchema, {
    method: 'DELETE',
  });
}

// ── Words (the daemon's closed lists; nothing here comes from a ferret) ──────────────────────────────

/** On every rule card, sheet and Settings group, verbatim. */
export const RULE_HONEST_LIMIT = SIGN_IN_RULE_HONEST_LIMIT;
/** The red one-factor warning under a ticked code: one or two short sentences. */
const RULE_TOTP_WARNING = SIGN_IN_RULE_TOTP_WARNING;
export const RULE_TOTP_ACK_WORDS = 'I understand this makes the sign-in one factor, with no one to approve a code.';
const RULE_AUTO_RECIPE_WORDS =
  'This sign-in applies its recipe by itself, so the form it fills is one a ferret may have written.';
export const RULE_NO_ACCOUNTS_DEVICE_WORDS =
  'This device can’t see your accounts, so it can’t show standing rules. Use a device that can.';
export const RULE_DISMISSED_WORDS =
  'The passkey was dismissed, so nothing was approved. Tick what you want to try again.';
export const RULE_NO_PASSKEY_DEVICE_WORDS =
  'This device cannot confirm with a passkey, so it cannot approve a standing rule.';
/** A sign-in that has a rule, whose rule could not be read: it is not replaced unseen. */
export const RULE_REPLACED_UNREADABLE_WORDS =
  'This sign-in already has a standing rule, and it could not be read, so it can’t be replaced here. Look at it in Settings › Secure copy › Standing sign-in rules.';
export const RULE_DAMAGED_WORDS =
  'The standing rules file could not be read, so no rule fills until you approve one again. Every sign-in asks you.';
/** A `#rules/<stage>` link whose stage the daemon no longer lists. */
export const RULE_LINKED_STAGE_GONE_WORDS = 'That approval timed out or was already answered.';

/** What a rule can't cover, listed on every sheet under "You’ll still be asked". */
export const RULE_STILL_ASKED: readonly string[] = [
  'Push approvals (Okta Verify, Duo, a Google prompt): you approve on your phone.',
  'Security keys and passkeys: handed to you.',
  'Captchas and human checks: the ferret asks you to do it.',
  'A sign-in whose form changed since you approved it: the rule stops and asks.',
  'SMS and email codes, and a code you did not tick: the ferret reads its inbox, or you type it.',
  'Any program but sudo, su and doas in a terminal, and ssh, scp, npm, docker: the normal card.',
];

export const INELIGIBLE_WORDS = SIGN_IN_RULE_INELIGIBLE_WORDS;

export const failureWords = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** Whether the daemon refused the caller outright (403): a device that may not see accounts is refused every time. */
export const isForbidden = (cause: unknown): boolean =>
  typeof cause === 'object' && cause !== null && 'status' in cause && cause.status === 403;

const codeOf = (cause: unknown): string | undefined =>
  typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string'
    ? cause.code
    : undefined;

/**
 * The sentence for a refused route, by the code the daemon answered with: each refusal its own protocol sentence, so a
 * rule that already exists never reads as a sign-in that changed (C1).
 */
export function ruleFailureWords(cause: unknown): string {
  const code = codeOf(cause);
  if (code !== undefined && Object.hasOwn(SIGN_IN_RULE_REFUSAL_WORDS, code))
    return SIGN_IN_RULE_REFUSAL_WORDS[code as keyof typeof SIGN_IN_RULE_REFUSAL_WORDS];
  switch (code) {
    case SIGN_IN_RULE_ERROR_CODES.passkeyRequired:
      return INELIGIBLE_WORDS['no-passkey'];
    case SIGN_IN_RULE_ERROR_CODES.noHistory:
      return INELIGIBLE_WORDS['no-history'];
    case SIGN_IN_RULE_ERROR_CODES.viaProvider:
      return INELIGIBLE_WORDS['via-provider'];
    case SIGN_IN_RULE_ERROR_CODES.notPassword:
      return INELIGIBLE_WORDS['not-password'];
    case SIGN_IN_RULE_ERROR_CODES.toolNotCovered:
      return INELIGIBLE_WORDS['tool-not-covered'];
    case SIGN_IN_RULE_ERROR_CODES.terminalOff:
      return INELIGIBLE_WORDS['terminal-off'];
    default:
      return failureWords(cause);
  }
}

export const timeWords = (instant: string): string => `${instant.slice(0, 16).replace('T', ' ')} UTC`;

/** "30 days", "1 day". */
export const daysWords = (days: number): string => `${String(days)} ${days === 1 ? 'day' : 'days'}`;

const usesLeftWords = (rule: Pick<SignInRuleView, 'uses' | 'remaining'>): string =>
  rule.uses === undefined || rule.remaining === undefined
    ? 'No limit'
    : `${String(rule.remaining)} of ${String(rule.uses)} uses left`;

// ── Flags, from the structured fields ────────────────────────────────────────────────────────────────

export interface RuleFlag {
  readonly name: SignInRuleFlag;
  readonly tone: 'err' | 'warn';
  readonly words: string;
}

/** The flags of a rule or a staged rule, in a fixed order, each drawn only from a structured field. */
export function ruleFlags(facts: {
  readonly root: boolean;
  readonly totp: boolean;
  readonly autoRecipe: boolean;
}): readonly RuleFlag[] {
  return [
    ...(facts.root ? [{ name: 'root', tone: 'err', words: SIGN_IN_RULE_ROOT_WARNING } as const] : []),
    ...(facts.totp ? [{ name: 'one-factor', tone: 'err', words: RULE_TOTP_WARNING } as const] : []),
    ...(facts.autoRecipe ? [{ name: 'auto-recipe', tone: 'warn', words: RULE_AUTO_RECIPE_WORDS } as const] : []),
  ];
}

/** A staged rule's flags: the booleans the daemon set, never the summary. */
export const stagedFlags = (staged: Pick<SignInRuleStaged, 'root' | 'totp' | 'autoRecipe'>): readonly RuleFlag[] =>
  ruleFlags(staged);

/** A listed rule's flags: the daemon's `flags` array (root, one-factor, auto-recipe). */
export const viewFlags = (rule: Pick<SignInRuleView, 'flags'>): readonly RuleFlag[] =>
  ruleFlags({
    root: rule.flags.includes('root'),
    totp: rule.flags.includes('one-factor'),
    autoRecipe: rule.flags.includes('auto-recipe'),
  });

/**
 * The ONE red block's sentences for a set of flags, in order: a root rule says it and then the split-second risk; the
 * one-factor and the auto-recipe flags say their own. Each is drawn only from a structured flag.
 */
export const flagSentences = (flags: readonly RuleFlag[]): readonly string[] =>
  flags.flatMap(flag => (flag.name === 'root' ? [flag.words, SIGN_IN_RULE_TERMINAL_RESIDUAL] : [flag.words]));

/** The kernel-proof detail behind "How it's checked": what the program proof is worth, by kind of rule. */
export const checkedWords = (root: boolean): string =>
  root ? SIGN_IN_RULE_TERMINAL_HONEST_LIMIT : SIGN_IN_RULE_HONEST_LIMIT;

/**
 * The passkey dialog's body, as STRUCTURE: the daemon's one plain line and its rows, exactly as staged, and the warnings
 * the staged rule's flags give. The rows and the warnings are separate lists, never one text split in two, so a row can
 * never be drawn in the red block.
 */
export function passkeyWords(
  staged: Pick<SignInRuleStaged, 'does' | 'rows' | 'root' | 'totp' | 'autoRecipe'>,
): StepUpWords {
  return { does: staged.does, rows: staged.rows, warnings: flagSentences(stagedFlags(staged)) };
}

/**
 * A listed rule in the one shape every rule screen draws: the plain line and the rows, built by the protocol's one
 * builder from the daemon's structured view. Its Uses row says what is left and what was used.
 */
export function ruleWordsOf(rule: SignInRuleView): { readonly does: string; readonly rows: readonly RuleRow[] } {
  const words = signInRuleWords({
    fields: rule.fields,
    account: rule.account,
    username: rule.username,
    place: rule.place,
    scope: rule.scope,
    expiresAt: rule.expiresAt,
    uses: rule.uses,
    codeKey: rule.codeKey,
    revision: 1,
  });
  const last = rule.usage.lastUsedAt === undefined ? '' : `, last ${timeWords(rule.usage.lastUsedAt)}`;
  const used = rule.usage.count === 0 ? 'not used yet' : `used ${String(rule.usage.count)}×${last}`;
  return {
    does: words.does,
    rows: [
      ...words.rows.map(row =>
        row.label === 'Uses' ? { label: row.label, value: `${usesLeftWords(rule)} · ${used}` } : row,
      ),
      { label: 'Approved with', value: rule.approvedWith.device ?? 'a paired device' },
    ],
  };
}

/** A label and one line, as any rule screen draws it. */
export type RuleRow = Pick<SignInRuleRow, 'value'> & { readonly label: string };

/** The sheet has no end time until the daemon stages one; its rows leave the Until row out. */
const SHEET_PLACEHOLDER_UNTIL = '1970-01-01T00:00:00.000Z';

/**
 * The create sheet's lead: the plain line for what is ticked and the facts that do not move with a tick (the place, and
 * the 2FA key when the code is ticked). The daemon's own rows are what the passkey shows afterwards.
 */
export function sheetWords(input: {
  readonly accountName: string;
  readonly username?: string | undefined;
  readonly place: Place;
  readonly ticks: RuleTicks;
  readonly codeKey?: string | undefined;
}): { readonly does: string; readonly rows: readonly SignInRuleRow[] } {
  const { ticks } = input;
  const words = signInRuleWords({
    fields: [
      ...(ticks.username ? (['username'] as const) : []),
      ...(ticks.password || !ticks.username ? (['password'] as const) : []),
      ...(ticks.totp ? (['totp'] as const) : []),
    ],
    account: { id: 'SHEET', label: input.accountName },
    username: input.username,
    place: input.place,
    scope: ticks.scope,
    expiresAt: SHEET_PLACEHOLDER_UNTIL,
    codeKey: input.codeKey,
    revision: 1,
  });
  return {
    does: words.does,
    rows: words.rows.filter(row => ['Machine', 'Site', 'Account', 'Code key'].includes(row.label)),
  };
}

/** The label of the 2FA key a code rule would pin: the newest key Ferretry makes codes for (the daemon pins the same). */
export function codeKeyLabel(
  factors: readonly Pick<TwoFactorKeySummary, 'automatic' | 'addedAt' | 'id' | 'label'>[],
): string | undefined {
  return [...factors]
    .filter(key => key.automatic)
    .sort((left, right) => Date.parse(right.addedAt) - Date.parse(left.addedAt) || left.id.localeCompare(right.id))[0]
    ?.label;
}

// ── Where the rule sits ──────────────────────────────────────────────────────────────────────────────

/** "Any ferret on this machine", "One project", "One session". */
export function scopeWords(scope: SignInRuleScope): string {
  switch (scope.kind) {
    case 'any':
      return 'Any ferret on this machine';
    case 'project':
      return 'Ferrets in one project';
    case 'session':
      return `One session (${scope.session.slice(-8)})`;
  }
}

/** The owner's words for a status. */
export function statusWords(rule: Pick<SignInRuleView, 'status' | 'suspended' | 'unverified'>): string {
  if (rule.status === 'suspended' && rule.suspended !== undefined)
    return `Suspended: ${signInRuleSuspensionWords(rule.suspended.because)}`;
  if (rule.status === 'active' && rule.unverified === true) return 'Active once Ferretry has checked it';
  return { active: 'Active', suspended: 'Suspended', 'used-up': 'All uses spent', expired: 'Expired' }[rule.status];
}

/** Whether a suspended rule can be resumed with a new passkey: not when its sign-in is gone. */
export const canResume = (rule: Pick<SignInRuleView, 'status' | 'suspended'>): boolean =>
  rule.status === 'suspended' && rule.suspended?.because !== 'sign-in-gone';

/** Whether a rule that ended on time or on its cap can be approved again. */
export const canRenew = (rule: Pick<SignInRuleView, 'status'>): boolean =>
  rule.status === 'expired' || rule.status === 'used-up';

/** Rules that would be suspended by an edit to this sign-in's recipe or domains. */
export const suspendableRules = (rules: readonly SignInRuleView[], signIn: SignInId): readonly SignInRuleView[] =>
  rules.filter(rule => rule.signIn === signIn && (rule.status === 'active' || rule.status === 'used-up'));

export const suspendWarning = (count: number): string =>
  `Saving this suspends ${String(count)} standing ${count === 1 ? 'rule' : 'rules'}: you approve again with a passkey.`;

export const deviceRevokeWarning = (count: number): string =>
  `${String(count)} standing ${count === 1 ? 'rule was' : 'rules were'} approved with this device’s passkey; ${count === 1 ? 'it' : 'they'} will be suspended.`;

/** Rules that this paired device's passkey approved (a revoke of the device suspends them). */
export const rulesApprovedWith = (rules: readonly SignInRuleView[], deviceId: string): number =>
  rules.filter(rule => rule.approvedWith.deviceId === deviceId && rule.status !== 'suspended').length;

// ── The sheet: what the owner ticks ──────────────────────────────────────────────────────────────────

/** The owner's ticks on the sheet. Nothing is ticked unless the owner opened it from Accounts or a card. */
export interface RuleTicks {
  readonly username: boolean;
  readonly password: boolean;
  readonly totp: boolean;
  readonly totpAcknowledged: boolean;
  readonly days: number;
  /** `undefined`: no limit. */
  readonly uses: number | undefined;
  readonly scope: SignInRuleScope;
}

/** Where the sheet was opened from: only an owner-opened sheet starts with the usual ticks. */
export type RuleOrigin = 'owner' | 'suggestion' | 'resume' | 'renew';

export const lifetimeDaysOptions = (surface: SignInRuleSurface): readonly number[] =>
  surface === 'terminal' ? [1, 7] : [7, 30, 90];

export const defaultDays = (surface: SignInRuleSurface): number => signInRuleLifetime(surface).defaultSeconds / 86_400;

/** The sheet's first ticks. A ferret's suggestion ticks NOTHING; a terminal rule is the password alone. */
export function initialRuleTicks(input: {
  readonly surface: SignInRuleSurface;
  readonly origin: RuleOrigin;
  readonly hasUsername: boolean;
  readonly before?: SignInRuleView | undefined;
}): RuleTicks {
  const { surface, origin, hasUsername, before } = input;
  const base = {
    totpAcknowledged: false,
    days: defaultDays(surface),
    uses: undefined,
    scope: { kind: 'any' } as SignInRuleScope,
  } as const;
  // Resuming or renewing starts from what the owner approved last time, except that the code must be ticked again.
  if (before !== undefined && (origin === 'resume' || origin === 'renew'))
    return {
      ...base,
      username: before.fields.includes('username'),
      password: before.fields.includes('password'),
      totp: false,
      scope: before.scope,
    };
  // Replacing an active rule from elsewhere (a suggestion, the offer): it starts from what that rule allows now, never
  // from wider defaults, and the code is ticked again as on a renewal.
  if (before !== undefined)
    return {
      ...base,
      username: before.fields.includes('username'),
      password: before.fields.includes('password'),
      totp: false,
      scope: before.scope,
      uses: before.uses,
    };
  if (origin === 'suggestion') return { ...base, username: false, password: false, totp: false };
  return {
    ...base,
    username: surface === 'page' && hasUsername,
    password: true,
    totp: false,
  };
}

/** What stops the owner from sending these ticks, or `undefined`. */
export function ticksProblem(ticks: RuleTicks, surface: SignInRuleSurface): string | undefined {
  if (!ticks.username && !ticks.password) return 'Tick what Ferretry may type.';
  if (surface === 'terminal' && (ticks.username || ticks.totp))
    return 'A rule for sudo, su or doas types the password only.';
  if (ticks.totp && !ticks.password) return 'The code is typed only after its own password.';
  if (ticks.totp && !ticks.totpAcknowledged) return 'Tick that you understand the code makes this one factor.';
  if (
    ticks.uses !== undefined &&
    (!Number.isInteger(ticks.uses) || ticks.uses < 1 || ticks.uses > SIGN_IN_RULE_MAX_USES)
  )
    return `The most uses is a whole number, 1 to ${String(SIGN_IN_RULE_MAX_USES)}.`;
  return undefined;
}

/** The draft the daemon stages: every pin is the daemon's own snapshot, so none is named here. */
export function draftOf(signIn: SignInId, ticks: RuleTicks, replaces?: SignInRuleId): SignInRuleDraft {
  return {
    signIn,
    fields: [...(ticks.username ? (['username'] as const) : []), ...(ticks.password ? (['password'] as const) : [])],
    ...(ticks.totp ? { totp: true, totpAcknowledged: true as const } : {}),
    scope: ticks.scope,
    lifetimeSeconds: ticks.days * 86_400,
    ...(ticks.uses === undefined ? {} : { uses: ticks.uses }),
    ...(replaces === undefined ? {} : { replaces }),
  };
}

// ── The approval itself: stage → passkey → commit ────────────────────────────────────────────────────

export type RuleProgress = 'staging' | 'passkey' | 'committing';

export type RuleOutcome =
  | { readonly kind: 'settled'; readonly rule: SignInRuleView }
  | { readonly kind: 'dismissed' }
  | { readonly kind: 'failed'; readonly words: string };

/** Asks for the passkey bound to a stage; the words are the daemon's rows and the flags' sentences, as structure. */
export type RuleAsk = (stage: SignInRuleStageId, words: StepUpWords) => Promise<boolean>;

export interface RulePorts {
  readonly client: RuleClient;
  /**
   * Asks for the `approve-sign-in-rule` passkey bound to the stage. `words` is the DAEMON's own plain line and rows of
   * the staged bytes and the structured flags' sentences, as separate lists; nothing a ferret wrote reaches it.
   * `undefined` when this device cannot ask.
   */
  readonly askPasskey: RuleAsk | undefined;
  readonly report?: (progress: RuleProgress) => void;
}

/** Asks for the passkey bound to a stage; a dismissed or failed prompt DROPS the stage, then commits once it is given. */
async function confirmRuleStage(ports: RulePorts, staged: SignInRuleStaged): Promise<RuleOutcome> {
  const { client, askPasskey, report } = ports;
  const drop = async (): Promise<void> => {
    await dropRuleStage(client, staged.stage).catch(() => undefined);
  };
  if (askPasskey === undefined) {
    await drop();
    return { kind: 'failed', words: RULE_NO_PASSKEY_DEVICE_WORDS };
  }
  report?.('passkey');
  let given: boolean;
  try {
    given = await askPasskey(staged.stage, passkeyWords(staged));
  } catch (cause) {
    await drop();
    return { kind: 'failed', words: failureWords(cause) };
  }
  if (!given) {
    await drop();
    return { kind: 'dismissed' };
  }
  report?.('committing');
  return { kind: 'settled', rule: await commitRuleStage(client, staged.stage) };
}

/** THE OWNER'S APPROVAL: stage the ticks, ask for the passkey bound to the stage, then commit. */
export async function runRuleApproval(ports: RulePorts, draft: SignInRuleDraft): Promise<RuleOutcome> {
  try {
    ports.report?.('staging');
    return await confirmRuleStage(ports, await stageRule(ports.client, draft));
  } catch (cause) {
    return { kind: 'failed', words: ruleFailureWords(cause) };
  }
}

/** A RULE STAGED AT THE MACHINE, taken by this device (`bind`), then the same passkey and commit. */
export async function runMachineRuleConfirm(ports: RulePorts, stage: SignInRuleStageId): Promise<RuleOutcome> {
  try {
    ports.report?.('staging');
    return await confirmRuleStage(ports, await bindRuleStage(ports.client, stage));
  } catch (cause) {
    return { kind: 'failed', words: ruleFailureWords(cause) };
  }
}

/** Which surface a place is: a terminal's sudo, su or doas, or a page. */
export const surfaceOf = (place: Place): SignInRuleSurface => (place.kind === 'terminal' ? 'terminal' : 'page');
