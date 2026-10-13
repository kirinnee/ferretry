import type { FleetAccountChange, FleetHarnessScan, FleetSetupScan } from '@ferretry/protocol';
import type { Command } from 'commander';
import { WriteAuthority } from '../fleet/account-authority.ts';
import { runChange } from '../fleet/account-change.ts';
import { mergedOptions, parseHarness, writeFlags, writeOptions } from '../fleet/account-commands.ts';
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

/** Whether a harness's own login is one a runtime could launch with now. */
const signedIn = (scan: FleetHarnessScan): boolean =>
  scan.account.state === 'signed-in' || scan.account.state === 'refresh-due';

/** A yes/no a person answers, defaulting to yes. */
async function askYes(deps: AccountCommandDeps, question: string): Promise<boolean> {
  const answer = (await deps.prompt.ask(`${question} [Y/n]`)).trim().toLowerCase();
  return answer === '' || answer === 'y' || answer === 'yes';
}

/**
 * A yes/no that defaults to NO: an update to a component somebody may have edited since is offered,
 * never applied unless they choose it (O6).
 */
async function askNo(deps: AccountCommandDeps, question: string): Promise<boolean> {
  const answer = (await deps.prompt.ask(`${question} [y/N]`)).trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

/** The scan, refused in words when this machine takes no import now. */
async function openScan(deps: AccountCommandDeps): Promise<{ authority: WriteAuthority; scan: FleetSetupScan }> {
  const authority = await WriteAuthority.open(deps);
  const scan = await deps.gateway.scan(authority.current);
  const blocked = unavailable(scan.importing);
  if (blocked !== undefined) throw new AccountCommandError(blocked);
  return { authority, scan };
}

/** After an import: what to run next, including the sign-in a login that is not signed in still needs. */
function reportNext(deps: AccountCommandDeps, scan: FleetSetupScan, include: readonly AccountHarness[]): void {
  const bin = deps.binaryName;
  for (const harness of include) {
    const found = scan.harnesses.find(candidate => candidate.harness === harness);
    if (found !== undefined && !signedIn(found))
      deps.out.report(
        `${HARNESS_LABEL[harness]} is not signed in yet: find its login with \`${bin} credentials\`, then run \`${bin} credential signin <login>\` before you launch.`,
      );
  }
  deps.out.report(`See what was set up with \`${bin} runtimes\` and \`${bin} credentials\`.`);
}

/**
 * `daemon setup`: the first run (§4.3) — and Import again on a machine that is set up — in a terminal,
 * ONE QUESTION AT A TIME: install what is missing, then for each tool found "use your login and
 * setup?", then each runtime's name, then ONE reviewed change that imports what was chosen.
 *
 * It needs a person. Off a terminal it refuses and names `daemon import`, the no-questions verb for
 * scripts, rather than guessing answers nobody gave.
 */
export async function runSetup(deps: AccountCommandDeps, flags: Record<string, unknown>): Promise<void> {
  const bin = deps.binaryName;
  if (!deps.interactive) {
    throw new AccountCommandError(
      `\`${bin} daemon setup\` asks a few questions, so it needs a terminal. In a script, run \`${bin} daemon import claude\` or \`${bin} daemon import codex\` instead.`,
    );
  }
  const options: AccountWriteOptions = writeFlags(flags);
  const opened = await openScan(deps);
  const { authority } = opened;
  let scan = opened.scan;

  // Tools come first, and only on a machine that has no setup yet: Import again is about what changed.
  if (scan.format === 'none') {
    const missing = scan.tools.filter(tool => !tool.installed).map(tool => tool.harness);
    if (missing.length > 0 && !options.dryRun) {
      const label = missing.map(harness => HARNESS_LABEL[harness]).join(' and ');
      if (await askYes(deps, `${label} ${missing.length === 1 ? 'is' : 'are'} not installed. Install now?`)) {
        await installTools(deps, missing, { yes: true }, authority);
        scan = await deps.gateway.scan(authority.current);
      }
    }
  }

  const include: AccountHarness[] = [];
  for (const harness of scan.harnesses) {
    if (!harness.installed) continue;
    deps.out.report(renderHarnessScan(harness));
    const name = HARNESS_LABEL[harness.harness];
    if (!signedIn(harness))
      deps.out.report(`Your ${name} login is not signed in. You can still import it, and sign in afterwards.`);
    if (await askYes(deps, `We found ${name} on ${scan.machine}. Use your login and setup?`))
      include.push(harness.harness);
  }
  for (const note of scan.notes) deps.out.report(`${HARNESS_LABEL[note.harness]}: ${note.text}`);

  const acceptedUpdates: string[] = [];
  for (const update of scan.updates) {
    const question = `${update.reference} changed in ${update.sources.join(', ')} since the last import. Update it?`;
    if (await askNo(deps, question)) acceptedUpdates.push(update.reference);
  }

  if (include.length === 0 && acceptedUpdates.length === 0) {
    deps.out.report(
      scan.format === 'none'
        ? `Nothing was set up, so ${scan.machine} has no runtimes yet. Run \`${bin} daemon setup\` again when you are ready, or finish in the app.`
        : 'Nothing was imported. Your runtimes are unchanged.',
    );
    return;
  }

  const names: Partial<Record<AccountHarness, string>> = {};
  for (const runtime of scan.runtimes) {
    if (!include.includes(runtime.harness)) continue;
    const answer = (
      await deps.prompt.ask(`Name for the ${HARNESS_LABEL[runtime.harness]} runtime [${runtime.name}]:`)
    ).trim();
    if (answer !== '') names[runtime.harness] = answer;
  }
  for (const duplicate of scan.duplicates) {
    if (!include.includes(duplicate.harness)) continue;
    deps.out.report(
      `${duplicate.existing} already uses that ${HARNESS_LABEL[duplicate.harness]} login and profile, so no new runtime is added.`,
    );
  }

  const change: FleetAccountChange = {
    kind: 'setup.import',
    include,
    ...(Object.keys(names).length === 0 ? {} : { names }),
    ...(acceptedUpdates.length === 0 ? {} : { acceptedUpdates }),
  };
  const outcome = await runChange(deps, { change, destructive: false, options, authority });
  if (outcome !== undefined && options.json !== true) reportNext(deps, scan, include);
}

interface ImportFlags extends Record<string, unknown> {
  readonly name?: string;
}

/**
 * `daemon import claude|codex`: the same import with NO questions, for scripts — this tool's own login
 * (shared in place) and setup, under `--name` or the suggested runtime name (`claude-default`).
 *
 * It never installs anything: a tool that is not installed is refused with the command that does.
 */
export async function runImport(deps: AccountCommandDeps, tool: string, flags: ImportFlags): Promise<void> {
  const harness = parseHarness(tool);
  const bin = deps.binaryName;
  const options: AccountWriteOptions = writeFlags(flags);
  const { authority, scan } = await openScan(deps);
  const found = scan.harnesses.find(candidate => candidate.harness === harness);
  if (found === undefined || !found.installed) {
    throw new AccountCommandError(
      `${HARNESS_LABEL[harness]} is not installed on ${scan.machine}. Install it with \`${bin} machine install ${harness}\`, then import it.`,
    );
  }
  for (const duplicate of scan.duplicates) {
    if (duplicate.harness === harness)
      deps.out.report(
        `${duplicate.existing} already uses that ${HARNESS_LABEL[harness]} login and profile, so no new runtime is added.`,
      );
  }
  const change: FleetAccountChange = {
    kind: 'setup.import',
    include: [harness],
    ...(flags.name === undefined ? {} : { names: { [harness]: flags.name } }),
  };
  const outcome = await runChange(deps, { change, destructive: false, options, authority });
  if (outcome !== undefined && options.json !== true) reportNext(deps, scan, [harness]);
}

/**
 * Mounts `daemon setup` and `daemon import <tool>` onto the EXISTING `daemon` group
 * (docs/design/account-model.md §6.2): setting a machine up is something a person does to the daemon
 * they just started, and a booting daemon never does it by itself.
 */
export function registerSetupCommands(program: Command, deps: AccountCommandDeps): void {
  const daemon = program.commands.find(command => command.name() === 'daemon');
  if (daemon === undefined) throw new Error('the daemon command group must be registered before setup and import');
  writeOptions(
    daemon
      .command('setup')
      .description('set this machine up: install the tools, then choose whether to use your Claude Code and Codex')
      .addHelpText(
        'after',
        '\nOne question at a time, so it needs a terminal; a script runs `daemon import <tool>` instead.\n' +
          'On a machine that is already set up it imports again: what is new, and offers updates to\n' +
          'what changed. Your own logins are shared in place, never copied: the runtimes use the same\n' +
          'login as claude and codex in your terminal. Secret-looking settings move to the secret store.',
      ),
  ).action(async (_options: unknown, command: Command) => {
    await runSetup(deps, mergedOptions(command));
  });

  writeOptions(
    daemon
      .command('import')
      .description("import one tool's own login and setup, with no questions (for scripts)")
      .argument('<tool>', 'claude or codex')
      .option('--name <runtime>', 'the runtime to create (default: the suggested name, e.g. claude-default)'),
  ).action(async (tool: string, _options: unknown, command: Command) => {
    await runImport(deps, tool, mergedOptions(command) as ImportFlags);
  });
}
