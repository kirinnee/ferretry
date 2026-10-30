/**
 * Settings › Warden, worked out without a browser: which entries are wrong, the plain-English summary
 * of what the settings will do, and the smallest PATCH that says what changed.
 *
 * The form edits a whole `WardenConfig`. A number field the owner cleared holds `NaN` until it is fixed,
 * so the summary can say "(fix)" instead of quoting a number nobody typed, and Save stays off.
 *
 * Exported for onboarding: the new-machine flow sets the Warden up with this same form.
 */

import {
  WARDEN_CONFIG_SECTIONS,
  type WardenAccount,
  type WardenConfig,
  type WardenConfigPatch,
  type WardenConfigView,
  type WardenEffort,
  type WardenMayActAlone,
} from '@ferretry/protocol';
import type { PickerAccount } from '../../lib/account-picker-catalog.ts';

/** Whether the Jev key is in this machine's secret store. `unknown` when that could not be read. */
export type JevKeyState = 'set' | 'missing' | 'unknown';

export interface JevKeyStatus {
  readonly state: JevKeyState;
  /** Where to get a key, from the daemon's own Speed-ups description. */
  readonly keyUrl?: string;
}

export interface WardenFormErrors {
  readonly jevUsdPerDay?: string;
  readonly investigationUsdPerDay?: string;
  readonly maxInvestigationsPerHour?: string;
  readonly maxAssignedWardens?: string;
  readonly blessMinutes?: string;
}

/** The limits the form offers. The daemon's own schema is wider; these are what a person should pick. */
export const WARDEN_FORM_LIMITS = {
  capUsd: { min: 0.01, max: 100 },
  perHour: { min: 1, max: 60 },
  atATime: { min: 1, max: 4 },
  blessMinutes: { min: 1, max: 240 },
} as const;

const CAP_ERROR = 'Enter a cap between $0.01 and $100.';
const inRange = (value: number, min: number, max: number): boolean => value >= min && value <= max;
const wholeInRange = (value: number, range: { readonly min: number; readonly max: number }): boolean =>
  Number.isInteger(value) && inRange(value, range.min, range.max);

/**
 * Only the settings in play are checked: with both layers off nothing spends or investigates, so the
 * hidden caps cannot block a save. Jev's cap is Jev's; the investigation caps are the LLM layer's; the
 * cooldown applies to a clear by either.
 */
export const wardenFormErrors = (config: WardenConfig): WardenFormErrors => {
  const { jev, llm } = config.layers;
  if (!jev && !llm) return {};
  const { capUsd, perHour, atATime, blessMinutes } = WARDEN_FORM_LIMITS;
  const errors: { -readonly [K in keyof WardenFormErrors]: string } = {};
  if (jev && !inRange(config.caps.jevUsdPerDay, capUsd.min, capUsd.max)) errors.jevUsdPerDay = CAP_ERROR;
  if (llm && !inRange(config.caps.investigationUsdPerDay, capUsd.min, capUsd.max))
    errors.investigationUsdPerDay = CAP_ERROR;
  if (llm && !wholeInRange(config.caps.maxInvestigationsPerHour, perHour)) errors.maxInvestigationsPerHour = '1 to 60.';
  if (llm && !wholeInRange(config.maxAssignedWardens, atATime)) errors.maxAssignedWardens = '1 to 4.';
  if (!wholeInRange(config.blessMinutes, blessMinutes)) errors.blessMinutes = '1 to 240 minutes.';
  return errors;
};

export const hasWardenFormErrors = (errors: WardenFormErrors): boolean => Object.keys(errors).length > 0;

const money = (amount: number): string => `$${amount.toFixed(2)}`;
const pct = (fraction: number): string => `${Math.round(fraction * 100)}%`;

/** `a`, `a and b`, `a, b and c`. */
const sentenceList = (items: readonly string[]): string =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

/** What an investigation's verdict may do alone. Closing a leftover is a rule, never a verdict. */
const ACT_ALONE_WORDS: Readonly<Record<Exclude<keyof WardenMayActAlone, 'closeLeftovers'>, string>> = {
  nudge: 'nudge',
  resume: 'resume or revive',
  restart: 'restart a dead or frozen process',
  failover: 'fail over to the next login',
  stop: 'stop',
};

/**
 * The machine default runtime the daemon stands in when the owner chose no login, or undefined when it
 * stood in none (a login was chosen, or the machine has no default, or the daemon predates the fact).
 */
export const wardenMachineDefaultLogin = (view: Pick<WardenConfigView, 'accounts' | 'login'>): string | undefined =>
  view.login?.source === 'machine_default' ? view.accounts[0]?.agent : undefined;

/**
 * The plain-English sentence under the form: what these settings will do, and what they may spend.
 * `machineDefault` names the login an empty failover order runs on; without one it is "no login".
 */
export const wardenSummary = (config: WardenConfig, hasJevKey: boolean, machineDefault?: string): string => {
  if (!config.enabled) return 'The Warden is off. Nothing watches your ferrets, and nothing spends money.';
  const every = `Every ${config.intervalMinutes} min the rules flag anomalies`;
  const { jev, llm } = config.layers;
  if (!jev && !llm) return `${every} and show them to you. No AI runs and nothing is spent.`;
  const errors = wardenFormErrors(config);
  const own = (Object.keys(ACT_ALONE_WORDS) as (keyof typeof ACT_ALONE_WORDS)[])
    .filter(action => config.mayActAlone[action])
    .map(action => ACT_ALONE_WORDS[action]);
  const acts =
    own.length === 0
      ? 'Every verdict waits for you'
      : `When an investigation’s verdict says so, it may ${sentenceList(own)} on its own`;
  const stop = config.mayActAlone.stop ? '' : '; stopping always asks you first';
  const head = config.accounts[0];
  const model = head?.model === undefined ? '' : `${head.model} `;
  // The login as written: the summary names what the owner picked, never a shortened form.
  const order =
    config.accounts.length > 0 ? config.accounts.map(account => account.agent) : [machineDefault ?? 'no login'];
  const atATime =
    errors.maxAssignedWardens === undefined ? `${config.maxAssignedWardens} at a time` : '(fix) at a time';
  const rotation =
    order.length < 2
      ? ''
      : config.failover.policy === 'round_robin'
        ? `; taking turns ${order.join(' → ')}`
        : `; failover ${order.join(' → ')}`;
  const investigation = `a read-only ${model}investigation on ${order[0]} (${config.investigation.effort} effort, ${atATime}${rotation})`;
  const invCap = errors.investigationUsdPerDay === undefined ? money(config.caps.investigationUsdPerDay) : '(fix)';
  const jevCap = errors.jevUsdPerDay === undefined ? money(config.caps.jevUsdPerDay) : '(fix)';
  const bless = errors.blessMinutes === undefined ? `${config.blessMinutes} min` : '(fix)';
  const quiet = `A cleared flag is left alone for ${bless}, twice as long each time it is cleared again, up to 4 h.`;
  if (!jev)
    return `${every}, and every flag gets ${investigation}, as kteam does. ${quiet} Cap: ${invCap}/day. ${acts}${stop}.`;
  const clears = `Jev clears a flag it is at least ${pct(config.guard.threshold)} sure is healthy`;
  if (!llm) {
    const summary = `${every}. ${clears}; every other flag is shown to you, and no investigation runs. ${quiet} Cap: ${jevCap}/day for Jev.`;
    return hasJevKey ? summary : `${summary} Needs a Jev key: until one is added, every flag is shown to you.`;
  }
  const summary = `${every}. ${clears}; anything else, including when it is unsure, goes to ${investigation}. ${quiet} Caps: ${jevCap}/day for Jev and ${invCap}/day for investigations. ${acts}${stop}.`;
  return hasJevKey ? summary : `${summary} Needs a Jev key: until one is added, every flag is investigated.`;
};

/**
 * The smallest PATCH that turns `base` into `next`: every setting that changed, and nothing else. Inside a
 * section (`guard`, `caps` …) only the keys that changed travel — the daemon merges a section key by key
 * — so a save never restates a value the owner did not touch. That matters beyond tidiness: `base` is the
 * version IN EFFECT, and while an edit waits for the owner's confirmation the file says something else.
 * On 2026-10-29 a slider on the guard carried the whole section, Jev's price with it, and would have put
 * a held price correction back to the old one. An untouched setting does not travel at all, so a save
 * cannot loosen what it did not touch either.
 */
export const wardenConfigPatchFrom = (base: WardenConfig, next: WardenConfig): WardenConfigPatch => {
  const patch: Record<string, unknown> = {};
  const sections: ReadonlySet<string> = new Set(WARDEN_CONFIG_SECTIONS);
  for (const key of Object.keys(next) as (keyof WardenConfig)[]) {
    if (same(base[key], next[key])) continue;
    patch[key] = sections.has(key) ? changedKeys(base[key] as object, next[key] as object) : next[key];
  }
  return patch as WardenConfigPatch;
};

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

/** The keys of one section whose value changed. */
const changedKeys = (base: object, next: object): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(next).filter(([key, value]) => !same((base as Record<string, unknown>)[key], value)),
  );

/** Makes `agent` the investigation login: it moves to the head of the failover order. */
export const withLogin = (config: WardenConfig, account: WardenAccount): WardenConfig => ({
  ...config,
  accounts: [account, ...config.accounts.filter(candidate => candidate.agent !== account.agent)],
});

/** Moves one login up or down the failover order; a move off either end is a no-op. */
export const movedAccount = (config: WardenConfig, index: number, delta: -1 | 1): WardenConfig => {
  const target = index + delta;
  if (target < 0 || target >= config.accounts.length) return config;
  const accounts = [...config.accounts];
  [accounts[index], accounts[target]] = [accounts[target] as WardenAccount, accounts[index] as WardenAccount];
  return { ...config, accounts };
};

/** The investigation efforts the Warden can be given, lowest first. */
export const WARDEN_EFFORTS: readonly WardenEffort[] = ['low', 'medium', 'high'];

/**
 * The efforts an investigation on this login's model can run at (docs/model-catalog.md): the Warden's
 * levels that the chosen model takes, when its login's catalog says — none for a model that takes no
 * effort — and all of them when no catalog says. `modelName` names the model in the sentence that
 * says so.
 */
export function wardenEfforts(
  runtime: PickerAccount | undefined,
  model: string | undefined,
): { readonly efforts: readonly WardenEffort[]; readonly modelName: string } {
  const id = model ?? runtime?.defaultModel ?? undefined;
  const chosen = runtime?.models.find(entry => entry.id === id);
  const modelName = chosen?.label ?? id ?? 'This model';
  const takes = runtime?.modelCatalog === undefined ? undefined : chosen?.efforts;
  return {
    efforts: takes === undefined ? WARDEN_EFFORTS : WARDEN_EFFORTS.filter(effort => takes.includes(effort)),
    modelName,
  };
}
