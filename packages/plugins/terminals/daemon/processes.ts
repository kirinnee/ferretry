/**
 * A ferret's Processes tab, its Console, the attach proof and the ferret limits (today's `bin/modules/cgroups.ts`,
 * the processes / console / attach parts of `bin/modules/terminal.ts` and their mounts), composed for Terminals'
 * `build(ctx)`. Every route answers through the kernel ports it is handed; nothing here reads a clock, spawns or
 * reads the machine directly (`adapters/host/fs.ts` is the one file that does).
 *
 * WHICH PANE. Every one of these acts on the pane the tmux RUNNER recorded for the ferret (`paneOf`): pane id,
 * pid, the pid's start and the private server's session, re-observed and matched before anything is read, typed
 * or signalled (G29, G34). A name is never a candidate.
 */
import { createHash } from 'node:crypto';
import type { FerretsApi } from '@ferretry/core-ferrets/contract';
import { targetRef } from '@ferretry/core-vault/contract';
import type { ApiResponse, CallContext, FerretId, KernelPorts, RedactionScope } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import {
  CgroupFleetMemory,
  CgroupServiceWeights,
  deviceOfPath,
  hostCgroupFacts,
  PaneSessionMemory,
  ProcCgroupPlacements,
  RunnerCgroupPaneLedger,
  SpawnCgroupCommands,
  SysfsDiskScheduler,
  unmeasuredHostFacts,
} from './adapters/cgroups/index.ts';
import { hostPid, hostPlatform, hostUid } from './adapters/host/fs.ts';
import { TmuxPaneObserver } from './adapters/session/attach/index.ts';
import {
  HarnessProcessProvenance,
  ProjectMcpServers,
  RegularOutputFile,
  SigtermProcessSignal,
} from './adapters/session/processes/output-file.ts';
import { processIncarnationFor } from './adapters/session/processes/process-incarnation.ts';
import { processTreeFor } from './adapters/session/processes/process-tree.ts';
import {
  type CgroupHostFacts,
  CgroupLaunchPlanner,
  EnforcementRuntime,
  FleetMemoryWatcher,
  type LaunchKind,
  LIMITS_TICK_MS,
  LimitsService,
  probeEnforcement,
  type SessionSpawnFactsPort,
} from './lib/cgroups/index.ts';
import { spawnFactsOf } from './spawn-facts.ts';
import { type LimitsConfig, resolveLimits } from './lib/protocol/limits.ts';
import { limitsHandler } from './lib/runtime/mounts/cgroups.ts';
import { attachHandler } from './lib/runtime/mounts/session-attach.ts';
import { consoleInputHandler } from './lib/runtime/mounts/session-console-input.ts';
import { processHandlers } from './lib/runtime/mounts/session-processes.ts';
import { type RegisteredTerminalPane, SessionAttachService } from './lib/session/attach/index.ts';
import { SessionConsoleService } from './lib/session/console/index.ts';
import { PaneLook } from './lib/session/pane-look.ts';
import { ProcessHistory } from './lib/session/processes/history.ts';
import type {
  ProcessProvenancePort,
  ProcessTextRedactor,
  ProcessTreePort,
  SessionTranscriptTailPort,
} from './lib/session/processes/ports.ts';
import type { ProcessIncarnation } from './lib/protocol/process-incarnation.ts';
import { SessionProcessService } from './lib/session/processes/service.ts';
import { hasSessionArguments } from './lib/tmux/commands.ts';
import type { TmuxCommandPort } from './lib/tmux/contracts.ts';
import { TmuxController } from './lib/tmux/controller.ts';

/** The pane the tmux runner recorded for a ferret: its runner handle (the pane id) and the identity proving it. */
export type RunnerPane = RegisteredTerminalPane;

export interface ProcessesDeps {
  readonly kernel: KernelPorts;
  /** The daemon's private tmux server. */
  readonly tmux: TmuxCommandPort;
  /** That server's socket (absolute): the attach proof hands it to the person at this machine. */
  readonly socketPath: string;
  readonly ferrets: Pick<FerretsApi, 'get' | 'list'>;
  /** The pane the tmux runner recorded for this ferret, or nothing when it has none (never started, stopped). */
  paneOf(ferret: FerretId): Promise<RunnerPane | undefined>;
  /**
   * Folders whose files are never served as a process's output (the daemon's home first): a process can append
   * its output to any file its user can open, and this keeps that from reading Ferretry's own state.
   */
  readonly refusedOutputRoots: readonly string[];
  /** The CLI's binary name (`fy`), so the tools server and status line are recognised as the agent's own. */
  readonly binaryName: string;
  /** `limits.yaml` in effect (Ferrets' config). Absent: the computed defaults, disclosed in the status view. */
  readonly limits?: () => Promise<LimitsConfig>;
  /** The ferret's recent conversation, for what the harness recorded about its commands. Absent: none is read. */
  readonly transcript?: SessionTranscriptTailPort;
  /** Who started a ferret, for the Warden's exemption. Absent: its name and parent from Ferrets. */
  readonly spawnFacts?: SessionSpawnFactsPort;
  /** The host reads behind the pane proof and the looks (tests). Absent: `/proc` or `ps`, per platform. */
  readonly host?: ProcessHostReads;
}

/** What the machine is asked about a pane's processes: a pid's start, the tree under a pid, the harness's own. */
export interface ProcessHostReads {
  readonly incarnation?: ProcessIncarnation;
  readonly tree?: ProcessTreePort;
  readonly provenance?: ProcessProvenancePort;
}

/** The six routes, by manifest key. */
interface ProcessRoutes {
  readonly 'GET /v1/ferrets/:ferretId/processes': (call: CallContext) => Promise<ApiResponse>;
  readonly 'GET /v1/ferrets/:ferretId/processes/:processId/output': (call: CallContext) => Promise<ApiResponse>;
  readonly 'POST /v1/ferrets/:ferretId/processes/:processId/stop': (call: CallContext) => Promise<ApiResponse>;
  readonly 'POST /v1/ferrets/:ferretId/console/input': (call: CallContext) => Promise<ApiResponse>;
  readonly 'GET /v1/ferrets/:ferretId/attach': (call: CallContext) => Promise<ApiResponse>;
  readonly 'GET /v1/cgroups/config': (call: CallContext) => Promise<ApiResponse>;
}

/** What the tmux runner asks of the limits before it starts a pane (docs/ferret-limits.md). */
interface LaunchLimits {
  /** The argv this pane must exec: the harness's command wrapped in the ferret's scope, or as it is. */
  command(ferret: string, command: readonly string[], kind?: LaunchKind): Promise<readonly string[]>;
  /** The shared agent browser's argv (Browsers): one bounded slice. */
  browserCommand(command: readonly string[]): Promise<readonly string[]>;
}

export interface Processes {
  readonly routes: ProcessRoutes;
  readonly limits: LaunchLimits;
  /** The read-only looks at a ferret's own pane the Warden takes (`liveness`, `paneBrowsers`). */
  readonly look: PaneLook;
}

/** Every vault-scrubbed string in the Processes tab goes through ONE `Redaction.read` per answer (S17). */
export function redactorOf(read: KernelPorts['redaction']['read']): ProcessTextRedactor {
  return { batch: async work => await read((scope: RedactionScope) => work({ text: text => scope.text(text) })) };
}

/** A nonce per launch, so a relaunch cannot collide with a scope that is still deactivating. */
const nonce = (): string => crypto.randomUUID().slice(0, 8);

export function buildProcesses(deps: ProcessesDeps): Processes {
  const { kernel } = deps;
  const log = kernel.log.child('processes');
  const nowMs = (): number => kernel.clock.nowMs();
  const after = (ms: number, fn: () => void): (() => void) => kernel.clock.after(milliseconds(ms), fn);
  const incarnation = deps.host?.incarnation ?? processIncarnationFor(hostPlatform, kernel.spawn);
  const tree = deps.host?.tree ?? processTreeFor(kernel.spawn);
  const observer = new TmuxPaneObserver(new TmuxController(deps.tmux), incarnation);
  const attach = new SessionAttachService(
    deps.socketPath,
    { paneOf: async id => await deps.paneOf(id as FerretId) },
    observer,
  );
  const console = new SessionConsoleService(attach, deps.tmux);
  const provenance = deps.host?.provenance ?? new HarnessProcessProvenance(deps.binaryName, new ProjectMcpServers());
  const processes = new SessionProcessService({
    panes: attach,
    tree,
    provenance,
    files: new RegularOutputFile(),
    signals: new SigtermProcessSignal(),
    transcript: deps.transcript ?? { tail: async () => ({ kind: 'unresolved' }) },
    redactor: redactorOf(kernel.redaction.read.bind(kernel.redaction)),
    history: new ProcessHistory(),
    clock: { nowMs },
    refusedOutputRoots: deps.refusedOutputRoots,
  });

  // ─── the Warden's looks at a ferret's own pane (read only) ──────────────────────────────────────────────────────
  const look = new PaneLook({
    panes: attach,
    tree,
    provenance,
    incarnation,
    // Confirmed gone: no registration, or tmux answers that its session does not exist (today's second question).
    paneAbsent: async ferret => {
      const registered = await deps.paneOf(ferret as FerretId);
      if (registered === undefined) return true;
      return (await deps.tmux.execute(hasSessionArguments(registered.tmuxSession))).code !== 0;
    },
    // The visible screen of the PROVED pane, read as an act on it (a hold refuses it) and masked inside that act.
    screen: async paneId => {
      const answer = await kernel.act(targetRef('terminal', paneId), 'read', async () => {
        const captured = await deps.tmux.execute(['capture-pane', '-p', '-t', paneId]);
        if (captured.code !== 0) throw new Error(captured.stderr.trim() || `tmux exited ${captured.code}`);
        return await kernel.redaction.read(scope => ({ kind: 'content' as const, text: scope.text(captured.stdout) }));
      });
      return answer.ok ? answer.value.text : undefined;
    },
    digest: text => createHash('sha256').update(text, 'utf8').digest('hex'),
    nowMs,
  });

  // ─── ferret limits ──────────────────────────────────────────────────────────────────────────────────────────────
  const limitsInEffect = deps.limits ?? (async (): Promise<LimitsConfig> => ({}));
  const commands = new SpawnCgroupCommands(kernel.spawn, after);
  const spawnFacts: SessionSpawnFactsPort = deps.spawnFacts ?? spawnFactsOf(deps.ferrets);
  /** The machine, measured ONCE: a machine does not grow CPUs while a daemon runs. */
  const measured: Promise<CgroupHostFacts> = hostCgroupFacts().catch(() => unmeasuredHostFacts());
  const built = measured.then(host => {
    const enforcement = new EnforcementRuntime(async () => await probeEnforcement(host, commands), nowMs);
    const planner = new CgroupLaunchPlanner({
      limits: limitsInEffect,
      host,
      commands,
      sessions: spawnFacts,
      enforcement,
      nonce,
      // A ferret that had to start unconfined says so in the daemon log, not only in the status.
      warn: message => log.warn(message),
    });
    const watcher = new FleetMemoryWatcher({
      fleet: new CgroupFleetMemory(host),
      memory: new PaneSessionMemory(
        new RunnerCgroupPaneLedger(
          {
            live: async () =>
              (await deps.ferrets.list()).filter(ferret => ferret.state !== 'stopped').map(ferret => ferret.id),
            paneOf: deps.paneOf,
          },
          observer,
        ),
        tree,
      ),
      notes: {
        // A ferret slowed or killed for memory is said in the daemon log (its journal is Ferrets').
        note: async (sessionId, kind) =>
          log.warn(`ferret ${sessionId}: ${kind.replace('_', ' ')}`, { ferret: sessionId }),
        callsign: async sessionId => (await deps.ferrets.get(sessionId as FerretId))?.name,
      },
      now: nowMs,
      iso: ms => new Date(ms).toISOString(),
    });
    const service = new LimitsService({
      limits: limitsInEffect,
      host,
      enforcement,
      disk: new SysfsDiskScheduler(async () => await deviceOfPath(deps.refusedOutputRoots[0] ?? '/')),
      services: new CgroupServiceWeights(host),
      watcher,
      placements: new ProcCgroupPlacements(),
      daemonPid: hostPid,
      file: 'limits.yaml',
      uid: hostUid,
      clock: iso => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
    });
    // Asked once at boot, so the first status already says why nothing is enforced; never blocks the start.
    void enforcement
      .refresh()
      .then(state => {
        if (state.kind === 'direct') log.info(`ferret limits are not enforced: ${state.reason}`);
      })
      .catch(() => undefined);
    return { host, planner, watcher, service };
  });
  // The kernel's own counters are read on THIS timer only — never per request.
  kernel.jobs.add({
    id: 'ferret-limits',
    schedule: { every: milliseconds(LIMITS_TICK_MS) },
    run: async () => {
      const { host, watcher } = await built;
      const resolved = resolveLimits(await limitsInEffect(), { memoryCeilingBytes: host.memoryCeilingBytes });
      if (!resolved.enabled) return;
      if (host.platform === 'darwin') await watcher.tickWatch(resolved);
      else if (host.platform === 'linux' && host.unifiedHierarchy) await watcher.tickLinux();
    },
  });

  const handlers = processHandlers(processes, deps.ferrets);
  return {
    routes: {
      'GET /v1/ferrets/:ferretId/processes': handlers.list,
      'GET /v1/ferrets/:ferretId/processes/:processId/output': handlers.output,
      'POST /v1/ferrets/:ferretId/processes/:processId/stop': handlers.stop,
      'POST /v1/ferrets/:ferretId/console/input': consoleInputHandler(console, deps.ferrets),
      'GET /v1/ferrets/:ferretId/attach': attachHandler(attach, deps.ferrets),
      'GET /v1/cgroups/config': limitsHandler({
        view: async () => {
          const view = await (await built).service.view();
          return deps.limits === undefined
            ? {
                ...view,
                warnings: [...view.warnings, 'Ferrets does not provide effective limits; using built-in defaults.'],
              }
            : view;
        },
      }),
    },
    limits: {
      command: async (ferret, command, kind) => await (await built).planner.command(ferret, command, kind),
      browserCommand: async command => await (await built).planner.browserCommand(command),
    },
    look,
  };
}
