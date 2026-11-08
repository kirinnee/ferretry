/**
 * Codex as a harness (§4.3): the value of `harnesses:codex`.
 *
 * It finds the binary and its version (never its sign-in files), writes a ferret's home in Codex's own format, builds
 * the launch argv, and starts, resumes and stops through whichever runner Ferrets hands it. It never reads
 * `auth.json`: the login's credentials arrive as the Vault's `ChildEnvironment`, which this code passes on unopened.
 *
 */
import type { FencedPath, FerretId, KernelPorts } from '@ferretry/kernel/contract';
import type {
  Delivery,
  Harness,
  HarnessInstall,
  HarnessLaunchSettings,
  HarnessMissing,
  HomePlan,
  LaunchSpec,
  Runner,
  RunnerHandle,
  RunSpec,
  Started,
  StartRefusal,
} from '@ferretry/core-ferrets/contract';
import { codexLaunchFailure } from '@ferretry/plugin-runtimes/contract';
import { err, ok, type Result } from '@ferretry/std';
import { buildCodexLaunchArgv, tomlTables } from '../lib/index.ts';
import { CODEX_LAUNCH_SETTINGS, type HarnessConfig } from '../../contract/index.ts';
import { codexFixedArguments } from '../lib/fixed-layer.ts';
import { compareCodexLaunchSettings, codexLaunchSettingsRecord } from '../lib/launch-settings.ts';
import { codexCorrelationArguments } from '../lib/transcript/rollout.ts';
import { CodexRollouts } from './rollouts.ts';
import {
  HarnessUpdateRefusal,
  type HarnessLocation,
  type HarnessProbe,
  type HarnessUpdateSubsystem,
} from '../lib/update/index.ts';

/** The Vault-resolved environment a launch passes on unopened. */
type ChildEnvironment = RunSpec['env'];

export interface CodexHarnessOptions {
  readonly kernel: Pick<KernelPorts, 'roots' | 'log' | 'clock' | 'redaction' | 'state'>;
  readonly permissionMode?: () => HarnessConfig['permissionMode'];
  readonly historyDirectory?: () => Promise<string | undefined>;
  readonly locate: () => Promise<HarnessLocation>;
  readonly probe: HarnessProbe;
  readonly update: HarnessUpdateSubsystem & { settled(): Promise<void> };
}

/** A ferret id is one plain name before it names a folder (the S45 grammar Claude Code's home uses too). */
const PLAIN_FERRET = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

/** A launch record is two fingerprints (~180 bytes); one larger than this is not one, and is never read. */
const MAX_LAUNCH_RECORD_BYTES = 4 * 1024;
const UNKNOWN_LAUNCH: HarnessLaunchSettings = { kind: 'unknown' };

/** Codex's `AGENTS.md`: the instructions every launch writes into the ferret's home. */
function agentsDocument(spec: LaunchSpec): string {
  const sections = [
    ...spec.instructions.map(entry => entry.text.trim()),
    ...spec.parts.flatMap(part => (part.kind === 'instruction' ? [part.text.trim()] : [])),
  ].filter(text => text !== '');
  return sections.length === 0 ? '' : `${sections.join('\n\n')}\n`;
}

/** Codex's `config.toml`: one `[mcp_servers.<name>]` table per MCP server the launch adds. */
function configDocument(spec: LaunchSpec): string {
  const servers: Record<string, Record<string, unknown>> = {};
  for (const part of spec.parts) {
    if (part.kind !== 'mcp') continue;
    const config = part.config;
    servers[part.name] = typeof config === 'object' && config !== null && !Array.isArray(config) ? config : {};
  }
  return Object.keys(servers).length === 0 ? '' : `${tomlTables('mcp_servers', servers)}\n`;
}

export function codexHarness(options: CodexHarnessOptions): Harness {
  const { kernel, locate, probe, update } = options;
  const permissionModeNow = (): HarnessConfig['permissionMode'] => options.permissionMode?.() ?? 'auto';
  const rollouts = new CodexRollouts(kernel, options.historyDirectory ?? (async () => undefined));

  /** `CODEX_HOME` is set by an `env` prefix: the Vault's environment is an opaque handle this code cannot add to. */
  const command = async (
    spec: LaunchSpec,
    permissionMode: HarnessConfig['permissionMode'],
    resume?: string,
  ): Promise<Result<readonly string[], StartRefusal>> => {
    const location = await locate();
    if (location.outcome !== 'located') return err('unavailable');
    return ok([
      'env',
      `CODEX_HOME=${spec.home}`,
      ...buildCodexLaunchArgv({
        executable: location.path,
        harnessFlags: [...codexFixedArguments(permissionMode, spec.folder), ...codexCorrelationArguments(spec.home)],
        ...(resume === undefined ? {} : { resume }),
        ...(spec.model === undefined ? {} : { model: spec.model }),
        ...(spec.effort === undefined ? {} : { effort: spec.effort }),
      }),
    ]);
  };

  const launch = async (
    spec: LaunchSpec,
    runner: Runner,
    env: ChildEnvironment,
    harnessConversation?: string,
  ): Promise<Result<Started, StartRefusal>> => {
    // ONE read of the permission mode per launch: the argv and the record describe the same setting.
    const permissionMode = permissionModeNow();
    const argv = await command(spec, permissionMode, harnessConversation);
    if (!argv.ok) return argv;
    await ensureHome(spec);
    await rollouts.launched(spec, harnessConversation);
    await recordLaunchSettings(spec.ferret, permissionMode);
    const running =
      harnessConversation === undefined
        ? await runner.start({ ferret: spec.ferret, command: argv.value, cwd: spec.folder, env })
        : await runner.resume({ ferret: spec.ferret, command: argv.value, cwd: spec.folder, env }, harnessConversation);
    if (!running.ok) return running;
    // Codex mints its own conversation id after launch; Conversation finds it, so none is claimed here.
    return ok({ running: running.value, ...(harnessConversation === undefined ? {} : { harnessConversation }) });
  };

  /**
   * Records what this launch runs under, before the process starts (W2-c). A launch never fails over it: when the record
   * cannot be written, the one an earlier launch left is removed, so the answer for this process is `unknown` and never
   * an older launch's.
   */
  const recordLaunchSettings = async (
    ferret: FerretId,
    permissionMode: HarnessConfig['permissionMode'],
  ): Promise<void> => {
    try {
      await kernel.state.write(CODEX_LAUNCH_SETTINGS, codexLaunchSettingsRecord(permissionMode), ferret);
    } catch {
      try {
        await kernel.state.remove(CODEX_LAUNCH_SETTINGS, ferret);
      } catch {
        // Nothing more can be done: the read then finds whatever is left, and a damaged record reads as unknown.
      }
    }
  };

  const refused = (id: string, reason: string): Delivery => ({ status: 'refused', id, reason });

  /** The ferret's own home handle: `state/codex/agent-homes/<ferret>` through this plugin's own root. */
  const homeRoot = (ferret: FerretId) => {
    if (!PLAIN_FERRET.test(ferret)) throw new Error('the ferret id must be one plain name');
    return kernel.roots.root('agent-homes', { ferret, subfolder: ferret });
  };
  const homeOf = (ferret: FerretId): FencedPath => {
    const home = homeRoot(ferret).resolve('');
    if (!home.ok) throw new Error(`the ferret's Codex home could not be placed: ${home.error}`);
    return home.value;
  };
  /**
   * The ferret's home, made before anything is written through it or Codex is launched in it (as Claude Code does):
   * refused unless `spec.home` is exactly this plugin's home for the ferret, then created or narrowed to 0700 by the
   * kernel through the checked `agent-homes` folder, refused when a link or a file is at its name (S42).
   */
  const ensureHome = async (spec: LaunchSpec) => {
    const home = homeRoot(spec.ferret);
    if (homeOf(spec.ferret) !== spec.home) throw new Error("the launch home is not this ferret's Codex home");
    const homes = kernel.roots.root('agent-homes');
    const folder = homes.resolve(spec.ferret);
    if (!folder.ok) throw new Error(`the ferret's Codex home could not be placed: ${folder.error}`);
    await homes.ensurePrivateDirectory(folder.value);
    return home;
  };

  return {
    key: 'codex',
    // Today's stop key. NOT safe when idle: at an idle Codex prompt a stop key is one of the ways the TUI quits, so an
    // interrupt presses it only while the pane shows active work (`shouldPressStopKey`).
    turnStop: { key: 'Escape', safeWhenIdle: false },

    async discover(): Promise<HarnessInstall | HarnessMissing> {
      const location = await locate();
      if (location.outcome === 'absent') return { found: false, reason: 'codex was not found on this machine' };
      if (location.outcome === 'override-absent') return { found: false, reason: location.reason };
      const installed = await probe.version(location.path);
      return installed.state === 'ok'
        ? { found: true, binary: location.path, version: installed.version }
        : { found: false, reason: `codex at ${location.path} did not report a version (${installed.reason})` };
    },

    async update() {
      try {
        await update.start({});
        await update.settled();
        const job = (await update.view()).job;
        if (job?.state !== 'finished') return { updated: false, sentence: 'the update did not finish' };
        const report = job.report;
        return {
          updated: report.outcome === 'succeeded',
          ...(report.to === undefined ? {} : { version: report.to }),
          sentence: report.message,
        };
      } catch (error) {
        if (error instanceof HarnessUpdateRefusal) return { updated: false, sentence: error.message };
        throw error;
      }
    },

    // The ChatGPT sign-in, a plain API key, and the gateways Codex can be pointed at.
    accepts: ['openai', 'api-key', 'proxy', 'endpoint'],

    /** `state/codex/agent-homes/<ferret>`, resolved through this plugin's own `agent-homes` root (S42). */
    async homeFor(ferret: FerretId): Promise<FencedPath> {
      return homeOf(ferret);
    },

    async prepareHome(spec: LaunchSpec): Promise<HomePlan> {
      const root = await ensureHome(spec);
      const files: FencedPath[] = [];
      for (const [name, text] of [
        ['AGENTS.md', agentsDocument(spec)],
        ['config.toml', configDocument(spec)],
      ] as const) {
        if (text === '') continue;
        const target = root.resolve(name);
        if (!target.ok) throw new Error(`Codex's ${name} could not be placed in the ferret's home: ${target.error}`);
        await root.writeText(target.value, text);
        files.push(target.value);
      }
      return { files, args: [] };
    },

    start: async (spec, runner, env) => await launch(spec, runner, env),
    resume: async (spec, runner, env, harnessConversation) => await launch(spec, runner, env, harnessConversation),

    async stop(_ferret: FerretId, handle: RunnerHandle, runner: Runner, how: 'polite' | 'now'): Promise<void> {
      await runner.stop(handle, how);
    },

    async deliver(_ferret, _handle, message): Promise<Delivery> {
      return refused(message.id, 'Codex messages are sent through Conversation, which owns the send path');
    },

    // Today's RuntimeSupervisedLauncher: a pane that died starting because Codex could not reach the network is told
    // so in words. The sentence is fixed text; the screen is only matched, never quoted.
    startFailure: screen => codexLaunchFailure(screen),

    /**
     * Whether a relaunch would run this ferret on other settings of this plugin's than its last start or resume did
     * (`Harness.launchSettings`, W2-c). Names sections only. Total: no record, a record too large to be one, a damaged
     * one or any failure is `unknown`, and what failed is dropped unread.
     */
    async launchSettings(ferret: FerretId): Promise<HarnessLaunchSettings> {
      try {
        if (!PLAIN_FERRET.test(ferret)) return UNKNOWN_LAUNCH;
        const size = (await kernel.state.version(CODEX_LAUNCH_SETTINGS, ferret))?.size;
        if (size === undefined || size > MAX_LAUNCH_RECORD_BYTES) return UNKNOWN_LAUNCH;
        const recorded = await kernel.state.read(CODEX_LAUNCH_SETTINGS, ferret);
        if (!recorded.ok || recorded.value === undefined) return UNKNOWN_LAUNCH;
        return compareCodexLaunchSettings(recorded.value, codexLaunchSettingsRecord(permissionModeNow()));
      } catch {
        return UNKNOWN_LAUNCH;
      }
    },

    transcript: rollouts.transcript,
    transcriptStamp: rollouts.stamp,
    transcriptTail: rollouts.tail,
    usage: rollouts.usage,
    conversations: rollouts.conversations,
  };
}
