import {
  DAEMON_FEATURES,
  LOGIN_ONE_FACTOR_WARNING,
  placeKeys,
  SIGN_IN_RULE_HONEST_LIMIT,
  SIGN_IN_RULE_ROOT_WARNING,
  SIGN_IN_RULE_STAGE_TTL_SECONDS,
  SIGN_IN_RULE_TERMINAL_HONEST_LIMIT,
  SignInIdSchema,
  type SignInRuleDraft,
  type SignInRuleNarrow,
  type SignInRuleScope,
  SignInRuleScopeSchema,
  type SignInRuleStaged,
  type SignInRuleView,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { showUntrusted } from '../input/render.ts';
import { parseLifetime, unique } from '../plan/controller.ts';
import type { RulesPorts } from './ports.ts';

/** Options every `fy rules` command accepts. */
export interface RulesCommandOptions {
  readonly json?: boolean | undefined;
}

/** `fy rules add|resume|renew` flags. */
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

/** `fy rules narrow` flags. */
export interface RulesNarrowOptions extends RulesCommandOptions {
  readonly dropTotp?: boolean | undefined;
  readonly expires?: string | undefined;
  readonly uses?: string | undefined;
}

/** Said to a ferret that runs any `fy rules` command. */
export const RULES_FERRET_REFUSAL =
  "this is the owner's command; a ferret cannot make or change a standing sign-in rule";

function refuseFerret(caller: {
  readonly ownSessionId: string | undefined;
  readonly agentCredential: string | undefined;
}): void {
  if ((caller.ownSessionId?.trim() ?? '') !== '' || (caller.agentCredential?.trim() ?? '') !== '')
    throw new Error(RULES_FERRET_REFUSAL);
}

/** Said when a paste rule's id is given to `fy rules rm`. */
export const PASTE_RULE_POINTER =
  'that is not a standing sign-in rule (those start sr_). A paste rule is removed with: fy copy rules rm <id>';

const POLL_MS = 1_000;
/** The stage lapses at the daemon after this long; the wait outlasts it by a few seconds so the last word is heard. */
const WAIT_SECONDS = SIGN_IN_RULE_STAGE_TTL_SECONDS + 5;
const LISTING = 'rules ls';

const placeWords = (place: SignInRuleView['place']): string => placeKeys(place).map(showUntrusted).join(', ');

/** The amber line for a sign-in whose recipe takes a ferret's edits unreviewed. */
export const AUTO_RECIPE_WARNING = "Its recipe takes a ferret's edits without your review.";

/**
 * The warnings a staged or listed rule carries, drawn from its STRUCTURED flags and never from its summary's words,
 * which may be clipped (secrev-1301 L2): the red root line and the residual sentence for a terminal rule, the red
 * one-factor line for a code, the auto-recipe line, and the honest limit on every rule.
 */
export function ruleWarnings(
  rule: { readonly root: boolean; readonly totp: boolean; readonly autoRecipe: boolean },
  red: (text: string) => string,
): readonly string[] {
  return [
    ...(rule.root ? [red(SIGN_IN_RULE_ROOT_WARNING), SIGN_IN_RULE_TERMINAL_HONEST_LIMIT] : []),
    ...(rule.totp ? [red(LOGIN_ONE_FACTOR_WARNING)] : []),
    ...(rule.autoRecipe ? [AUTO_RECIPE_WARNING] : []),
    SIGN_IN_RULE_HONEST_LIMIT,
  ];
}

const scopeWords = (scope: SignInRuleScope): string =>
  scope.kind === 'any'
    ? 'any ferret'
    : scope.kind === 'project'
      ? `project ${scope.project}`
      : `session ${showUntrusted(scope.session)}`;

function renderRule(rule: SignInRuleView, red: (text: string) => string): string {
  const cap = rule.uses === undefined ? '' : `, ${String(rule.remaining ?? 0)} of ${String(rule.uses)} uses left`;
  const head = `${rule.id}  ${rule.status}  ${showUntrusted(rule.account.id)} (${showUntrusted(rule.account.label)}) at ${placeWords(rule.place)}  types ${rule.fields.join(', ')}  for ${scopeWords(rule.scope)}  until ${rule.expiresAt}${cap}`;
  const lines = [head];
  if (rule.suspended !== undefined)
    lines.push(`   stopped ${rule.suspended.at}: ${rule.suspended.because} (fy rules resume ${rule.id.slice(0, 11)})`);
  if (rule.unverified === true) lines.push('   not checked yet: it fills nothing until the daemon has checked it');
  lines.push(
    ...ruleWarnings(
      { root: rule.flags.includes('root'), totp: rule.totp, autoRecipe: rule.flags.includes('auto-recipe') },
      red,
    ).map(line => `   ${line}`),
  );
  return lines.join('\n');
}

function renderStaged(staged: SignInRuleStaged, red: (text: string) => string): readonly string[] {
  return [
    ...staged.summary.map(line => `  ${showUntrusted(line)}`),
    ...ruleWarnings(staged, red).map(line => `  ${line}`),
  ];
}

/**
 * Drives `fy rules`: the owner reads their standing sign-in rules, stages a new, resumed or renewed one, narrows one
 * and ends one. A rule is NEVER approved here: it is staged, shown in the app, and committed by a passkey there. There
 * is no commit call in {@link IRulesGateway} for this to make, and the machine's token could not make its proof
 * anyway. Refused inside a ferret's pane, and again by the daemon's route spine.
 */
export class RulesController {
  constructor(private readonly ports: RulesPorts) {}

  async list(options: RulesCommandOptions): Promise<void> {
    refuseFerret(this.ports);
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
    refuseFerret(this.ports);
    const id = SignInIdSchema.safeParse(signIn.trim());
    if (!id.success) throw new Error(`"${signIn}" is not a sign-in: name one as si_… (see \`fy accounts\`)`);
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
    refuseFerret(this.ports);
    const rule = await this.#rule(reference);
    if (rule.status !== 'suspended')
      throw new Error(
        `the rule ${rule.id} is ${rule.status}, not suspended: use \`fy rules renew ${rule.id.slice(0, 11)}\` to approve it again`,
      );
    await this.#restage(rule, { ...options, expires: undefined }, 'resume');
  }

  async renew(reference: string, options: RulesStageOptions): Promise<void> {
    refuseFerret(this.ports);
    await this.#restage(await this.#rule(reference), options, 'renew');
  }

  /** Takes something away. It needs no passkey, so the daemon refuses anything that is not strictly narrower. */
  async narrow(reference: string, options: RulesNarrowOptions): Promise<void> {
    refuseFerret(this.ports);
    const uses = this.#count(options.uses);
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

  async remove(reference: string, options: RulesCommandOptions): Promise<void> {
    refuseFerret(this.ports);
    if (!reference.trim().startsWith('sr_')) throw new Error(PASTE_RULE_POINTER);
    const rule = await this.#rule(reference);
    await this.ports.gateway.revoke(rule.id);
    this.ports.out.success(options.json === true ? JSON.stringify({ revoked: rule.id }) : `Ended the rule ${rule.id}.`);
  }

  /** Stages the same rule again (same id, next revision): the owner's passkey is what makes it a new approval. */
  async #restage(rule: SignInRuleView, options: RulesStageOptions, verb: 'resume' | 'renew'): Promise<void> {
    const code = this.#code(options);
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
      ...(rule.uses === undefined ? {} : { uses: rule.uses }),
      ...(options.expires === undefined ? {} : { lifetimeSeconds: parseLifetime(options.expires) }),
      replaces: rule.id,
    };
    await this.#stageAndWait(draft, options);
  }

  /** `--totp` needs its acknowledgement, which is the whole of the red warning; one without the other is refused. */
  #code(options: RulesStageOptions): boolean {
    if (options.totp === true && options.iUnderstandOneFactor !== true)
      throw new Error(
        `--totp makes the sign-in one factor. ${LOGIN_ONE_FACTOR_WARNING} Add --i-understand-one-factor to go on.`,
      );
    if (options.totp !== true && options.iUnderstandOneFactor === true)
      throw new Error('--i-understand-one-factor goes with --totp only');
    return options.totp === true;
  }

  #terms(options: RulesStageOptions): Pick<SignInRuleDraft, 'scope' | 'lifetimeSeconds' | 'uses'> {
    const uses = this.#count(options.uses);
    return {
      ...(options.scope === undefined ? {} : { scope: parseScope(options.scope) }),
      ...(options.expires === undefined ? {} : { lifetimeSeconds: parseLifetime(options.expires) }),
      ...(uses === undefined ? {} : { uses }),
    };
  }

  #count(text: string | undefined): number | undefined {
    if (text === undefined) return undefined;
    const count = Number(text);
    if (!Number.isInteger(count) || count < 0) throw new Error(`--uses "${text}" is not a whole number`);
    return count;
  }

  #say(options: RulesCommandOptions, message: string): void {
    if (options.json === true) this.ports.out.diagnostic(message);
    else this.ports.out.success(message);
  }

  async #stageAndWait(draft: SignInRuleDraft, options: RulesStageOptions): Promise<void> {
    const { gateway } = this.ports;
    const features = await gateway.features();
    if (!features.includes(DAEMON_FEATURES.signInRules))
      throw new Error(
        'standing sign-in rules can only be confirmed in the app, and this daemon does not report them yet: nothing was staged',
      );
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
      `Confirm it with your passkey in the Ferretry app (Settings › Rules). Nothing is approved until you do; waiting up to ${String(SIGN_IN_RULE_STAGE_TTL_SECONDS / 60)} minutes…`,
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

  /** Prints the link that opens the rule's page, and opens it with `--open`. It carries no secret: it only picks a stage. */
  async #showLink(stage: string, options: RulesStageOptions): Promise<void> {
    const { appOrigin, appOriginNote, openLink } = this.ports;
    if (appOrigin === undefined) {
      if (options.open === true)
        this.#say(options, '--open has nowhere to open: this machine does not know the app address.');
      return;
    }
    const link = `${appOrigin.replace(/\/+$/u, '')}/#rules/${encodeURIComponent(stage)}`;
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
