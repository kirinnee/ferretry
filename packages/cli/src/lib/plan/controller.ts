import {
  type CopyMeta,
  type CopyRouteFrom,
  CopyRouteFromSchema,
  type CopyRouteTo,
  CopyRouteToSchema,
  DAEMON_FEATURES,
  PASSKEY_CHALLENGE_TTL_SECONDS,
  PASTE_RULES_SCREEN_PATH,
  type PasteRule,
  type PasteRuleCreate,
  type PasteRuleList,
  type PasteRuleSettingsView,
  type PasteRuleStaged,
  type PasteRuleStageState,
  RUNS_WHAT_IT_READS_WARNING,
  runsWhatItReads,
  STEP_UP_REQUIRED_CODE,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { daemonNeedsUpdate, isUnknownRoute } from '../daemon/features.ts';
import { OWNER_COMMAND_REFUSAL, refuseOwnerCommandInPane } from '../daemon/owner-only.ts';
import { showUntrusted } from '../input/render.ts';
import type { CopyPorts } from './ports.ts';

/** Options every `fy copy` command accepts. */
export interface CopyCommandOptions {
  readonly session?: string | undefined;
  readonly json?: boolean | undefined;
}

/** `fy copy rules add` flags. */
export interface CopyRuleOptions extends CopyCommandOptions {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly count?: string | undefined;
  readonly expires?: string | undefined;
}

/** Said when a ferret reaches for the owner's command: the one neutral sentence, a read refused as well as a change. */
export const COPY_FERRET_REFUSAL = OWNER_COMMAND_REFUSAL;

const UNITS: Readonly<Record<string, number>> = { s: 1, m: 60, h: 3_600, d: 86_400 };

/** `90`, `30m`, `2h` or `7d`, in seconds. */
export function parseLifetime(text: string): number {
  const match = /^([1-9][0-9]*)([smhd]?)$/u.exec(text.trim());
  if (match === null) throw new Error(`--expires "${text}" is not a time like 30m, 2h or 7d`);
  return Number(match[1]) * (UNITS[match[2] === '' ? 's' : (match[2] as string)] ?? 1);
}

/** `command:gh`, `browser:https://github.com` or `clipboard:https://github.com`. */
export function parseFrom(text: string): CopyRouteFrom {
  const [kind, ...rest] = text.split(':');
  const value = rest.join(':');
  const parsed = CopyRouteFromSchema.safeParse(kind === 'command' ? { kind, program: value } : { kind, origin: value });
  if (!parsed.success)
    throw new Error(`--from "${text}" is not command:<program>, browser:<origin> or clipboard:<origin>`);
  return parsed.data;
}

/** `terminal:vercel`, `browser:https://vercel.com` or `secret:VERCEL_TOKEN`. */
export function parseTo(text: string): CopyRouteTo {
  const [kind, ...rest] = text.split(':');
  const value = rest.join(':');
  const parsed = CopyRouteToSchema.safeParse(
    kind === 'terminal'
      ? { kind, program: value }
      : kind === 'secret'
        ? { kind, name: value }
        : { kind, origin: value },
  );
  if (!parsed.success) throw new Error(`--to "${text}" is not terminal:<program>, browser:<origin> or secret:<NAME>`);
  return parsed.data;
}

export const fromText = (from: CopyRouteFrom): string =>
  from.kind === 'command' ? `command:${from.program}` : `${from.kind}:${from.origin}`;
export const toText = (to: CopyRouteTo): string =>
  to.kind === 'terminal'
    ? `terminal:${to.program}`
    : to.kind === 'secret'
      ? `secret:${to.name}`
      : `browser:${to.origin}`;

/** What `fy copy rules profile` changes, in the words `fy copy rules ls` prints it with. */
const PROFILE_SETTING = 'programs in your own profile';

/** Said when turning the profile setting on: what it lets a ferret do. */
export const PROFILE_TARGETS_WARNING =
  'a paste rule into a terminal program may now match one from your own Nix profile (~/.nix-profile), and any ferret runs as you and can swap that program for its own';

/**
 * Said when a caller off this machine (a governed one) turns it on without a passkey confirmation: the daemon's
 * `403 grant_step_up_required`. A passkey is proved in the app, so that is where the switch is.
 */
export const PROFILE_TARGETS_NEEDS_PASSKEY =
  'turning on programs in your own profile from here needs your passkey: switch it on in the app (Settings › Secure copy › Pastes approved in advance), or run this at the machine itself. Nothing was changed';

/** What a rule into a program from the owner's own profile is labelled with (docs/secure-copy.md). */
const PROFILE_RULE_BADGE = '[your profile — a ferret could swap this program]';

/** What a rule into a shell or an interpreter is marked with. */
const RUNS_ANYTHING_MARK = '[runs whatever it reads]';

function renderRule(rule: PasteRule, inProfile = false): string {
  return [
    rule.id.slice(0, 8),
    `${fromText(rule.from)} → ${toText(rule.to)}`,
    rule.sessionId === undefined ? 'any session' : `session ${rule.sessionId}`,
    rule.remaining === undefined ? 'no count' : `${String(rule.remaining)} left`,
    rule.expiresAt === undefined ? 'no expiry' : `until ${rule.expiresAt}`,
    `used ${String(rule.used)}`,
    ...(rule.to.kind === 'terminal' && runsWhatItReads(rule.to.program) ? [RUNS_ANYTHING_MARK] : []),
    ...(inProfile ? [PROFILE_RULE_BADGE] : []),
  ].join('  ');
}

/**
 * The rules as `fy copy rules ls` prints them: whether profile programs are allowed, then one rule a line. `view` is
 * absent from a daemon too old to have the setting: then nothing is said about it.
 */
function renderRules(list: PasteRuleList, view: PasteRuleSettingsView | undefined): string {
  const profile = new Set(view?.profileRules ?? []);
  const setting = view === undefined ? [] : [`${PROFILE_SETTING}: ${profileWords(view.settings.allowProfileTargets)}`];
  const rules =
    list.rules.length === 0
      ? ['no paste rules: every paste asks you']
      : list.rules.map(rule => renderRule(rule, profile.has(rule.id)));
  return [...setting, ...rules].join('\n');
}

const profileWords = (allowed: boolean): string => (allowed ? 'allowed' : 'not allowed (they ask you)');

/** A staged paste rule as every app shows it: the daemon's line, its rows, then the red line its flag gives. */
function renderStagedRule(staged: PasteRuleStaged): readonly string[] {
  const width = Math.max(...staged.rows.map(row => row.label.length));
  return [
    `  ${showUntrusted(staged.does)}`,
    ...staged.rows.map(row => `  ${row.label.padEnd(width)}  ${showUntrusted(row.value)}`),
    ...(staged.runsAnything ? [`  ${RUNS_WHAT_IT_READS_WARNING}`] : []),
  ];
}

const STAGED_RULE_OUTCOME: Readonly<
  Record<Exclude<PasteRuleStageState, 'waiting'>, (rule: string | undefined) => string>
> = {
  approved: rule => `Approved with your passkey: the paste rule ${rule?.slice(0, 8) ?? ''} is in force.`,
  denied: () => 'Denied. No paste rule was made.',
  expired: () => 'Timed out. No paste rule was made; run the command again.',
};

function renderCopy(copy: CopyMeta): string {
  const from = showUntrusted(copy.from.origin ?? copy.from.path ?? copy.from.program ?? copy.from.kind);
  return `${copy.handle}  ${copy.state}  ${String(copy.length)} chars from ${from}  until ${copy.expiresAt}  pasted ${String(copy.uses)}${copy.exposure.transcript === 'found' ? '  [seen by the ferret before it was sealed]' : ''}`;
}

/**
 * Drives `fy copy`: the owner reads what copies a session holds (descriptions only) and approves routes in advance.
 * Refused inside a ferret's pane, and again by the daemon.
 */
export class CopyController {
  constructor(private readonly ports: CopyPorts) {}

  async list(options: CopyCommandOptions): Promise<void> {
    this.#refuseFerret();
    const session = options.session?.trim() ?? '';
    if (session === '') throw new Error('name the session with --session <id>: copies belong to one session');
    const copies = await this.ports.gateway.copies(session);
    this.ports.out.success(
      options.json === true
        ? JSON.stringify({ copies }, null, 2)
        : copies.length === 0
          ? `${session} holds no secure copies`
          : copies.map(renderCopy).join('\n'),
    );
  }

  async rules(options: CopyCommandOptions): Promise<void> {
    this.#refuseFerret();
    const [list, view] = await Promise.all([this.ports.gateway.rules(), this.#ruleSettings()]);
    this.ports.out.success(
      options.json === true
        ? JSON.stringify(view === undefined ? list : { ...list, ...view }, null, 2)
        : renderRules(list, view),
    );
  }

  /**
   * The settings and the profile marks, or `undefined` from a daemon too old to have them (a 404 only). Any other
   * failure is said on stderr, so the listing never silently drops every mark.
   */
  async #ruleSettings(): Promise<PasteRuleSettingsView | undefined> {
    try {
      return await this.ports.gateway.ruleSettings();
    } catch (cause) {
      if (!(cause instanceof FyHttpError && cause.status === 404))
        this.ports.out.diagnostic(
          `warning: could not check which rules a program in your own profile could satisfy, so none is marked: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      return undefined;
    }
  }

  /**
   * `fy copy rules profile on|off`: whether a terminal paste rule may match a program from the owner's own profile.
   * On loosens what a rule matches: the daemon lets this machine's own caller do it, and asks anyone else for a passkey.
   */
  async profile(state: string, options: CopyCommandOptions): Promise<void> {
    this.#refuseFerret();
    const word = state.trim().toLowerCase();
    if (word !== 'on' && word !== 'off') throw new Error(`say on or off, not "${state}"`);
    const allowProfileTargets = word === 'on';
    const settings = await this.ports.gateway.changeRuleSettings({ allowProfileTargets }).catch((error: unknown) => {
      if (error instanceof FyHttpError && error.code === STEP_UP_REQUIRED_CODE)
        throw new Error(PROFILE_TARGETS_NEEDS_PASSKEY);
      if (isUnknownRoute(error)) throw new Error(daemonNeedsUpdate(PROFILE_SETTING));
      throw error;
    });
    if (settings.allowProfileTargets) this.ports.out.diagnostic(`warning: ${PROFILE_TARGETS_WARNING}`);
    this.ports.out.success(
      options.json === true
        ? JSON.stringify(settings, null, 2)
        : `${PROFILE_SETTING}: ${profileWords(settings.allowProfileTargets)}`,
    );
  }

  async addRule(options: CopyRuleOptions): Promise<void> {
    this.#refuseFerret();
    if (options.from === undefined || options.to === undefined)
      throw new Error('a rule needs --from and --to, e.g. --from command:gh --to terminal:vercel');
    const count = options.count === undefined ? undefined : Number(options.count);
    if (count !== undefined && (!Number.isInteger(count) || count < 1))
      throw new Error(`--count "${options.count ?? ''}" is not a whole number of pastes`);
    const request: PasteRuleCreate = {
      from: parseFrom(options.from),
      to: parseTo(options.to),
      ...(options.session === undefined ? {} : { sessionId: options.session.trim() }),
      ...(count === undefined ? {} : { count }),
      ...(options.expires === undefined ? {} : { expiresInSeconds: parseLifetime(options.expires) }),
    };
    if ((await this.ports.gateway.features()).includes(DAEMON_FEATURES.pasteRulePasskey))
      return await this.#stageAndWait(request, options);
    // A daemon from before !A244 makes the rule in one step.
    if (request.to.kind === 'terminal' && runsWhatItReads(request.to.program))
      this.ports.out.diagnostic(`warning: ${request.to.program}: ${RUNS_WHAT_IT_READS_WARNING}`);
    const rule = await this.ports.gateway.addRule(request);
    this.ports.out.success(
      options.json === true ? JSON.stringify(rule, null, 2) : `Approved in advance: ${renderRule(rule)}`,
    );
  }

  /**
   * A PASTE RULE IS NEVER MADE HERE (owner decision !A244): it is staged, its daemon rows are shown, and the owner makes
   * it with a passkey bound to that one rule in the app. There is no commit in {@link ICopyGateway} for this to call,
   * and the machine's token could not prove one anyway. This waits for the answer, as `fy rules add` does.
   */
  async #stageAndWait(request: PasteRuleCreate, options: CopyRuleOptions): Promise<void> {
    const staged = await this.ports.gateway.stageRule(request);
    for (const line of renderStagedRule(staged)) this.#say(options, line);
    this.#say(
      options,
      `Confirm it with your passkey in the Ferretry app (${PASTE_RULES_SCREEN_PATH}). Nothing is allowed until you do; waiting up to ${String(PASSKEY_CHALLENGE_TTL_SECONDS / 60)} minutes…`,
    );
    const { state, rule } = await this.#waitFor(staged.stage);
    this.ports.out.success(
      options.json === true
        ? JSON.stringify({ stage: staged.stage, state, ...(rule === undefined ? {} : { rule }) }, null, 2)
        : STAGED_RULE_OUTCOME[state](rule),
    );
  }

  async #waitFor(
    stage: string,
  ): Promise<{ readonly state: Exclude<PasteRuleStageState, 'waiting'>; readonly rule?: string }> {
    const until = this.ports.nowMs() + (PASSKEY_CHALLENGE_TTL_SECONDS + 5) * 1_000;
    for (;;) {
      const view = await this.ports.gateway.ruleStage(stage).catch((error: unknown) => {
        if (error instanceof FyHttpError && error.status === 404) return undefined;
        throw error;
      });
      if (view === undefined) return { state: 'expired' };
      if (view.state !== 'waiting')
        return { state: view.state, ...(view.rule === undefined ? {} : { rule: view.rule }) };
      if (this.ports.nowMs() >= until) return { state: 'expired' };
      await this.ports.sleep(1_000);
    }
  }

  #say(options: CopyCommandOptions, message: string): void {
    if (options.json === true) this.ports.out.diagnostic(message);
    else this.ports.out.success(message);
  }

  async removeRule(reference: string, options: CopyCommandOptions): Promise<void> {
    this.#refuseFerret();
    const rule = await this.#rule(reference);
    await this.ports.gateway.removeRule(rule.id);
    this.ports.out.success(
      options.json === true ? JSON.stringify({ removed: rule.id }) : `Removed ${renderRule(rule)}`,
    );
  }

  async #rule(reference: string): Promise<PasteRule> {
    const { rules } = await this.ports.gateway.rules();
    return unique(
      rules.filter(rule => rule.id.startsWith(reference.trim())),
      reference,
      'rule',
      'copy rules ls',
    );
  }

  #refuseFerret(): void {
    refuseFerret(this.ports);
  }
}

/** Refuses a command run inside a ferret's pane or with an agent's credential: these are the owner's. */
export const refuseFerret = refuseOwnerCommandInPane;

/** The one thing a reference names, by the start of its id; `listing` is the command that shows them. */
export function unique<T>(found: readonly T[], reference: string, what: string, listing: string): T {
  if (reference.trim() === '') throw new Error(`name the ${what} by its id (see \`${listing}\`)`);
  if (found.length === 0) throw new Error(`no ${what} starts with "${reference}"`);
  if (found.length > 1) throw new Error(`more than one ${what} starts with "${reference}": give more of its id`);
  return found[0] as T;
}
