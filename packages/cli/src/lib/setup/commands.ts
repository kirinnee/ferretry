import type { FleetAccountChange, FleetHarnessScan, FleetSetupScan } from '@ferretry/protocol';
import type { Command } from 'commander';
import { WriteAuthority } from '../fleet/account-authority.ts';
import { runChange } from '../fleet/account-change.ts';
import { collect, mergedOptions, parseHarness, writeFlags, writeOptions } from '../fleet/account-commands.ts';
import {
  type AccountCommandDeps,
  AccountCommandError,
  type AccountHarness,
  type AccountWriteOptions,
} from '../fleet/account-ports.ts';
import { HARNESS_LABEL, indent, listOrNone, unavailable } from '../fleet/account-render.ts';
import { installTools } from '../machine/commands.ts';

/** What the first run found for one tool, before anybody chooses. Names only, never a value. */
export function renderHarnessScan(scan: FleetHarnessScan): string {
  const account = scan.account;
  const login =
    account.state === 'signed-in' || account.state === 'refresh-due'
      ? `signed in${account.email ? ` as ${account.email}` : ''}`
      : account.state.replace(/-/gu, ' ');
  return [
    HARNESS_LABEL[scan.harness],
    ...indent([
      `Your login: ${login}${account.reason ? ` (${account.reason})` : ''}`,
      ...(scan.instructions === undefined ? [] : [`Instructions: ${scan.instructions.source}`]),
      ...(scan.settings === undefined
        ? []
        : [`Settings: ${scan.settings.source} (${scan.settings.count} setting(s), ${scan.settings.hooks} hook(s))`]),
      `MCP servers: ${listOrNone(scan.mcpServers)}`,
      `Skills: ${listOrNone(scan.skills)}`,
      ...(scan.secretKeys.length === 0
        ? []
        : [`Moved to the secret store, never copied as text: ${scan.secretKeys.join(', ')}`]),
      ...scan.missingCommands.map(command => `Command not found on this machine: ${command}`),
      ...scan.problems.map(problem => `Problem: ${problem}`),
    ]),
  ].join('\n');
}

interface SetupFlags extends Record<string, unknown> {
  readonly skip?: readonly string[];
  readonly name?: readonly string[];
  readonly acceptUpdate?: readonly string[];
  readonly addDuplicates?: boolean;
}

/** `claude=work-claude` pairs. */
function parseNames(pairs: readonly string[]): Partial<Record<AccountHarness, string>> {
  const names: Partial<Record<AccountHarness, string>> = {};
  for (const pair of pairs) {
    const equals = pair.indexOf('=');
    if (equals <= 0)
      throw new AccountCommandError(`--name takes tool=name, for example claude=my-claude; got "${pair}".`);
    names[parseHarness(pair.slice(0, equals))] = pair.slice(equals + 1);
  }
  return names;
}

/** A yes/no a person answers, defaulting to yes. Off a terminal it is always the default. */
async function askYes(deps: AccountCommandDeps, question: string, assume: boolean): Promise<boolean> {
  if (assume) return true;
  const answer = (await deps.prompt.ask(`${question} [Y/n]`)).trim().toLowerCase();
  return answer === '' || answer === 'y' || answer === 'yes';
}

/**
 * The first run (§4.3) and Import again in a terminal: tools, then each tool's own setup, then the
 * runtime names, then ONE reviewed change that imports it all.
 *
 * At a terminal every choice is asked; `--yes` takes the suggestion for each. A script without `--yes`
 * is refused, because a first run with nobody to answer it would otherwise guess.
 */
export async function runSetup(deps: AccountCommandDeps, flags: SetupFlags, again: boolean): Promise<void> {
  const options: AccountWriteOptions = writeFlags(flags);
  const assume = options.yes === true;
  if (!assume && !deps.interactive) {
    throw new AccountCommandError(
      'Setup asks a few questions. Run it in a terminal, or pass --yes to take every suggestion.',
    );
  }
  const skipped = new Set((flags.skip ?? []).map(parseHarness));
  const names = parseNames(flags.name ?? []);
  const authority = await WriteAuthority.open(deps);
  let scan: FleetSetupScan = await deps.gateway.scan(authority.current);
  const blocked = unavailable(scan.importing);
  if (blocked !== undefined) throw new AccountCommandError(blocked);

  if (!again) {
    const missing = scan.tools.filter(tool => !tool.installed && !skipped.has(tool.harness)).map(tool => tool.harness);
    if (missing.length > 0 && !options.dryRun) {
      const label = missing.map(harness => HARNESS_LABEL[harness]).join(' and ');
      if (await askYes(deps, `${label} ${missing.length === 1 ? 'is' : 'are'} not installed. Install now?`, assume)) {
        await installTools(deps, missing, { yes: true }, authority);
        scan = await deps.gateway.scan(authority.current);
      }
    }
  }

  const include: AccountHarness[] = [];
  for (const harness of scan.harnesses) {
    if (!harness.installed || skipped.has(harness.harness)) continue;
    deps.out.report(renderHarnessScan(harness));
    if (await askYes(deps, `Import ${HARNESS_LABEL[harness.harness]}?`, assume)) include.push(harness.harness);
  }
  for (const note of scan.notes) deps.out.report(`${HARNESS_LABEL[note.harness]}: ${note.text}`);
  if (include.length === 0) {
    deps.out.error('Nothing was imported: no tool was chosen.');
    deps.out.setExitCode(1);
    return;
  }

  for (const runtime of scan.runtimes) {
    if (!include.includes(runtime.harness) || names[runtime.harness] !== undefined || assume) continue;
    const answer = (
      await deps.prompt.ask(`Name for the ${HARNESS_LABEL[runtime.harness]} runtime [${runtime.name}]:`)
    ).trim();
    if (answer !== '') names[runtime.harness] = answer;
  }

  const acceptedUpdates = [...(flags.acceptUpdate ?? [])];
  for (const update of scan.updates) {
    if (acceptedUpdates.includes(update.reference) || assume) continue;
    const question = `${update.reference} changed in ${update.sources.join(', ')} since the last import. Update it?`;
    if (await askNo(deps, question)) acceptedUpdates.push(update.reference);
  }
  for (const duplicate of scan.duplicates) {
    deps.out.report(
      `${duplicate.existing} already uses that ${HARNESS_LABEL[duplicate.harness]} login and profile${flags.addDuplicates ? `; adding ${duplicate.suggested} anyway` : ', so no new runtime is added'}.`,
    );
  }

  const change: FleetAccountChange = {
    kind: 'setup.import',
    include,
    ...(Object.keys(names).length === 0 ? {} : { names }),
    ...(acceptedUpdates.length === 0 ? {} : { acceptedUpdates }),
    ...(flags.addDuplicates === true ? { addDuplicates: true } : {}),
  };
  const outcome = await runChange(deps, { change, destructive: false, options, authority });
  if (outcome !== undefined && options.json !== true) {
    deps.out.report(`See what was set up with \`${deps.binaryName} runtimes\` and \`${deps.binaryName} credentials\`.`);
  }
}

/**
 * A yes/no that defaults to NO: an update to a component somebody may have edited since is offered,
 * never applied unless they choose it (O6).
 */
async function askNo(deps: AccountCommandDeps, question: string): Promise<boolean> {
  const answer = (await deps.prompt.ask(`${question} [y/N]`)).trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

const setupFlags = (command: Command): Command =>
  writeOptions(command)
    .option('--skip <tool>', 'do not import this tool; repeat it', collect, [])
    .option(
      '--name <tool=name>',
      'the runtime name for one tool, for example claude=my-claude; repeat it',
      collect,
      [],
    );

/** Mounts `setup` and `setup import` (docs/design/account-model.md §6.2). */
export function registerSetupCommands(program: Command, deps: AccountCommandDeps): void {
  const setup = setupFlags(
    program
      .command('setup')
      .description(
        'set this machine up: install the tools, import your own Claude Code and Codex setup, name the runtimes',
      )
      .addHelpText(
        'after',
        '\nYour own logins are shared in place, never copied: the runtimes use the same login as\n' +
          'claude and codex in your terminal. Secret-looking settings move to the secret store.',
      ),
  ).action(async (options: SetupFlags) => {
    await runSetup(deps, options, false);
  });

  // `import` takes setup's own flags too (--yes, --skip, --name…). They are declared once, on setup:
  // commander hands a flag both declare to the group wherever it is typed, so a second copy here
  // would only ever read its default.
  setup
    .command('import')
    .description('import again: add what is new since the last import, and offer updates to what changed')
    .option('--accept-update <kind/name>', 'update this component from its changed source; repeat it', collect, [])
    .option('--add-duplicates', 'add a runtime even where one already uses that login and profile')
    .configureHelp({ showGlobalOptions: true })
    .action(async (_options: unknown, command: Command) => {
      await runSetup(deps, mergedOptions(command) as SetupFlags, true);
    });
}
