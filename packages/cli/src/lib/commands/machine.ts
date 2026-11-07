/**
 * `fy machine`, `machine set|install|export|clone`: this machine's tools, its agent permissions, and copying a setup
 * from another machine (V-0312 … V-0316). Moved from today's `machine/commands.ts`; every daemon read and write goes
 * through the guarded client to the Runtimes routes, parsed through the Runtimes contract.
 *
 * The shell reads one value per `--name`, so what commander took as `--skip <item...>` is written
 * `--skip mcp/notes --skip hooks/guard`.
 */
import type { VerbInvocation } from '@ferretry/kernel/manifest';
import {
  type AccountChange,
  type AgentControl,
  type CloneBundle,
  CloneBundleSchema,
  type MachineView,
  type SetupTool,
  type ToolInstallOutcome,
} from '@ferretry/plugin-runtimes/contract';
import { optionOn } from '../argv.ts';
import { EXIT } from '../errors.ts';
import { confirmStep, requireMayApply, runChange } from '../machine/change.ts';
import { type CloneOptions, runClone } from '../machine/clone-command.ts';
import { optionList, parseHarness, readLocalFile, writeFlags } from '../machine/flags.ts';
import { ClientMachineGateway } from '../machine/gateway.ts';
import { type MachineDeps, MachineCommandError, type MachineHarness } from '../machine/ports.ts';
import { HARNESS_LABEL, indent } from '../machine/render.ts';
import type { ShellContext, ShellVerb } from '../shell-context.ts';

/** "What agents may control", by the word `machine set agent-control` takes, in the order it names them. */
const AGENT_CONTROL_FIELDS = {
  terminals: 'terminals',
  browsers: 'browsers',
  files: 'files',
  // The `config.*` tools: an agent editing this machine's configuration files (docs/config-files.md).
  settings: 'ferretrySettings',
  // `browser.eval`: an agent's own JavaScript in a page it drives. Turning it on waits for the owner.
  scripts: 'pageScripts',
} as const satisfies Record<string, keyof AgentControl>;
type AgentControlWord = keyof typeof AGENT_CONTROL_FIELDS;

const agentControlWords = (control: AgentControl): string =>
  (Object.entries(AGENT_CONTROL_FIELDS) as [AgentControlWord, keyof AgentControl][])
    .map(([word, field]) => `${word} ${control[field] ? 'on' : 'off'}`)
    .join(', ');

/** The machine's facts: its tools, its Agent permissions, and whether it is set up yet. */
export function renderMachine(machine: MachineView, binaryName: string): string {
  const format = machine.format === 'none' ? 'not set up yet' : 'the account model';
  return [
    machine.name,
    ...indent([
      `Setup: ${format}${machine.setUp ? `, ${String(machine.runtimeCount)} runtime(s)` : ''}`,
      `Agent permissions: ${machine.agentPermissions === 'auto' ? 'auto (the tool decides what needs asking)' : 'skip (agents are never asked)'}`,
      `Default runtime for new agents: ${machine.defaultRuntime ?? 'none set, and no claude-default runtime exists yet'}`,
      `What agents may control: ${agentControlWords(machine.agentControl)}`,
      ...autoResumeLines(machine),
      `Agenda mode for new ferrets: ${machine.agendaMode ? 'on' : 'off'}`,
      `Ferrets running: ${String(machine.runningSessions)}`,
      'Tools:',
      ...machine.tools.map(
        tool =>
          `  ${tool.label}: ${tool.installed ? `installed${tool.command ? ` (${tool.command})` : ''}` : 'not installed'}`,
      ),
    ]),
    ...(machine.setUp ? [] : ['', `Set it up with \`${binaryName} onboard\`, or pair a phone and finish in the app.`]),
  ].join('\n');
}

/** "Auto-resume after restart" and what the last pass did, in words. */
function autoResumeLines(machine: MachineView): string[] {
  const last = machine.lastAutoResume;
  return [
    `Auto-resume after restart: ${machine.autoResume ? 'on' : 'off'}`,
    ...(last === null
      ? []
      : [
          `  Last restart: resumed ${String(last.resumed)} ferret${last.resumed === 1 ? '' : 's'} (${last.at})`,
          ...last.skipped.map(item => `  Couldn't auto-resume ${item.sessionId}: ${item.reason}`),
        ]),
  ];
}

/** How installing one tool ended, in words. */
function renderInstallOutcome(outcome: ToolInstallOutcome): string {
  const label = HARNESS_LABEL[outcome.harness];
  if (outcome.outcome === 'already-installed') return `${label} was already installed.`;
  if (outcome.outcome === 'installed') return `${label} is installed.`;
  return `${label} was not installed: ${outcome.reason}\n  Run it yourself: ${outcome.manualCommand}`;
}

/**
 * Install harness tools: show the exact command first, ask, then run it through the daemon. Returns whether every
 * requested tool ended installed. A failure is a non-zero exit with the command to run by hand; nothing here runs `sudo`.
 */
export async function installTools(
  deps: MachineDeps,
  harnesses: readonly MachineHarness[],
  options: { yes?: boolean; dryRun?: boolean },
): Promise<boolean> {
  await requireMayApply(deps);
  const scan = await deps.gateway.scan();
  const wanted = scan.tools.filter(tool => harnesses.includes(tool.harness));
  const missing = wanted.filter((tool): tool is Extract<SetupTool, { installed: false }> => !tool.installed);
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
export function parseCloneBundle(text: string, path: string): CloneBundle {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new MachineCommandError(`${path} is not a setup export: it is not JSON.`);
  }
  const parsed = CloneBundleSchema.safeParse(value);
  if (!parsed.success) throw new MachineCommandError(`${path} is not a setup export from \`machine export\`.`);
  return parsed.data;
}

type MachineSettings = Extract<AccountChange, { kind: 'machine.settings' }>;

/**
 * The machine settings as one change always carries them, built from the ONE field a person named: the wire contract
 * never lets one field be changed without restating the others, so a single-setting command reads the current view and
 * changes only the field it names.
 */
export function machineSettingsEdit(
  setting: string,
  value: readonly string[],
  current: MachineView,
  binaryName: string,
): MachineSettings {
  const base: MachineSettings = {
    kind: 'machine.settings',
    agentPermissions: current.agentPermissions,
    defaultRuntime: current.defaultRuntime,
    agentControl: { ...current.agentControl },
    browserMode: current.browserMode,
    browserProxy: current.browserProxy,
    browserPorts: current.browserPorts,
    browserFirewallFailure: current.browserFirewallFailure,
    autoResume: current.autoResume,
    agendaMode: current.agendaMode,
    publicUsageFeed: current.publicUsageFeed,
  };
  const onOff = (): boolean => {
    const [state] = value;
    if (state !== 'on' && state !== 'off') throw new MachineCommandError('Say on or off.');
    return state === 'on';
  };
  if (setting === 'agent-permissions') {
    const [next] = value;
    if (next !== 'auto' && next !== 'skip') throw new MachineCommandError('Agent permissions are auto or skip.');
    return { ...base, agentPermissions: next };
  }
  if (setting === 'default-runtime') {
    const [next] = value;
    if (next === undefined || next === '') {
      throw new MachineCommandError(
        `Name a runtime, or "automatic" for the machine's own fallback. Try: ${binaryName} machine set default-runtime claude-default`,
      );
    }
    return { ...base, defaultRuntime: next === 'automatic' ? null : next };
  }
  if (setting === 'agent-control') {
    const [kind, state] = value;
    if (kind === undefined || !Object.hasOwn(AGENT_CONTROL_FIELDS, kind)) {
      throw new MachineCommandError(
        `"${kind}" is not one of ${Object.keys(AGENT_CONTROL_FIELDS).join(', ')}. Try: ${binaryName} machine set agent-control terminals on`,
      );
    }
    if (state !== 'on' && state !== 'off') throw new MachineCommandError('Say on or off.');
    const field = AGENT_CONTROL_FIELDS[kind as AgentControlWord];
    return { ...base, agentControl: { ...base.agentControl, [field]: state === 'on' } };
  }
  if (setting === 'auto-resume') return { ...base, autoResume: onOff() };
  if (setting === 'agenda-mode') return { ...base, agendaMode: onOff() };
  throw new MachineCommandError(
    `"${setting}" is not a machine setting. Try: ${binaryName} machine set agent-permissions auto`,
  );
}

/** The flags `machine clone` takes, as the shell parsed them. */
function cloneOptions(invocation: VerbInvocation): CloneOptions {
  const forget = invocation.options.forget;
  return {
    ...writeFlags(invocation),
    ...(optionOn(invocation, 'replace') ? { replace: true } : {}),
    ...(optionOn(invocation, 'alongside') ? { alongside: true } : {}),
    skip: optionList(invocation, 'skip'),
    theirs: optionList(invocation, 'theirs'),
    mine: optionList(invocation, 'mine'),
    remove: optionList(invocation, 'remove'),
    login: optionList(invocation, 'login'),
    ...(typeof forget === 'string' ? { forget } : {}),
  };
}

/**
 * Builds the verb's dependencies and runs it, turning a refusal in words into its message and exit 1. Everything
 * else (a daemon that refuses, a network error) is left to the router's own handling.
 */
function withMachine(run: (deps: MachineDeps, ctx: ShellContext) => Promise<void>): ShellVerb {
  return async ctx => {
    const { world } = ctx;
    if (world.prompt === undefined || world.readText === undefined) {
      world.io.err('This fy has no local terminal adapters.\n');
      return EXIT.unavailable;
    }
    let code = 0;
    const { io } = world;
    const prompt = world.prompt;
    const deps: MachineDeps = {
      gateway: new ClientMachineGateway(ctx.client('runtimes')),
      out: {
        success: message => io.out(`${message}\n`),
        report: message => io.out(`${message}\n`),
        warn: message => io.err(`${message}\n`),
        error: message => io.err(`${message}\n`),
        setExitCode: value => {
          code = value;
        },
      },
      prompt,
      interactive: io.isTty,
      readText: world.readText,
      binaryName: world.identity.binary,
    };
    try {
      await run(deps, ctx);
    } catch (error) {
      if (!(error instanceof MachineCommandError)) throw error;
      io.err(`${error.message}\n`);
      return EXIT.failure;
    }
    return code;
  };
}

/** V-0312: this machine, as words or (--json) as the daemon's own view. */
export const machineShowVerb = withMachine(async (deps, ctx) => {
  const view = await deps.gateway.machine();
  deps.out.report(
    optionOn(ctx.invocation, 'json') ? JSON.stringify(view, null, 2) : renderMachine(view, deps.binaryName),
  );
});

/** V-0316: change one machine setting. */
export const machineSetVerb = withMachine(async (deps, ctx) => {
  const [setting, ...value] = ctx.invocation.args;
  if (setting === undefined)
    throw new MachineCommandError(
      `Name the setting: ${deps.binaryName} machine set <setting> <value...> (agent-permissions, default-runtime, agent-control, auto-resume, agenda-mode).`,
    );
  const current = await deps.gateway.machine();
  const change = machineSettingsEdit(setting, value, current, deps.binaryName);
  await runChange(deps, { change, destructive: true, options: writeFlags(ctx.invocation) });
});

/** V-0315: install Claude Code or Codex. */
export const machineInstallVerb = withMachine(async (deps, ctx) => {
  const tools = ctx.invocation.args;
  if (tools.length === 0)
    throw new MachineCommandError(`Name a tool: ${deps.binaryName} machine install claude, codex, or both.`);
  await installTools(deps, [...new Set(tools.map(parseHarness))], writeFlags(ctx.invocation));
});

/** V-0314: print this machine's setup for `machine clone` on another. */
export const machineExportVerb = withMachine(async deps => {
  await requireMayApply(deps);
  deps.out.report(JSON.stringify(await deps.gateway.exportBundle(), null, 2));
});

/** V-0313: copy a setup exported from another machine, or update an earlier copy. */
export const machineCloneVerb = withMachine(async (deps, ctx) => {
  const [file] = ctx.invocation.args;
  const options = cloneOptions(ctx.invocation);
  const bundle =
    options.forget !== undefined || file === undefined
      ? undefined
      : parseCloneBundle(await readLocalFile(deps.readText, file), file);
  await runClone(deps, file, bundle, options);
});
