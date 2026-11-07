import {
  AccountIdSchema,
  DAEMON_FEATURES,
  placeKeys,
  ruleDeepLink,
  SIGN_IN_RULE_AUTO_RECIPE_WARNING,
  SIGN_IN_RULE_HONEST_LIMIT,
  SIGN_IN_RULE_INELIGIBLE_WORDS,
  SIGN_IN_RULE_MIN_SECONDS,
  SIGN_IN_RULE_ROOT_WARNING,
  SIGN_IN_RULE_STAGE_TTL_SECONDS,
  SIGN_IN_RULE_TERMINAL_HONEST_LIMIT,
  SIGN_IN_RULE_TERMINAL_RESIDUAL,
  SIGN_IN_RULE_TOTP_WARNING,
  SIGN_IN_RULES_SCREEN_PATH,
  SignInIdSchema,
  type SignInRuleDraft,
  type SignInRuleNarrow,
  type SignInRuleScope,
  SignInRuleScopeSchema,
  type SignInRuleStaged,
  type SignInRuleStageId,
  type SignInRuleView,
  signInRuleFieldWords,
  signInRuleResumable,
  signInRuleScopeWords,
  signInRuleStatusWords,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { daemonNeedsUpdate } from '../daemon/features.ts';
import { refuseOwnerCommandInPane } from '../daemon/owner-only.ts';
import { showUntrusted } from '../input/render.ts';
import { parseLifetime, unique } from '../plan/controller.ts';
import { RULES_FEATURE_WORDS } from './gateway.ts';
import type { RulesPorts } from './ports.ts';

/** Options every `fy rules` command accepts. */
export interface RulesCommandOptions {
  readonly json?: boolean | undefined;
}

/** `fy rules add|resume|renew|widen` flags. */
export interface RulesStageOptions extends RulesCommandOptions {
  readonly username?: boolean | undefined;
  readonly totp?: boolean | undefined;
  readonly iUnderstandOneFactor?: boolean | undefined;
  readonly scope?: string | undefined;
  readonly expires?: string | undefined;
  readonly uses?: string | undefined;
  /** Opens the rule's page in this host's browser once it is staged. */
  readonly open?: boolean | undefined;
}

/** `fy rules rm` flags. */
export interface RulesRemoveOptions extends RulesCommandOptions {
  /** Ends every rule of this account instead of one rule. */
  readonly account?: string | undefined;
}

/** `fy rules narrow` flags. */
export interface RulesNarrowOptions extends RulesCommandOptions {
  readonly dropTotp?: boolean | undefined;
  readonly expires?: string | undefined;
  readonly uses?: string | undefined;
}

/** Said when a paste rule's id is given to `fy rules rm`. */
export const PASTE_RULE_POINTER =
  'that is not a standing sign-in rule (those start sr_). A paste rule is removed with: fy copy rules rm <id>';

const POLL_MS = 1_000;
/** The stage lapses at the daemon after this long; the wait outlasts it by a few seconds so the last word is heard. */
const WAIT_SECONDS = SIGN_IN_RULE_STAGE_TTL_SECONDS + 5;
const LISTING = 'rules ls';
/** The command that prints every sign-in's id (si_…), which `fy rules add` takes. */
export const SIGN_IN_LISTING = 'fy account site ls';
/** The command that prints every account's id, which `fy rules rm --account` takes. */
export const ACCOUNT_LISTING = 'fy account ls';

const placeWords = (place: SignInRuleView['place']): string => placeKeys(place).map(showUntrusted).join(', ');

/** The start of a rule id a command takes back (`sr_` and eight more), as every hint prints it. */
const shortId = (rule: Pick<SignInRuleView, 'id'>): string => rule.id.slice(0, 11);

/**
 * What a staged or listed rule warns of, drawn from its STRUCTURED flags and never from its rows' words, which may be
 * clipped (secrev-1301 L2): ONE red block (a terminal rule's root line and its residual sentence, then a code's own
 * sentence, each when it applies), the amber auto-recipe line, then "How it's checked:" with the proof and the honest
 * limit under it.
 */
export function ruleWarnings(
  rule: { readonly root: boolean; readonly totp: boolean; readonly autoRecipe: boolean },
  red: (text: string) => string,
): readonly string[] {
  const block = [
    ...(rule.root ? [SIGN_IN_RULE_ROOT_WARNING, SIGN_IN_RULE_TERMINAL_RESIDUAL] : []),
    ...(rule.totp ? [SIGN_IN_RULE_TOTP_WARNING] : []),
  ];
  return [
    ...(block.length === 0 ? [] : [red(block.join(' '))]),
    ...(rule.autoRecipe ? [SIGN_IN_RULE_AUTO_RECIPE_WARNING] : []),
    "How it's checked:",
    ...(rule.root ? [`  ${SIGN_IN_RULE_TERMINAL_HONEST_LIMIT}`] : []),
    `  ${SIGN_IN_RULE_HONEST_LIMIT}`,
  ];
}

/** "used 3×, last <when>", or "not used yet": the app's Uses row says the same. */
const usedWords = (usage: SignInRuleView['usage']): string =>
  usage.count === 0
    ? 'not used yet'
    : `used ${String(usage.count)}×${usage.lastUsedAt === undefined ? '' : `, last ${usage.lastUsedAt}`}`;

/** A listed rule in words: its status, what it types, for whom (the protocol's words for each), its end and its use. */
function renderRule(rule: SignInRuleView, red: (text: string) => string): string {
  const cap = rule.uses === undefined ? '' : `, ${String(rule.remaining ?? 0)} of ${String(rule.uses)} uses left`;
  const head = `${rule.id}  ${signInRuleStatusWords(rule)}  ${showUntrusted(rule.account.id)} (${showUntrusted(rule.account.label)}) at ${placeWords(rule.place)}  types ${signInRuleFieldWords(rule.fields)}  who: ${showUntrusted(signInRuleScopeWords(rule.scope))}  until ${rule.expiresAt}${cap}  ${usedWords(rule.usage)}`;
  const lines = [head];
  // A rule whose sign-in is gone cannot be resumed (the app offers no Resume either): no hint to a command that fails.
  if (rule.suspended !== undefined)
    lines.push(
      `   suspended ${rule.suspended.at}${signInRuleResumable(rule) ? ` (fy rules resume ${shortId(rule)})` : ''}`,
    );
  if (rule.unverified === true) lines.push('   not checked yet: it fills nothing until the daemon has checked it');
  lines.push(
    ...ruleWarnings(
      { root: rule.flags.includes('root'), totp: rule.totp, autoRecipe: rule.flags.includes('auto-recipe') },
      red,
    ).map(line => `   ${line}`),
  );
  return lines.join('\n');
}

/** The staged rule in the one shape every app shows: what it does, the facts the passkey binds, then the warnings. */
function renderStaged(staged: SignInRuleStaged, red: (text: string) => string): readonly string[] {
  const width = Math.max(...staged.rows.map(row => row.label.length));
  return [
    `  ${showUntrusted(staged.does)}`,
    ...staged.rows.map(row => `  ${row.label.padEnd(width)}  ${showUntrusted(row.value)}`),
    ...ruleWarnings(staged, red).map(line => `  ${line}`),
  ];
}

/**
 * Drives `fy rules`: the owner reads their standing sign-in rules, stages a new, resumed, renewed or widened one,
 * narrows one and revokes one. A rule is NEVER approved here: it is staged, shown in the app, and committed by a passkey
 * there. There is no commit call in {@link IRulesGateway} for this to make, and the machine's token could not make its
 * proof anyway. Refused inside a ferret's pane, and again by the daemon's route spine.
 */
export class RulesController {
  constructor(private readonly ports: RulesPorts) {}

  async list(options: RulesCommandOptions): Promise<void> {
    refuseOwnerCommandInPane(this.ports);
    const list = await this.ports.gateway.list();
    const { red } = this.ports;
    const damaged =
      list.health === 'damaged' ? ['The rules file is damaged: no rule fills until you make a new one.'] : [];
    this.ports.out.success(
      options.json === true
        ? JSON.stringify(list, null, 2)
        : [
            ...damaged,
            ...(list.rules.length === 0
              ? ['no standing sign-in rules']
              : list.rules.map(rule => renderRule(rule, red))),
            ...(list.stages.length === 0
              ? []
              : [
                  'waiting for your passkey in the app:',
                  ...list.stages.flatMap(staged => [
                    `${staged.stage}  until ${staged.stageExpiresAt}`,
                    ...renderStaged(staged, red),
                  ]),
                ]),
          ].join('\n'),
    );
  }

  async add(signIn: string, options: RulesStageOptions): Promise<void> {
    refuseOwnerCommandInPane(this.ports);
    const id = SignInIdSchema.safeParse(signIn.trim());
    if (!id.success) throw new Error(`"${signIn}" is not a sign-in: name one as si_… (see \`${SIGN_IN_LISTING}\`)`);
    const code = this.#code(options);
    const draft: SignInRuleDraft = {
      signIn: id.data,
      fields: options.username === true ? ['username', 'password'] : ['password'],
      ...(code ? { totp: true, totpAcknowledged: true as const } : {}),
      ...this.#terms(options),
    };
    await this.#stageAndWait(draft, options);
  }

  async resume(reference: string, options: RulesStageOptions): Promise<void> {
    refuseOwnerCommandInPane(this.ports);
    const rule = await this.#rule(reference);
    if (rule.status !== 'suspended')
      throw new Error(
        `the rule ${rule.id} is not suspended (${signInRuleStatusWords(rule)}): use \`fy rules renew ${shortId(rule)}\` to approve it again`,
      );
    if (!signInRuleResumable(rule))
      throw new Error(
        `the rule ${rule.id} can't be resumed: ${signInRuleStatusWords(rule)}. Revoke it with \`fy rules rm ${shortId(rule)}\``,
      );
    await this.#restage(rule, { ...options, expires: undefined, uses: undefined }, 'resume');
  }

  async renew(reference: string, options: RulesStageOptions): Promise<void> {
    refuseOwnerCommandInPane(this.ports);
    await this.#restage(await this.#rule(reference), options, 'renew');
  }

  /**
   * Gives a rule MORE (the username, the 2FA code, another scope, more uses or a later end): the same rule staged again
   * with `replaces`, like a renew, so a fresh passkey in the app approves it. Every term not named keeps the old rule's;
   * one that cannot be kept (no uses left, or under an hour left) must be named, so a widen never extends anything
   * silently. A widen that gives nothing more is refused and pointed to `fy rules narrow`.
   */
  async widen(reference: string, options: RulesStageOptions): Promise<void> {
    refuseOwnerCommandInPane(this.ports);
    const code = this.#code(options);
    const uses = this.#count(options.uses, 1);
    const lifetime = options.expires === undefined ? undefined : parseLifetime(options.expires);
    const scope = options.scope === undefined ? undefined : parseScope(options.scope);
    const rule = await this.#rule(reference);
    const short = shortId(rule);
    if (rule.totp && !code)
      throw new Error(
        `the rule ${rule.id} types a 2FA code: a widen keeps it only with --totp --i-understand-one-factor (to drop the code, \`fy rules narrow ${short} --drop-totp\`)`,
      );
    const nowMs = this.ports.nowMs();
    const leftSeconds = Math.floor((Date.parse(rule.expiresAt) - nowMs) / 1_000);
    if (lifetime === undefined && leftSeconds < SIGN_IN_RULE_MIN_SECONDS)
      throw new Error(`the rule ${rule.id} has under an hour left: say how long it lasts with --expires`);
    const usesLeft = rule.uses === undefined ? undefined : (rule.remaining ?? 0);
    if (uses === undefined && usesLeft === 0)
      throw new Error(`the rule ${rule.id} has no uses left: say how many with --uses N`);
    const wider = [
      ...(options.username === true && !rule.fields.includes('username') ? ['the username'] : []),
      ...(code && !rule.totp ? ['the 2FA code'] : []),
      ...(scope !== undefined && !sameScope(scope, rule.scope)
        ? [`who: ${showUntrusted(signInRuleScopeWords(scope))}`]
        : []),
      ...(uses !== undefined && usesLeft !== undefined && uses > usesLeft ? [`${String(uses)} uses`] : []),
      ...(lifetime !== undefined && nowMs + lifetime * 1_000 > Date.parse(rule.expiresAt) ? ['a later end'] : []),
    ];
    if (wider.length === 0)
      throw new Error(
        `nothing here widens the rule ${rule.id}: a widen adds the username (--username), the 2FA code (--totp --i-understand-one-factor), another scope (--scope), more uses (--uses) or a later end (--expires). To take something away: \`fy rules narrow ${short}\``,
      );
    const kept = (field: 'username' | 'password'): boolean =>
      rule.fields.includes(field) || (field === 'username' && options.username === true);
    const draft: SignInRuleDraft = {
      signIn: rule.signIn,
      fields: (['username', 'password'] as const).filter(kept),
      ...(code ? { totp: true, totpAcknowledged: true as const } : {}),
      scope: scope ?? rule.scope,
      lifetimeSeconds: lifetime ?? leftSeconds,
      ...(uses !== undefined ? { uses } : usesLeft === undefined ? {} : { uses: usesLeft }),
      replaces: rule.id,
    };
    this.#say(options, `Widening ${short}: ${wider.join(', ')}. Everything else stays as it is.`);
    await this.#stageAndWait(draft, options);
  }

  /** Takes something away. It needs no passkey, so the daemon refuses anything that is not strictly narrower. */
  async narrow(reference: string, options: RulesNarrowOptions): Promise<void> {
    refuseOwnerCommandInPane(this.ports);
    const uses = this.#count(options.uses, 0);
    const narrow: SignInRuleNarrow = {
      ...(options.dropTotp === true ? { dropTotp: true as const } : {}),
      ...(options.expires === undefined
        ? {}
        : { expiresAt: new Date(this.ports.nowMs() + parseLifetime(options.expires) * 1_000).toISOString() }),
      ...(uses === undefined ? {} : { uses }),
    };
    if (Object.keys(narrow).length === 0)
      throw new Error('narrow the code (--drop-totp), the end (--expires) or the cap (--uses)');
    const rule = await this.#rule(reference);
    const narrowed = await this.ports.gateway.narrow(rule.id, narrow);
    this.ports.out.success(
      options.json === true ? JSON.stringify(narrowed, null, 2) : `Narrowed.\n${renderRule(narrowed, this.ports.red)}`,
    );
  }

  /** `fy rules rm` (alias `revoke`): revokes one rule, or every rule of an account. No passkey: it only takes away. */
  async remove(reference: string | undefined, options: RulesRemoveOptions): Promise<void> {
    refuseOwnerCommandInPane(this.ports);
    if (options.account !== undefined) {
      if (reference !== undefined) throw new Error('name a rule or --account, not both');
      return await this.#removeAccount(options.account, options);
    }
    if (reference === undefined)
      throw new Error('name the rule to revoke (sr_…), or --account <ACCOUNT> for all of one account');
    if (!reference.trim().startsWith('sr_')) throw new Error(PASTE_RULE_POINTER);
    const rule = await this.#rule(reference);
    await this.ports.gateway.revoke(rule.id);
    this.ports.out.success(
      options.json === true ? JSON.stringify({ revoked: rule.id }) : `Revoked the rule ${rule.id}.`,
    );
  }

  /** `revokedCount`, not the wire's `revoked`: the one-rule answer's `revoked` is an id, and one key has one type. */
  async #removeAccount(account: string, options: RulesCommandOptions): Promise<void> {
    const id = AccountIdSchema.safeParse(account.trim());
    if (!id.success) throw new Error(`"${account}" is not an account id: see \`${ACCOUNT_LISTING}\``);
    const revoked = await this.ports.gateway.revokeAccount(id.data);
    this.ports.out.success(
      options.json === true
        ? JSON.stringify({ account: id.data, revokedCount: revoked })
        : revoked === 0
          ? `${id.data} had no standing rules.`
          : `Revoked ${String(revoked)} standing ${revoked === 1 ? 'rule' : 'rules'} of ${id.data}.`,
    );
  }

  /** Stages the same rule again (same id, next revision): the owner's passkey is what makes it a new approval. */
  async #restage(rule: SignInRuleView, options: RulesStageOptions, verb: 'resume' | 'renew'): Promise<void> {
    const code = this.#code(options);
    const uses = this.#count(options.uses, 1) ?? rule.uses;
    // A cap narrowed to 0 cannot be approved again as it is: a rule's cap is at least one use.
    if (uses === 0) throw new Error(`the rule ${rule.id} has a cap of 0 uses: say how many with --uses N`);
    if (rule.totp && !code)
      this.#say(
        options,
        `The rule types a 2FA code; ${verb === 'resume' ? 'resuming' : 'renewing'} it without --totp --i-understand-one-factor drops the code.`,
      );
    const draft: SignInRuleDraft = {
      signIn: rule.signIn,
      fields: rule.fields.filter((field): field is 'username' | 'password' => field !== 'totp'),
      ...(rule.totp && code ? { totp: true, totpAcknowledged: true as const } : {}),
      scope: rule.scope,
      ...(uses === undefined ? {} : { uses }),
      ...(options.expires === undefined ? {} : { lifetimeSeconds: parseLifetime(options.expires) }),
      replaces: rule.id,
    };
    await this.#stageAndWait(draft, options);
  }

  /** `--totp` needs its acknowledgement, which is the whole of the red warning; one without the other is refused. */
  #code(options: RulesStageOptions): boolean {
    if (options.totp === true && options.iUnderstandOneFactor !== true)
      throw new Error(
        `--totp makes the sign-in one factor. ${SIGN_IN_RULE_TOTP_WARNING} Add --i-understand-one-factor to go on.`,
      );
    if (options.totp !== true && options.iUnderstandOneFactor === true)
      throw new Error('--i-understand-one-factor goes with --totp only');
    return options.totp === true;
  }

  #terms(options: RulesStageOptions): Pick<SignInRuleDraft, 'scope' | 'lifetimeSeconds' | 'uses'> {
    const uses = this.#count(options.uses, 1);
    return {
      ...(options.scope === undefined ? {} : { scope: parseScope(options.scope) }),
      ...(options.expires === undefined ? {} : { lifetimeSeconds: parseLifetime(options.expires) }),
      ...(uses === undefined ? {} : { uses }),
    };
  }

  /**
   * `--uses`, as a whole number of at least `least`: 1 for a rule a passkey approves (its cap is at least one use, and
   * a 0 would otherwise reach the owner as the draft schema's raw error), 0 for a narrowing, which may end the uses.
   */
  #count(text: string | undefined, least: 0 | 1): number | undefined {
    if (text === undefined) return undefined;
    const count = Number(text);
    if (!Number.isInteger(count) || count < least)
      throw new Error(`--uses "${text}" is not a whole number${least === 1 ? ' of at least 1' : ''}`);
    return count;
  }

  #say(options: RulesCommandOptions, message: string): void {
    if (options.json === true) this.ports.out.diagnostic(message);
    else this.ports.out.success(message);
  }

  async #stageAndWait(draft: SignInRuleDraft, options: RulesStageOptions): Promise<void> {
    const { gateway } = this.ports;
    // A health read that fails says so (`DaemonFeaturesUnreadable`): only a daemon that answered is called too old.
    const features = await gateway.features();
    if (!features.includes(DAEMON_FEATURES.signInRules)) throw new Error(daemonNeedsUpdate(RULES_FEATURE_WORDS));
    const eligibility = await gateway.eligibility(draft.signIn);
    if (!eligibility.eligible) throw new Error(SIGN_IN_RULE_INELIGIBLE_WORDS[eligibility.because]);
    const startedMs = this.ports.nowMs();
    const staged = await gateway.stage(draft);
    if (staged.root && !features.includes(DAEMON_FEATURES.signInRulesTerminal)) {
      await gateway.drop(staged.stage).catch(() => undefined);
      throw new Error(
        'a rule for sudo, su or doas is not offered by this daemon (it does not report terminal rules): nothing was staged',
      );
    }
    for (const line of renderStaged(staged, this.ports.red)) this.#say(options, line);
    const confirming = await gateway.confirmInApp(staged.stage);
    this.#say(
      options,
      `Confirm it with your passkey in the Ferretry app (${SIGN_IN_RULES_SCREEN_PATH}). Nothing is approved until you do; waiting up to ${String(SIGN_IN_RULE_STAGE_TTL_SECONDS / 60)} minutes…`,
    );
    await this.#showLink(confirming.stage, options);
    const state = await this.#wait(staged.stage);
    const elsewhere = state === 'denied' ? await this.#approvedElsewhere(draft.signIn, startedMs) : undefined;
    this.ports.out.success(
      options.json === true
        ? JSON.stringify(
            {
              stage: staged.stage,
              rule: staged.rule,
              state,
              ...(elsewhere === undefined ? {} : { approvedElsewhere: elsewhere.id }),
            },
            null,
            2,
          )
        : elsewhere === undefined
          ? OUTCOME[state](staged)
          : `Approved in the app (from another stage): ${elsewhere.id} until ${elsewhere.expiresAt}`,
    );
  }

  /** A newer stage for the same sign-in turns this one `denied`; a rule the owner approved from it is in force, not refused. */
  async #approvedElsewhere(signIn: string, sinceMs: number): Promise<SignInRuleView | undefined> {
    const { rules } = await this.ports.gateway.list();
    return rules.find(
      rule => rule.signIn === signIn && rule.status === 'active' && Date.parse(rule.createdAt) >= sinceMs,
    );
  }

  /**
   * Prints the link that opens the rule's page, and opens it with `--open`. It carries no secret: it only picks a stage,
   * and the machine that holds it when this daemon's id can be read (without one, the app opens its selected machine).
   */
  async #showLink(stage: SignInRuleStageId, options: RulesStageOptions): Promise<void> {
    const { appOrigin, appOriginNote, openLink, machine } = this.ports;
    if (appOrigin === undefined) {
      if (options.open === true)
        this.#say(options, '--open has nowhere to open: this machine does not know the app address.');
      return;
    }
    const daemonId = machine === undefined ? undefined : await machine().catch(() => undefined);
    const link = ruleDeepLink(appOrigin, stage, daemonId);
    if (appOriginNote !== undefined) this.#say(options, appOriginNote);
    this.#say(options, `Open the rule: ${link}`);
    if (options.open !== true) return;
    this.#say(
      options,
      openLink !== undefined && (await openLink(link))
        ? 'Opened it in your browser.'
        : 'Could not open a browser here; use the link above.',
    );
  }

  async #wait(stage: string): Promise<keyof typeof OUTCOME> {
    const until = this.ports.nowMs() + WAIT_SECONDS * 1_000;
    for (;;) {
      const view = await this.ports.gateway.view(stage).catch((error: unknown) => {
        if (error instanceof FyHttpError && error.status === 404) return undefined;
        throw error;
      });
      if (view === undefined) return 'expired';
      if (view.state !== 'waiting') return view.state;
      if (this.ports.nowMs() >= until) return 'expired';
      await this.ports.sleep(POLL_MS);
    }
  }

  async #rule(reference: string): Promise<SignInRuleView> {
    const { rules } = await this.ports.gateway.list();
    const ref = reference.trim();
    if (ref !== '' && !ref.startsWith('sr_'))
      throw new Error(`"${reference}" is not a standing sign-in rule id (those start sr_; see \`fy ${LISTING}\`)`);
    return unique(
      rules.filter(rule => rule.id.startsWith(ref)),
      reference,
      'rule',
      LISTING,
    );
  }
}

const sameScope = (left: SignInRuleScope, right: SignInRuleScope): boolean =>
  signInRuleScopeWords(left) === signInRuleScopeWords(right);

function parseScope(text: string): SignInRuleScope {
  const [kind, ...rest] = text.trim().split(':');
  const value = rest.join(':');
  const parsed = SignInRuleScopeSchema.safeParse(
    kind === 'any' && value === ''
      ? { kind }
      : kind === 'project'
        ? { kind, project: value }
        : kind === 'session'
          ? { kind, session: value }
          : undefined,
  );
  if (!parsed.success) throw new Error(`--scope "${text}" is not any, project:<uuid> or session:<id>`);
  return parsed.data;
}

const OUTCOME: Readonly<Record<'approved' | 'denied' | 'expired', (staged: SignInRuleStaged) => string>> = {
  approved: staged =>
    `Approved. The rule ${staged.rule} is in force until ${staged.expiresAt}; any ferret may use this sign-in until then.`,
  denied: staged => `Denied. The rule ${staged.rule} was not approved.`,
  expired: staged => `Timed out. The rule ${staged.rule} was not approved; run the command again.`,
};
