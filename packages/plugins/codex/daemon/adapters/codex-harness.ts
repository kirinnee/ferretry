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
  HarnessMissing,
  HomePlan,
  LaunchSpec,
  Runner,
  RunnerHandle,
  RunSpec,
  Started,
  StartRefusal,
} from '@ferretry/core-ferrets/contract';
import { err, ok, type Result } from '@ferretry/std';
import { buildCodexLaunchArgv, tomlTables } from '../lib/index.ts';
import type { HarnessConfig } from '../../contract/index.ts';
import { codexFixedArguments } from '../lib/fixed-layer.ts';
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
  const rollouts = new CodexRollouts(kernel, options.historyDirectory ?? (async () => undefined));

  /** `CODEX_HOME` is set by an `env` prefix: the Vault's environment is an opaque handle this code cannot add to. */
  const command = async (spec: LaunchSpec, resume?: string): Promise<Result<readonly string[], StartRefusal>> => {
    const location = await locate();
    if (location.outcome !== 'located') return err('unavailable');
    return ok([
      'env',
      `CODEX_HOME=${spec.home}`,
      ...buildCodexLaunchArgv({
        executable: location.path,
        harnessFlags: [
          ...codexFixedArguments(options.permissionMode?.() ?? 'auto', spec.folder),
          ...codexCorrelationArguments(spec.home),
        ],
        ...(resume === undefined ? {} : { resume }),
        ...(spec.model === undefined ? {} : { model: spec.model }),
        ...(spec.effort === undefined ? {} : { effort: spec.effort }),
        ...(spec.prompt === undefined ? {} : { prompt: spec.prompt }),
      }),
    ]);
  };

  const launch = async (
    spec: LaunchSpec,
    runner: Runner,
    env: ChildEnvironment,
    harnessConversation?: string,
  ): Promise<Result<Started, StartRefusal>> => {
    const argv = await command(spec, harnessConversation);
    if (!argv.ok) return argv;
    await rollouts.launched(spec, harnessConversation);
    const running =
      harnessConversation === undefined
        ? await runner.start({ ferret: spec.ferret, command: argv.value, cwd: spec.folder, env })
        : await runner.resume({ ferret: spec.ferret, command: argv.value, cwd: spec.folder, env }, harnessConversation);
    if (!running.ok) return running;
    // Codex mints its own conversation id after launch; Conversation finds it, so none is claimed here.
    return ok({ running: running.value, ...(harnessConversation === undefined ? {} : { harnessConversation }) });
  };

  const refused = (id: string, reason: string): Delivery => ({ status: 'refused', id, reason });

  return {
    key: 'codex',

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

    async prepareHome(spec: LaunchSpec): Promise<HomePlan> {
      const root = kernel.roots.root('agent-homes', { ferret: spec.ferret });
      const files: FencedPath[] = [];
      for (const [name, text] of [
        ['AGENTS.md', agentsDocument(spec)],
        ['config.toml', configDocument(spec)],
      ] as const) {
        if (text === '') continue;
        const target = root.resolve(`${spec.home}/${name}`);
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

    transcript: rollouts.transcript,
    usage: rollouts.usage,
    conversations: rollouts.conversations,
  };
}
