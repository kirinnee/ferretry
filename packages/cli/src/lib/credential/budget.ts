/**
 * `fy login budget <id>` (docs/budgets.md): set, change or clear a login's daily and weekly spend budget.
 *
 * It edits ONE key — `budget` in `logins/<id>.yaml` — through the daemon's checked config write, the same
 * door every editor goes through. So the file's rules hold exactly: adding or lowering a limit applies at
 * once; raising or removing one is written but HELD until the owner confirms it, and the tighter budget stays
 * in effect meanwhile. `--time-zone` sets `machine.yaml` `timeZone` the same way.
 */
import {
  type Budget,
  type BudgetLimit,
  BudgetSchema,
  checkConfigFile,
  isTimeZone,
  setConfigKey,
  usdWords,
} from '@ferretry/fleet';
import type { ConfigFilePutResult } from '@ferretry/protocol';
import type { Command } from 'commander';
import { type AccountCommandDeps, AccountCommandError } from '../fleet/account-ports.ts';

/** One level as typed: dollars, `off` to remove it, or not given. */
type LevelInput = number | 'off' | undefined;

export interface BudgetEdit {
  readonly dailyTrigger?: LevelInput;
  readonly dailyHard?: LevelInput;
  readonly weeklyTrigger?: LevelInput;
  readonly weeklyHard?: LevelInput;
  readonly clear?: boolean;
}

/** A level flag's value: a positive dollar amount, or `off`. */
export function parseLevel(flag: string, text: string): number | 'off' {
  if (text.trim().toLowerCase() === 'off') return 'off';
  const amount = Number(text.replace(/^\$/u, ''));
  if (!Number.isFinite(amount) || amount <= 0)
    throw new AccountCommandError(
      `--${flag} takes a dollar amount above 0 (40, 12.50) or "off"; "${text}" is neither.`,
    );
  return amount;
}

const level = (current: number | undefined, input: LevelInput): number | undefined =>
  input === undefined ? current : input === 'off' ? undefined : input;

const limitOf = (trigger: number | undefined, hard: number | undefined): BudgetLimit | undefined =>
  trigger === undefined && hard === undefined
    ? undefined
    : { ...(trigger === undefined ? {} : { trigger }), ...(hard === undefined ? {} : { hard }) };

/** The budget after `edit`, from `current`; `undefined` is no budget at all. Not yet validated. */
export function editedBudget(current: Budget | undefined, edit: BudgetEdit): Budget | undefined {
  if (edit.clear === true) return undefined;
  const daily = limitOf(level(current?.daily?.trigger, edit.dailyTrigger), level(current?.daily?.hard, edit.dailyHard));
  const weekly = limitOf(
    level(current?.weekly?.trigger, edit.weeklyTrigger),
    level(current?.weekly?.hard, edit.weeklyHard),
  );
  return daily === undefined && weekly === undefined
    ? undefined
    : { ...(daily === undefined ? {} : { daily }), ...(weekly === undefined ? {} : { weekly }) };
}

const limitWords = (name: string, limit: BudgetLimit | undefined): string[] =>
  limit === undefined
    ? []
    : [
        `${name}: ${[
          ...(limit.trigger === undefined ? [] : [`trigger ${usdWords(limit.trigger)}`]),
          ...(limit.hard === undefined ? [] : [`hard ${usdWords(limit.hard)}`]),
        ].join(', ')}`,
      ];

/** "daily: trigger $40.00, hard $60.00 · weekly: hard $200.00", or "no budget". */
export function budgetWords(budget: Budget | undefined): string {
  const parts = [...limitWords('daily', budget?.daily), ...limitWords('weekly', budget?.weekly)];
  return parts.length === 0 ? 'no budget' : parts.join(' · ');
}

const sameBudget = (left: Budget | undefined, right: Budget | undefined): boolean =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

/** What one write did, in words, and whether it waits for the owner. */
function writeWords(
  deps: AccountCommandDeps,
  path: string,
  result: ConfigFilePutResult,
  applied: string,
): { readonly held: boolean; readonly line: string } {
  if (result.outcome === 'applied') return { held: false, line: applied };
  const changes = result.pending?.changes.join('; ') ?? 'it loosens spending';
  return {
    held: true,
    line: `Written, but held for the owner (${changes}); the tighter version stays in effect until they confirm it with \`${deps.binaryName} config confirm ${path}\`.`,
  };
}

interface BudgetOptions {
  readonly dailyTrigger?: string;
  readonly dailyHard?: string;
  readonly weeklyTrigger?: string;
  readonly weeklyHard?: string;
  readonly clear?: boolean;
  readonly timeZone?: string;
  readonly dryRun?: boolean;
  readonly json?: boolean;
}

/** Run `login budget <id>` with its flags. */
async function runBudget(deps: AccountCommandDeps, id: string, options: BudgetOptions): Promise<void> {
  const config = deps.config;
  if (config === undefined) throw new AccountCommandError('This build cannot reach the configuration files.');
  const levels = {
    dailyTrigger: options.dailyTrigger === undefined ? undefined : parseLevel('daily-trigger', options.dailyTrigger),
    dailyHard: options.dailyHard === undefined ? undefined : parseLevel('daily-hard', options.dailyHard),
    weeklyTrigger:
      options.weeklyTrigger === undefined ? undefined : parseLevel('weekly-trigger', options.weeklyTrigger),
    weeklyHard: options.weeklyHard === undefined ? undefined : parseLevel('weekly-hard', options.weeklyHard),
  };
  const setsLevel = Object.values(levels).some(value => value !== undefined);
  if (options.clear === true && setsLevel)
    throw new AccountCommandError('--clear removes the whole budget; give it alone, or give levels without it.');
  if (options.timeZone !== undefined && !isTimeZone(options.timeZone))
    throw new AccountCommandError(
      `"${options.timeZone}" is not a time zone this machine knows: use an IANA name such as America/Los_Angeles or UTC.`,
    );

  const path = `logins/${id}.yaml`;
  const file = await config.file(path);
  if (!file.exists) throw new AccountCommandError(`No login "${id}" on this machine.`);
  const checked = checkConfigFile(path, file.text);
  if (!checked.ok)
    throw new AccountCommandError(`${path} does not check; fix it first (\`${deps.binaryName} config check\`).`);
  const current = (checked.value as { readonly budget?: Budget }).budget;

  if (!setsLevel && options.clear !== true && options.timeZone === undefined) {
    deps.out.report(
      options.json === true
        ? JSON.stringify({ login: id, budget: current ?? null }, null, 2)
        : `${id}: ${budgetWords(current)}. What it spent: \`${deps.binaryName} login check ${id}\`.`,
    );
    return;
  }

  const next = editedBudget(current, { ...levels, clear: options.clear === true });
  if (next !== undefined) {
    const parsed = BudgetSchema.safeParse(next);
    if (!parsed.success)
      throw new AccountCommandError(`That budget is not valid: ${parsed.error.issues[0]?.message ?? ''}.`);
  }
  const lines: string[] = [];
  const result: Record<string, unknown> = { login: id, budget: next ?? null };
  if (!sameBudget(current, next)) {
    const text = setConfigKey(file.text, 'budget', next);
    if (options.dryRun === true) lines.push(`Would set ${id}'s budget to ${budgetWords(next)}.`);
    else {
      const written = await config.write(path, text, file.etag);
      const words = writeWords(deps, path, written, `${id}'s budget is now ${budgetWords(next)}.`);
      lines.push(words.line);
      result.outcome = written.outcome;
    }
  } else lines.push(`${id}'s budget is already ${budgetWords(next)}.`);

  if (options.timeZone !== undefined) {
    const machine = await config.file('machine.yaml');
    const text = setConfigKey(machine.exists ? machine.text : '', 'timeZone', options.timeZone);
    if (options.dryRun === true) lines.push(`Would count budgets in ${options.timeZone}.`);
    else {
      const written = await config.write('machine.yaml', text, machine.etag);
      lines.push(writeWords(deps, 'machine.yaml', written, `Budgets now count days in ${options.timeZone}.`).line);
      result.timeZone = options.timeZone;
      result.timeZoneOutcome = written.outcome;
    }
  }
  deps.out.report(options.json === true ? JSON.stringify(result, null, 2) : lines.join('\n'));
}

/** Mount `budget` under the `login` group. */
export function registerBudgetCommand(credential: Command, deps: AccountCommandDeps): void {
  credential
    .command('budget')
    .description(
      "show or set a login's daily and weekly spend budget: past the trigger nothing new starts on it, past the hard limit its ferrets are stopped",
    )
    .argument('<id>', 'the login')
    .option('--daily-trigger <usd>', 'stop routing to it once it spends this much today (or "off")')
    .option('--daily-hard <usd>', 'also stop its ferrets once it spends this much today (or "off")')
    .option('--weekly-trigger <usd>', 'stop routing to it once it spends this much this week (or "off")')
    .option('--weekly-hard <usd>', 'also stop its ferrets once it spends this much this week (or "off")')
    .option('--clear', 'remove the whole budget')
    .option('--time-zone <zone>', 'the IANA zone days and weeks are counted in, for every budget on this machine')
    .option('--dry-run', 'show what would change, and change nothing')
    .option('--json', 'print the outcome as JSON')
    .addHelpText(
      'after',
      '\nAdding or lowering a limit applies at once. Raising or removing one is held until the owner confirms it.',
    )
    .action(async (id: string, options: BudgetOptions) => {
      await runBudget(deps, id, options);
    });
}
