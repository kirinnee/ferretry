import {
  cloneRunnables,
  type FleetAgentControl,
  type FleetCloneBundle,
  FleetCloneBundleSchema,
  type FleetMachineView,
  type FleetSetupTool,
  type FleetToolInstallOutcome,
} from '@ferretry/protocol';
import type { Command } from 'commander';
import { requireMayApply } from '../fleet/account-authority.ts';
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
import { HARNESS_LABEL, indent } from '../fleet/account-render.ts';

/** "What agents may control", by the word `machine set agent-control` takes, in the order it names them. */
const AGENT_CONTROL_FIELDS = {
  terminals: 'terminals',
  browsers: 'browsers',
  files: 'files',
  // The `config.*` tools: an agent editing this machine's configuration files (docs/config-files.md).
  settings: 'ferretrySettings',
  // `browser.eval`: an agent's own JavaScript in a page it drives. Turning it on waits for the owner.
  scripts: 'pageScripts',
} as const satisfies Record<string, keyof FleetAgentControl>;
type AgentControlWord = keyof typeof AGENT_CONTROL_FIELDS;

const AGENT_CONTROL_WORDS = (control: FleetAgentControl): string =>
  (Object.entries(AGENT_CONTROL_FIELDS) as [AgentControlWord, keyof FleetAgentControl][])
    .map(([word, field]) => `${word} ${control[field] ? 'on' : 'off'}`)
    .join(', ');

/** The machine's facts: its tools, its Agent permissions, and whether it is set up yet. */
export function renderMachine(machine: FleetMachineView, binaryName: string): string {
  const format = machine.format === 'none' ? 'not set up yet' : 'the account model';
  return [
    machine.name,
    ...indent([
      `Setup: ${format}${machine.setUp ? `, ${machine.runtimeCount} runtime(s)` : ''}`,
      `Agent permissions: ${machine.agentPermissions === 'auto' ? 'auto (the tool decides what needs asking)' : 'skip (agents are never asked)'}`,
      `Default runtime for new agents: ${machine.defaultRuntime ?? 'none set, and no claude-default runtime exists yet'}`,
      `What agents may control: ${AGENT_CONTROL_WORDS(machine.agentControl)}`,
      ...autoResumeLines(machine),
      ...agendaModeLines(machine),
      `Sessions running: ${machine.runningSessions}`,
      'Tools:',
      ...machine.tools.map(
        tool =>
          `  ${tool.label}: ${tool.installed ? `installed${tool.command ? ` (${tool.command})` : ''}` : 'not installed'}`,
      ),
    ]),
    ...(machine.setUp
      ? []
      : ['', `Set it up with \`${binaryName} daemon setup\`, or pair a phone and finish in the app.`]),
  ].join('\n');
}

/** "Auto-resume after restart" and what the last pass did, in words; nothing for a daemon that predates it. */
function autoResumeLines(machine: FleetMachineView): string[] {
  if (machine.autoResume === undefined) return [];
  const last = machine.lastAutoResume;
  return [
    `Auto-resume after restart: ${machine.autoResume ? 'on' : 'off'}`,
    ...(last === null || last === undefined
      ? []
      : [
          `  Last restart: resumed ${last.resumed} ferret${last.resumed === 1 ? '' : 's'} (${last.at})`,
          ...last.skipped.map(item => `  Couldn't auto-resume ${item.sessionId}: ${item.reason}`),
        ]),
  ];
}

/** "Agenda mode for new ferrets"; nothing for a daemon that predates it. */
function agendaModeLines(machine: FleetMachineView): string[] {
  return machine.agendaMode === undefined ? [] : [`Agenda mode for new ferrets: ${machine.agendaMode ? 'on' : 'off'}`];
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
  await requireMayApply(deps);
  const scan = await deps.gateway.scan();
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
  const result = await deps.gateway.installTools(runnable.map(tool => tool.harness));
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

/** The three machine settings as one change always carries them, built from the ONE field a person named. */
function machineSettingsEdit(
  setting: string,
  value: readonly string[],
  current: FleetMachineView,
  binaryName: string,
): {
  agentPermissions: FleetMachineView['agentPermissions'];
  defaultRuntime: string | null;
  agentControl: FleetAgentControl;
  autoResume?: boolean;
  agendaMode?: boolean;
} {
  const base = {
    agentPermissions: current.agentPermissions,
    defaultRuntime: current.defaultRuntime,
    agentControl: { ...current.agentControl },
  };
  if (setting === 'agent-permissions') {
    const [next] = value;
    if (next !== 'auto' && next !== 'skip') throw new AccountCommandError('Agent permissions are auto or skip.');
    return { ...base, agentPermissions: next };
  }
  if (setting === 'default-runtime') {
    const [next] = value;
    if (next === undefined || next === '') {
      throw new AccountCommandError(
        `Name a runtime, or "automatic" for the machine's own fallback. Try: ${binaryName} machine set default-runtime claude-default`,
      );
    }
    return { ...base, defaultRuntime: next === 'automatic' ? null : next };
  }
  if (setting === 'agent-control') {
    const [kind, state] = value;
    if (kind === undefined || !Object.hasOwn(AGENT_CONTROL_FIELDS, kind)) {
      throw new AccountCommandError(
        `"${kind}" is not one of ${Object.keys(AGENT_CONTROL_FIELDS).join(', ')}. Try: ${binaryName} machine set agent-control terminals on`,
      );
    }
    if (state !== 'on' && state !== 'off') throw new AccountCommandError('Say on or off.');
    const field = AGENT_CONTROL_FIELDS[kind as AgentControlWord];
    return { ...base, agentControl: { ...base.agentControl, [field]: state === 'on' } };
  }
  if (setting === 'auto-resume') {
    const [state] = value;
    if (state !== 'on' && state !== 'off') throw new AccountCommandError('Say on or off.');
    return { ...base, autoResume: state === 'on' };
  }
  if (setting === 'agenda-mode') {
    const [state] = value;
    if (state !== 'on' && state !== 'off') throw new AccountCommandError('Say on or off.');
    return { ...base, agendaMode: state === 'on' };
  }
  throw new AccountCommandError(
    `"${setting}" is not a machine setting. Try: ${binaryName} machine set agent-permissions auto`,
  );
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
      .description(
        'change a machine setting: agent-permissions auto|skip, default-runtime <name>|automatic, agent-control terminals|browsers|files|settings|scripts on|off, auto-resume on|off, agenda-mode on|off',
      )
      .argument('<setting>', 'agent-permissions, default-runtime, agent-control, auto-resume, or agenda-mode')
      .argument('<value...>', 'the new value — two words for agent-control'),
  ).action(async (setting: string, value: string[], _options: unknown, command: Command) => {
    const options = mergedOptions(command);
    // A caller always sends every machine setting together (the wire contract never lets one field
    // be changed without restating the other two), so a single-setting command reads the current
    // view first and changes only the one field it names.
    const current = await deps.gateway.machine();
    const change = { kind: 'machine.settings' as const, ...machineSettingsEdit(setting, value, current, bin) };
    await runChange(deps, { change, destructive: true, options: writeFlags(options) });
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
      await requireMayApply(deps);
      deps.out.report(JSON.stringify(await deps.gateway.exportBundle(), null, 2));
    });

  writeOptions(
    machine
      .command('clone')
      .description('copy a setup exported from another machine; its logins arrive as empty slots to sign in')
      .argument('<file>', `the output of \`${bin} machine export\` on the other machine`)
      .option('--replace', 'replace this machine’s profiles and runtimes instead of adding alongside (logins are kept)')
      .option(
        '--skip <component...>',
        'leave a component out (mcp/notes, hooks/guard): the preview lists every one that runs a command here',
      ),
  ).action(async (file: string, _options: unknown, command: Command) => {
    const options = mergedOptions(command);
    const bundle = parseCloneBundle(await readLocalFile(deps.readText, file), file);
    const replace = options.replace === true;
    const skip = Array.isArray(options.skip) ? (options.skip as string[]) : [];
    // A copy that brings commands to run here always asks first, like a replace: the preview above the
    // question is the only place a person sees them.
    const runs = cloneRunnables(bundle).some(runnable => !skip.includes(runnable.reference));
    const outcome = await runChange(deps, {
      change: {
        kind: 'clone.import',
        mode: replace ? 'replace' : 'alongside',
        bundle: { ...bundle },
        ...(skip.length === 0 ? {} : { skip }),
      },
      destructive: replace || runs,
      options: writeFlags(options),
    });
    if (outcome !== undefined && options.json !== true) {
      deps.out.report(`Sign in to use the copied logins: \`${bin} credentials\` lists each one.`);
    }
  });
}
