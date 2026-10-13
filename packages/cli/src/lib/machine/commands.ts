import {
  type FleetCloneBundle,
  FleetCloneBundleSchema,
  type FleetMachineView,
  type FleetSetupTool,
  type FleetToolInstallOutcome,
} from '@ferretry/protocol';
import type { Command } from 'commander';
import { WriteAuthority } from '../fleet/account-authority.ts';
import { confirmStep, runChange } from '../fleet/account-change.ts';
import {
  mergedOptions,
  parseHarness,
  readLocalFile,
  readOptions,
  writeFlags,
  writeOptions,
} from '../fleet/account-commands.ts';
import { type AccountCommandDeps, AccountCommandError, type AccountHarness } from '../fleet/account-ports.ts';
import { HARNESS_LABEL, indent, unavailable } from '../fleet/account-render.ts';

/** The machine's facts: its tools, its Agent permissions, and whether it takes changes yet. */
export function renderMachine(machine: FleetMachineView, binaryName: string): string {
  const format =
    machine.format === 'version-1'
      ? 'the old account format'
      : machine.format === 'none'
        ? 'not set up yet'
        : 'the account model';
  const changes = unavailable(machine.changes);
  return [
    machine.name,
    ...indent([
      `Setup: ${format}${machine.setUp ? `, ${machine.runtimeCount} runtime(s)` : ''}`,
      `Agent permissions: ${machine.agentPermissions === 'auto' ? 'auto (the tool decides what needs asking)' : 'skip (agents are never asked)'}`,
      `Sessions running: ${machine.runningSessions}`,
      'Tools:',
      ...machine.tools.map(
        tool =>
          `  ${tool.label}: ${tool.installed ? `installed${tool.command ? ` (${tool.command})` : ''}` : 'not installed'}`,
      ),
      ...(changes === undefined ? [] : [`Changes: ${changes}`]),
    ]),
    ...(machine.setUp ? [] : ['', `Set it up with \`${binaryName} setup\`.`]),
  ].join('\n');
}

/** How installing one tool ended, in words. */
export function renderInstallOutcome(outcome: FleetToolInstallOutcome): string {
  const label = HARNESS_LABEL[outcome.harness];
  if (outcome.outcome === 'already-installed') return `${label} was already installed.`;
  if (outcome.outcome === 'installed') return `${label} is installed.`;
  return `${label} was not installed: ${outcome.reason}\n  Run it yourself: ${outcome.manualCommand}`;
}

/**
 * Install harness tools: show the exact command first, ask, then run it through the daemon.
 *
 * Returns whether every requested tool ended installed. A failure is a non-zero exit with the command
 * to run by hand (E2); nothing here runs `sudo`.
 */
export async function installTools(
  deps: AccountCommandDeps,
  harnesses: readonly AccountHarness[],
  options: { yes?: boolean; dryRun?: boolean },
): Promise<boolean> {
  const authority = await WriteAuthority.open(deps);
  const scan = await deps.gateway.scan(authority.current);
  const wanted = scan.tools.filter(tool => harnesses.includes(tool.harness));
  const missing = wanted.filter((tool): tool is Extract<FleetSetupTool, { installed: false }> => !tool.installed);
  for (const tool of wanted) if (tool.installed) deps.out.report(`${tool.label} is already installed.`);
  if (missing.length === 0) return true;
  const runnable = missing.filter(tool => tool.install.kind === 'runnable');
  for (const tool of missing) {
    if (tool.install.kind === 'runnable')
      deps.out.report(`${tool.label} will be installed with: ${tool.install.command}`);
    else
      deps.out.warn(
        `${tool.label} cannot be installed from here: ${tool.install.reason}\n  Run it yourself: ${tool.install.manualCommand}`,
      );
  }
  if (runnable.length < missing.length) deps.out.setExitCode(1);
  if (runnable.length === 0 || options.dryRun) return false;
  if (!(await confirmStep(deps, 'Install now?', options.yes))) return false;
  deps.out.report('Installing… this can take a few minutes.');
  const result = await deps.gateway.installTools(
    runnable.map(tool => tool.harness),
    await authority.forApply(),
  );
  let ok = runnable.length === missing.length;
  for (const outcome of result.outcomes) {
    const text = renderInstallOutcome(outcome);
    if (outcome.outcome === 'failed') {
      ok = false;
      deps.out.error(text);
    } else deps.out.success(text);
  }
  if (!ok) deps.out.setExitCode(1);
  return ok;
}

/** A clone bundle read from a file, refused in words when it is not one. */
export function parseCloneBundle(text: string, path: string): FleetCloneBundle {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new AccountCommandError(`${path} is not a setup export: it is not JSON.`);
  }
  const parsed = FleetCloneBundleSchema.safeParse(value);
  if (!parsed.success) {
    throw new AccountCommandError(`${path} is not a setup export from \`machine export\`.`);
  }
  return parsed.data;
}

/** Mounts `machine …` (docs/design/account-model.md §6.2). */
export function registerMachineCommands(program: Command, deps: AccountCommandDeps): void {
  const bin = deps.binaryName;
  const machine = readOptions(
    program.command('machine').description('this machine: its tools, its agent permissions, export and clone'),
  ).action(async (options: { json?: boolean }) => {
    const view = await deps.gateway.machine();
    deps.out.report(options.json ? JSON.stringify(view, null, 2) : renderMachine(view, bin));
  });

  writeOptions(
    machine
      .command('set')
      .description('change a machine setting: agent-permissions auto|skip')
      .argument('<setting>', 'agent-permissions')
      .argument('<value>', 'auto or skip'),
  ).action(async (setting: string, value: string, _options: unknown, command: Command) => {
    const options = mergedOptions(command);
    if (setting !== 'agent-permissions') {
      throw new AccountCommandError(
        `"${setting}" is not a machine setting. Try: ${bin} machine set agent-permissions auto`,
      );
    }
    if (value !== 'auto' && value !== 'skip') {
      throw new AccountCommandError('Agent permissions are auto or skip.');
    }
    await runChange(deps, {
      change: { kind: 'machine.settings', agentPermissions: value },
      destructive: true,
      options: writeFlags(options),
    });
  });

  machine
    .command('install')
    .description('install Claude Code or Codex on this machine (shows the command first)')
    .argument('<tool...>', 'claude, codex, or both')
    .option('--dry-run', 'show the command, and run nothing')
    .option('-y, --yes', 'do not ask before running it (for scripts)')
    .action(async (tools: string[], options: { yes?: boolean; dryRun?: boolean }) => {
      await installTools(deps, [...new Set(tools.map(parseHarness))], options);
    });

  machine
    .command('export')
    .description(`print this machine's setup for \`${bin} machine clone\`: no login and no history`)
    .action(async () => {
      const authority = await WriteAuthority.open(deps);
      deps.out.report(JSON.stringify(await deps.gateway.exportBundle(authority.current), null, 2));
    });

  writeOptions(
    machine
      .command('clone')
      .description('copy a setup exported from another machine; its logins arrive as empty slots to sign in')
      .argument('<file>', `the output of \`${bin} machine export\` on the other machine`)
      .option(
        '--replace',
        'replace this machine’s profiles and runtimes instead of adding alongside (logins are kept)',
      ),
  ).action(async (file: string, _options: unknown, command: Command) => {
    const options = mergedOptions(command);
    const bundle = parseCloneBundle(await readLocalFile(deps.readText, file), file);
    const replace = options.replace === true;
    const outcome = await runChange(deps, {
      change: { kind: 'clone.import', mode: replace ? 'replace' : 'alongside', bundle: { ...bundle } },
      destructive: replace,
      options: writeFlags(options),
    });
    if (outcome !== undefined && options.json !== true) {
      deps.out.report(`Sign in to use the copied logins: \`${bin} credentials\` lists each one.`);
    }
  });
}
