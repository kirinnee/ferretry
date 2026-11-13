/**
 * Terminals' daemon half (§2.3): ferrets' terminals to drive, the owner's viewer on them, the default place ferrets
 * run (`runners:tmux`), and the guarded write the Vault types an owner's value through (`input.targets:terminal`).
 *
 * `build` composes today's `bin/modules/terminal.ts`, the terminal half of `lib/agent-tools/service.ts` and the
 * processes / console / attach / limits composition (`processes.ts`) over the kernel's ports:
 *
 * - EVERY ACT GOES THROUGH `kernel.act(targetRef('terminal', <tmux pane id>), op, fn)` (§4.7): reads, waits and the
 *   viewer's frames (`read`/`wait`/`stream`), keys, open and close (Acks). The pane id is what the Vault sees in a
 *   card's facts (`paneProof.paneId`), so its holds and these acts name one target.
 * - EVERY READ OF PANE TEXT IS MASKED INSIDE ONE `kernel.redaction.read` (§7.3) — the wait predicate included (I103).
 * - `terminal_ask_owner` and `terminal_request_input` are not acts: they raise through the control store and Vault.
 */
import { createHash } from 'node:crypto';
import { ferretOf } from '@ferretry/core-gate/contract';
import type { FerretsApi } from '@ferretry/core-ferrets/contract';
import {
  type InputFieldValue,
  type InputTarget,
  type InputTargetAdapter,
  type InputTargetFacts,
  type InputTargetField,
  type TypeOptions,
  targetRef,
} from '@ferretry/core-vault/contract';
import {
  agentControlRefusal,
  ApiError,
  type CallContext,
  decodeParameter,
  type FerretId,
  type KernelPorts,
  jsonResponse,
} from '@ferretry/kernel/contract';
import { type DaemonContext, implementDaemon, type ToolResult } from '@ferretry/kernel/manifest';
import { instantFromEpochMs, milliseconds } from '@ferretry/std';
import { z } from 'zod';
import {
  SurfaceControlRequestSchema,
  TERMINAL_MAX_GLOBAL,
  TERMINAL_MAX_PER_SESSION,
  TerminalAskOwnerInputSchema,
  TerminalCloseInputSchema,
  TerminalListInputSchema,
  TerminalOpenInputSchema,
  TerminalReadInputSchema,
  type TerminalsApi,
  TerminalSendInputSchema,
  type TerminalsConfig,
  TerminalWaitInputSchema,
} from '../contract/index.ts';
import manifest from '../manifest.ts';
import { hostPlatform, hostUserId, stat } from './adapters/host/fs.ts';
import { ExecutableCodePrograms } from './adapters/system/executable-code-programs.ts';
import { KernelProgramProof } from './adapters/system/kernel-program-proof.ts';
import {
  FerretTerminalOwnerDirectory,
  ManagedTerminalService,
  programRunner,
  RedactingTerminalStreamService,
  type StreamAct,
  StateSurfaceEvents,
  StateTerminalPanes,
  type TerminalsStateFile,
  systemLoginShell,
  TerminalRuntimeError,
  TerminalServiceError,
  TerminalStreamBridge,
  type TerminalStreamScheduler,
  TmuxTerminalRuntime,
} from './adapters/terminal/index.ts';
import { ControlModeTmuxProcess, type ControlChild } from './adapters/tmux/control-tmux-process.ts';
import { KernelTmuxProcess, TMUX_PROGRAM } from './adapters/tmux/kernel-tmux-process.ts';
import { TmuxRunner, ferretTmuxSession } from './adapters/tmux/tmux-runner.ts';
import { tmuxAvailabilityDoctor } from './adapters/tmux/tmux-availability-check.ts';
import { RealHarnessLaunchGuard } from './adapters/tmux/harness-launch-guard.ts';
import { boundedSpawn } from './adapters/tmux/bounded.ts';
import { IDENTITY_SCRUB_TIMEOUT_MS, forgetFerretIdentity } from './adapters/tmux/forget-ferret-identity.ts';
import {
  releaseReader,
  tmuxReleaseDoctor,
  tmuxReleaseSelftest,
  tmuxSocketIn,
} from './adapters/tmux/tmux-release-checks.ts';
import { SurfaceControl } from './lib/agent-tools/control.ts';
import {
  type AgentToolResult,
  INPUT_SINGLE_FIELD_ID,
  type TerminalToolCall,
  TerminalToolService,
} from './lib/agent-tools/service.ts';
import type { AgentToolCaller } from './lib/agent-tools/types.ts';
import { parseBody } from './lib/api/body.ts';
import type { CodeProgramPort, ProgramProofPort } from './lib/inputs/ports.ts';
import { type ProgramRunner, SttyTerminalModes, type TerminalModes } from './lib/inputs/terminal-modes.ts';
import { TmuxInputTarget } from './lib/inputs/terminal-target.ts';
import type { SurfaceController } from './lib/protocol/surface-control.ts';
import {
  openerCredential,
  TerminalMountError,
  type TerminalSubsystem,
  terminalRouteHandlers,
  terminalStreamAccept,
} from './lib/runtime/mounts/terminals.ts';
import { decideTerminalOpener } from './lib/terminal/ownership.ts';
import type { TerminalRuntimePort } from './lib/terminal/contracts.ts';
import type { TmuxCommandPort } from './lib/tmux/contracts.ts';
import { TerminalsReferenceMenu } from './lib/reference-menu.ts';
import { snapshotRoute } from './lib/runtime/mounts/session-snapshot.ts';
import { buildProcesses, type ProcessHostReads, type RunnerPane } from './processes.ts';
import { processIncarnationFor } from './adapters/session/processes/process-incarnation.ts';

/** Today's idle timeout: a terminal nobody touched for an hour is closed. */
const TERMINAL_IDLE_TIMEOUT_MS = 60 * 60_000;
/** How often finished ferrets' terminals are swept (J-0088). */
const CLOSE_FINISHED_EVERY_MS = 5 * 60_000;
/** The CLI's binary name, as `packages/cli/package.json` declares it (the two-name model). */
const BINARY_NAME = 'fy';

type TerminalsManifest = typeof manifest;

/** Seams a test replaces; the daemon builds them from the kernel's ports. */
export interface TerminalsOverrides {
  /** The tmux server's command port (the daemon: control mode over `tmux -S <state>/tmux.sock`). */
  readonly tmux?: TmuxCommandPort;
  /** That server's socket, absolute. */
  readonly socketPath?: string;
  /** The terminals' runtime (the daemon: `TmuxTerminalRuntime` over `tmux`). */
  readonly runtime?: TerminalRuntimePort;
  /** What the guarded write asks of the host (the daemon: tmux above, `ps`/`stty` via kernel.spawn, the kernel's proofs). */
  readonly inputs?: {
    readonly tmux?: TmuxCommandPort;
    readonly run?: ProgramRunner;
    readonly modes?: TerminalModes;
    readonly programs?: CodeProgramPort;
    readonly proofs?: ProgramProofPort;
  };
  /** The host reads behind the pane proof and the Warden's looks (the daemon: `/proc` or `ps`, per platform). */
  readonly processHost?: ProcessHostReads;
}

/**
 * Where tmux's socket lives: the manifest's opaque `tmux.sock`, in Terminals' own state folder ({@link tmuxSocketIn},
 * the one place its path is built). There is no kernel port that names a state file's path (an opaque file is tmux's,
 * not ours), so the folder is the `downloads` root's parent: the kernel keeps every internal root in the plugin's
 * state folder (`pluginStateFolder`, `<home>/state/terminals/downloads`), the same folder `fyd --check` hands the
 * selftest as `stateDir`. A declared gap.
 */
export function stateSocketPath(kernel: Pick<KernelPorts, 'roots'>): string {
  const resolved = kernel.roots.root('downloads').resolve('.');
  if (!resolved.ok) throw new Error('terminals: the state folder could not be located for the tmux socket');
  const downloads = resolved.value.replace(/\/\.?$/u, '');
  return tmuxSocketIn(downloads.slice(0, downloads.lastIndexOf('/')));
}

/** The kernel's long-lived child, as a control client's transport. */
function controlChild(kernel: KernelPorts, argv: readonly string[]): ControlChild {
  const [, ...args] = argv;
  const child = kernel.spawn.start(TMUX_PROGRAM, args);
  return {
    stdin: { write: text => child.write(text), flush: () => undefined },
    stdout: child.stdout as unknown as AsyncIterable<Uint8Array>,
    exited: child.exited,
    kill: signal => child.kill(signal),
  };
}

const hex12 = (): string => crypto.randomUUID().replaceAll('-', '').slice(0, 12);

function terminalsConfig(kernel: KernelPorts): TerminalsConfig {
  const [def] = manifest.data.config;
  const file = def === undefined ? undefined : (kernel.config.file(def as never) as TerminalsConfig | undefined);
  return file ?? { perFerret: TERMINAL_MAX_PER_SESSION, global: TERMINAL_MAX_GLOBAL };
}

/**
 * The configured terminal environment as it is NOW (no cached copy). The kernel keeps the LAST GOOD file in effect when a
 * later one is invalid, so that environment stays; only a file never accepted (or one that cannot be read) gives none,
 * and terminals still open, with no extra environment.
 */
function liveTerminalEnvironment(kernel: KernelPorts): Readonly<Record<string, string>> {
  try {
    return terminalsConfig(kernel).environment ?? {};
  } catch {
    return {};
  }
}

/** Who took a terminal over, from Gate's standing: a paired device by its holder, else somebody at this machine. */
function controllerOf(call: CallContext): SurfaceController {
  const credential = call.credential;
  return credential?.tokenClass === 'device' ? { by: 'human', deviceId: credential.principal.holder } : { by: 'local' };
}

function pathFerret(call: CallContext): FerretId {
  const decoded = decodeParameter(call.params.get('ferretId') ?? '');
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the ferretId in the path is not usable', 'invalid_session_id');
  return decoded as FerretId;
}

/** A tool's answer as lines: what happened, what is open, then whatever it read (today's `renderToolResult`). */
export function renderToolResult(result: AgentToolResult): string {
  const lines = [result.summary];
  for (const surface of result.surfaces ?? []) lines.push(`  ${surface.name ?? surface.id}  ${surface.title}`);
  if (result.output !== undefined && result.output !== '') lines.push(result.output);
  return lines.join('\n');
}

/** `terminal_request_input`'s input: today's single-value terminal card (`push` approvals are not served yet). */
const TerminalRequestInputSchema = z.strictObject({
  name: z.string().min(1).max(80),
  prompt: z.string().trim().min(1).max(280),
  sensitivity: z.enum(['secret', 'private', 'code', 'plain']),
  label: z.string().min(1).max(64).optional(),
  submit: z.enum(['offer-owner', 'auto', 'never']).optional(),
  expiresInSeconds: z.number().int().optional(),
  blocking: z.boolean().optional(),
  chain: z.string().optional(),
  secretHint: z.string().optional(),
  push: z.literal(false).optional(),
});

/** Each tool's call, parsed by the schema the manifest declares for it. */
function parseToolCall(tool: string, input: unknown): TerminalToolCall | string {
  const parsed = (schema: z.ZodType, build: (value: never) => TerminalToolCall): TerminalToolCall | string => {
    const result = schema.safeParse(input ?? {});
    if (!result.success) {
      const [issue] = result.error.issues;
      return issue === undefined
        ? 'the call is not valid'
        : `${issue.path.length === 0 ? '' : `${issue.path.join('.')}: `}${issue.message}`;
    }
    return build(result.data as never);
  };
  switch (tool) {
    case 'terminal_list':
      return parsed(TerminalListInputSchema, () => ({ tool: 'terminal.list' }));
    case 'terminal_open':
      return parsed(
        TerminalOpenInputSchema,
        (value: object) => ({ tool: 'terminal.open', ...value }) as TerminalToolCall,
      );
    case 'terminal_send':
      return parsed(
        TerminalSendInputSchema,
        (value: object) => ({ tool: 'terminal.send', ...value }) as TerminalToolCall,
      );
    case 'terminal_read':
      return parsed(
        TerminalReadInputSchema,
        (value: object) => ({ tool: 'terminal.read', ...value }) as TerminalToolCall,
      );
    case 'terminal_wait':
      return parsed(
        TerminalWaitInputSchema,
        (value: object) => ({ tool: 'terminal.wait', ...value }) as TerminalToolCall,
      );
    case 'terminal_close':
      return parsed(
        TerminalCloseInputSchema,
        (value: object) => ({ tool: 'terminal.close', ...value }) as TerminalToolCall,
      );
    case 'terminal_ask_owner':
      return parsed(
        TerminalAskOwnerInputSchema,
        (value: object) => ({ tool: 'terminal.ask_owner', ...value }) as TerminalToolCall,
      );
    case 'terminal_request_input':
      return parsed(TerminalRequestInputSchema, (value: z.infer<typeof TerminalRequestInputSchema>) => {
        const { name, label, push: _push, ...rest } = value;
        const raise = {
          ...rest,
          ...(label === undefined
            ? { sensitivity: rest.sensitivity }
            : {
                sensitivity: undefined,
                fields: [{ id: INPUT_SINGLE_FIELD_ID, label, sensitivity: rest.sensitivity }],
              }),
        };
        return { tool: 'terminal.request_input', name, raise } as unknown as TerminalToolCall;
      });
    default:
      return `${tool} is not a terminal tool`;
  }
}

export function buildTerminals(ctx: DaemonContext<TerminalsManifest>, overrides: TerminalsOverrides = {}) {
  const { kernel } = ctx;
  const ferrets: FerretsApi = ctx.needs.ferrets;
  const log = kernel.log.child('terminals');
  const nowMs = (): number => kernel.clock.nowMs();

  // ─── the tmux server ────────────────────────────────────────────────────────────────────────────────────────────
  const socketPath = overrides.socketPath ?? stateSocketPath(kernel);
  const tmux: TmuxCommandPort =
    overrides.tmux ??
    (() => {
      const spawned = new KernelTmuxProcess(kernel.spawn, socketPath);
      const control = new ControlModeTmuxProcess(TMUX_PROGRAM, socketPath, spawned, {
        nowMs,
        after: (ms, fn) => kernel.clock.after(milliseconds(ms), fn),
        spawn: argv => controlChild(kernel, argv),
      });
      kernel.lifecycle.onStop(() => control.close());
      return control;
    })();

  const [, stateFile] = manifest.data.state;
  const terminalsState: TerminalsStateFile = stateFile;
  const panes = new StateTerminalPanes(kernel.state, terminalsState);
  const effectiveLimits = ferrets.effectiveLimits?.bind(ferrets);
  const processes = buildProcesses({
    kernel,
    tmux,
    socketPath,
    ferrets,
    ...(effectiveLimits === undefined ? {} : { limits: effectiveLimits }),
    paneOf: async ferret => await panes.of(ferret),
    ...(overrides.processHost === undefined ? {} : { host: overrides.processHost }),
    refusedOutputRoots: [socketPath.slice(0, socketPath.lastIndexOf('/state/'))],
    binaryName: BINARY_NAME,
  });

  // ─── terminals ──────────────────────────────────────────────────────────────────────────────────────────────────
  const loginShell = systemLoginShell(
    async () => undefined,
    kernel.spawn,
    message => log.warn(message),
  );
  const config = terminalsConfig(kernel);
  const runtime: TerminalRuntimePort =
    overrides.runtime ??
    new TmuxTerminalRuntime(tmux, nowMs, loginShell, processes.limits, () => liveTerminalEnvironment(kernel));
  const service = new ManagedTerminalService(
    runtime,
    {
      resolve: async reference => {
        const ferret = await ferrets.get(reference as FerretId).catch(() => undefined);
        return ferret === undefined ? undefined : { id: ferret.id, cwd: ferret.folder };
      },
    },
    { now: nowMs },
    { next: hex12 },
    {
      maximumPerSession: config.perFerret,
      maximumGlobal: config.global,
      idleTimeoutMs: TERMINAL_IDLE_TIMEOUT_MS,
      isDirectory: async path => {
        try {
          return (await stat(path)).isDirectory();
        } catch {
          return false;
        }
      },
      owners: new FerretTerminalOwnerDirectory(ferrets),
      // Today's `terminal.closed` audit record has no audit port in 5.0 yet: the daemon log says it (counts only).
      onClosed: async (holder, trigger) =>
        log.info('terminals closed', { ferret: holder.sessionId, count: holder.count, status: holder.status, trigger }),
    },
  );
  const translate = (error: unknown): never => {
    if (error instanceof TerminalServiceError) throw new TerminalMountError(error.code, error.message);
    if (error instanceof TerminalRuntimeError) throw new TerminalMountError('upstream_failed', error.message);
    throw error;
  };

  // ─── holds: what an act is keyed by, and the generation each terminal's holds are at ────────────────────────────
  /**
   * An act on a terminal is keyed by its tmux pane id — what the Vault sees in a card's facts (`paneProof.paneId`) —
   * and by the terminal id only where tmux named no pane. Looked up before every act, so a key is never stale.
   */
  const paneKeys = new Map<string, string>();
  const keyOf = async (terminalId: string): Promise<string> => {
    const record = (await runtime.list().catch(() => [])).find(entry => entry.id === terminalId);
    const key = record?.paneId ?? terminalId;
    paneKeys.set(terminalId, key);
    return key;
  };
  const generations = new Map<string, number>();
  const generation = (_ferret: string, terminalId: string): number =>
    generations.get(paneKeys.get(terminalId) ?? terminalId) ?? 0;
  const terminalTarget = async (terminalId: string) => targetRef('terminal', await keyOf(terminalId));
  const streamAct: StreamAct = async (_ferret, terminalId, read, capture) => {
    let shown: ReturnType<typeof read> | undefined;
    const answer = await kernel.act(await terminalTarget(terminalId), 'stream', async () => {
      await capture();
      shown = await kernel.redaction.read(scope => read(scope));
      return { kind: 'content' };
    });
    return answer.ok && shown !== undefined ? { shown } : { held: true };
  };
  const scheduler: TerminalStreamScheduler = {
    schedule: (callback, ms) => ({ cancel: kernel.clock.after(milliseconds(ms), callback) }),
  };
  /** A viewer's keystrokes are an act too: a hold that refuses the viewer's keys drops them, never half-types them. */
  const viewerService = {
    write: async (ferret: string, terminalId: string, bytes: Uint8Array): Promise<void> => {
      await kernel.act(await terminalTarget(terminalId), 'keys', async () => {
        await service.write(ferret, terminalId, bytes);
        return { status: 'done' };
      });
    },
    resize: async (ferret: string, terminalId: string, cols: number, rows: number) =>
      await service.resize(ferret, terminalId, cols, rows),
    capture: async (ferret: string, terminalId: string, historyLines: number) =>
      await service.capture(ferret, terminalId, historyLines),
  };

  const subsystem: TerminalSubsystem = {
    holders: async () => await service.holders().catch(translate),
    closeFinished: async trigger => await service.closeFinished(trigger).catch(translate),
    list: async ferret => await service.list(ferret).catch(translate),
    create: async (ferret, input, openedBy) =>
      await service
        .create(ferret, {
          title: input.title,
          cols: input.cols,
          rows: input.rows,
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.folder === undefined ? {} : { folder: input.folder }),
          ...(openedBy === undefined ? {} : { openedBy }),
        })
        .catch(translate),
    get: async (ferret, terminalId) => await service.get(ferret, terminalId).catch(translate),
    rename: async (ferret, terminalId, title) => await service.rename(ferret, terminalId, title).catch(translate),
    close: async (ferret, terminalId) => await service.close(ferret, terminalId).catch(translate),
    write: async (ferret, terminalId, bytes) => await service.write(ferret, terminalId, bytes).catch(translate),
    text: async (ferret, terminalId, lines) => await service.text(ferret, terminalId, lines).catch(translate),
    foreground: async (ferret, terminalId) => await service.foreground(ferret, terminalId).catch(translate),
    stream: async (ferret, terminalId, downstream) =>
      new TerminalStreamBridge(
        new RedactingTerminalStreamService(viewerService, streamAct, generation),
        ferret,
        terminalId,
        downstream,
        scheduler,
      ),
  };

  // ─── the terminal tools ─────────────────────────────────────────────────────────────────────────────────────────
  const control = new SurfaceControl(new StateSurfaceEvents(kernel.state, terminalsState), { now: nowMs });
  const tools = new TerminalToolService({
    terminals: subsystem,
    control,
    act: async (terminalId, op, fn) => await kernel.act(await terminalTarget(terminalId), op, async () => await fn()),
    read: async fn => await kernel.redaction.read(fn),
    clock: { now: nowMs },
    sleep: async ms => await kernel.clock.sleep(milliseconds(ms)),
    raiseInput: async (ferret, raise) => {
      const vault = ctx.needs.vault;
      return await vault.raiseInput(ferret as FerretId, raise);
    },
  });

  const callerOf = async (call: CallContext): Promise<AgentToolCaller | undefined> => {
    const ferret = ferretOf(call);
    if (ferret === undefined) return undefined;
    const name = (await ferrets.get(ferret).catch(() => undefined))?.name;
    return { kind: 'agent', sessionId: ferret, ...(name === undefined ? {} : { name }) };
  };
  /**
   * "What agents may control › Terminals", asked of core's `AgentControlPort` for the calling ferret on every terminal tool
   * (today's `switchOf`: every `terminal.*` tool). Fails closed: unbound (Ferrets not serving), a lookup or reader that
   * throws, or any answer but a plain `true` refuses. A person's route is not asked, as today.
   */
  const terminalsOn = async (ferret: FerretId): Promise<boolean> => {
    try {
      const reader = ctx.uses.agentControl.current();
      return reader !== undefined && (await reader.allows(ferret, 'terminal')) === true;
    } catch {
      return false;
    }
  };
  const tool =
    (name: string) =>
    async (call: CallContext, input: unknown): Promise<ToolResult> => {
      const caller = await callerOf(call);
      if (caller === undefined)
        return { text: "Terminal tools are a ferret's: no ferret made this call.", isError: true };
      // Today's `forbidden` and `controlRefusal('terminal')` (rebuild-ref agent-tools/service.ts:436-437, policy.ts:96-101).
      if (!(await terminalsOn(caller.sessionId as FerretId)))
        return { text: agentControlRefusal('terminal'), isError: true };
      const parsed = parseToolCall(name, input);
      if (typeof parsed === 'string') return { text: parsed, isError: true };
      try {
        const result = await tools.call(caller, parsed);
        return { text: renderToolResult(result), data: JSON.parse(JSON.stringify(result)) };
      } catch (error) {
        if (error instanceof Error && error.name === 'AgentToolError') return { text: error.message, isError: true };
        throw error;
      }
    };

  // ─── the guarded write (`input.targets:terminal`) ───────────────────────────────────────────────────────────────
  const run = overrides.inputs?.run ?? programRunner(kernel.spawn);
  const located = async (ferret: string, key: string) => {
    // A ferret this daemon does not hold has no terminal to type into: that is `target_gone`, never a throw.
    const { terminals } = await service.list(ferret).catch(() => ({ terminals: [] as const }));
    return terminals.find(terminal => terminal.name === key || terminal.id === key);
  };
  const target = new TmuxInputTarget(
    overrides.inputs?.tmux ?? tmux,
    {
      locate: async (ferret, key) =>
        (await runtime.list()).find(record => record.ownerId === ferret && (record.name === key || record.id === key)),
    },
    overrides.inputs?.modes ?? new SttyTerminalModes(hostPlatform, run),
    run,
    // An echo-off code prompt stays a code only from a code program this account cannot replace (never the ps name).
    overrides.inputs?.programs ?? ExecutableCodePrograms.forPlatform(hostPlatform, hostUserId),
    // Who can read the TTY, proved by the kernel for EVERY process of the foreground group, never by the name ps shows.
    overrides.inputs?.proofs ?? KernelProgramProof.forPlatform(hostPlatform, run, hostUserId, kernel.paths.home()),
  );
  const inputTarget: InputTargetAdapter = {
    masking: 'cells',
    observe: async (ferret, at: InputTarget, _fields: readonly InputTargetField[]) => await target.observe(ferret, at),
    type: async (
      ferret,
      at: InputTarget,
      values: readonly InputFieldValue[],
      submit: boolean,
      expected: InputTargetFacts,
      options?: TypeOptions,
    ) => {
      // One prompt, so one value (today's router rule); anything else is not a terminal's to type.
      const [value] = values;
      if (value === undefined || values.length !== 1) return 'target_gone';
      const terminal = await located(ferret, at.key);
      if (terminal === undefined) return 'target_gone';
      let typed: Awaited<ReturnType<typeof target.type>> = 'target_gone';
      const acted = await kernel.act(await terminalTarget(terminal.id), 'keys', async () => {
        typed = await target.type(ferret, at, value.text, submit, expected, options);
        return { status: 'done' };
      });
      return acted.ok ? typed : 'target_gone';
    },
  };

  // ─── the runner ─────────────────────────────────────────────────────────────────────────────────────────────────
  const incarnation = processIncarnationFor(hostPlatform, kernel.spawn);
  /**
   * The pane each ferret runs in, as the runner started or adopted it, registered in `terminals.json` as today's durable
   * pane registration was (Ferrets persists the handle; this keeps the incarnation the proofs need after a restart).
   */
  const remember = async (ferret: string, paneId: string, pid: number | undefined): Promise<void> => {
    if (pid === undefined) return;
    const start = await incarnation.startOf(pid).catch(() => undefined);
    if (start === undefined) return;
    const pane: RunnerPane = { tmuxSession: ferretTmuxSession(ferret), paneId, pid, processStartTicks: start };
    await panes.register(ferret, pane);
  };
  // The kernel decides once whether this daemon is a test's (its test-mode variable, or a scratch home); Terminals never
  // reads the environment. Armed, no launch may reach the owner's real Claude Code or Codex, found on the daemon's PATH
  // as the kernel states it at each launch; a refusal is logged here and answered `real_harness`.
  const launchGuard = kernel.hostFacts.launchGuard().active
    ? new RealHarnessLaunchGuard(() => kernel.hostFacts.launchGuard().searchPath)
    : undefined;
  const runner = new TmuxRunner({
    tmux,
    ...(launchGuard === undefined ? {} : { launchGuard }),
    log,
    spawn: kernel.spawn,
    socketPath,
    instantOf: seconds => instantFromEpochMs(seconds * 1_000),
    now: () => kernel.clock.now(),
    wrap: async (ferret, command) => await processes.limits.command(ferret, command),
    remember: async (ferret, running) => await remember(ferret, running.handle, running.pid),
    delivery: {
      act: kernel.act.bind(kernel),
      sleep: async ms => await kernel.clock.sleep(milliseconds(ms)),
    },
    // Ferrets' turn watch (U4): every look an act on the pane, its screen masked before it is parsed; only a digest of
    // the masked frame is handed back as the frame's identity.
    look: {
      act: kernel.act.bind(kernel),
      redaction: kernel.redaction,
      digest: text => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16),
    },
  });

  // ─── jobs ───────────────────────────────────────────────────────────────────────────────────────────────────────
  kernel.jobs.add({
    id: 'terminals-close-finished',
    schedule: { every: milliseconds(CLOSE_FINISHED_EVERY_MS) },
    run: async () => {
      await service.closeFinished('sweep');
    },
  });

  // ─── the tmux release ─────────────────────────────────────────────────────────────────────────────────────────────
  // Read-only questions on a one-shot client: `tmux -V` and `display-message` on this daemon's own socket, asked fresh
  // for each doctor report as today's doctor did, each child killed at its bound. Neither starts a server.
  const releaseAfter = (ms: number, fn: () => void): (() => void) => kernel.clock.after(milliseconds(ms), fn);
  const reader = releaseReader(kernel.spawn, socketPath, releaseAfter);

  const provided: TerminalsApi = {
    of: async ferret => (await service.list(ferret).catch(() => ({ terminals: [] }))).terminals,
    holders: async () => await service.holders(),
    // The Warden's looks at a ferret's own pane: read only, through the attach proof (`lib/session/pane-look.ts`).
    liveness: async ferret => await processes.look.liveness(ferret).catch(() => ({})),
    paneBrowsers: async ferret => await processes.look.browsers(ferret),
    // Re-proved fresh just before Browsers signals one: anything it cannot prove is not that browser.
    paneBrowserStill: async (ferret, browser) =>
      await processes.look.still(ferret, browser).catch(() => ({ still: false as const, why: 'not-proved' as const })),
  };

  const routes = terminalRouteHandlers(subsystem);
  return {
    routes: {
      ...routes,
      ...processes.routes,
      // The ferret's pane as text, redacted inside one read of the pane's target (a hold refuses it).
      'GET /v1/ferrets/:ferretId/snapshot': async (call: CallContext) =>
        await snapshotRoute(call, ferrets, {
          capture: async (ferret, extent) => {
            const pane = await panes.of(ferret as FerretId);
            if (pane === undefined) return undefined;
            const answer = await kernel.act(targetRef('terminal', pane.paneId), 'read', async () => {
              const args = extent === 'screen' ? ['capture-pane', '-p'] : ['capture-pane', '-p', '-S', '-'];
              const captured = await tmux.execute([...args, '-t', pane.paneId]);
              if (captured.code !== 0) throw new Error(captured.stderr.trim() || `tmux exited ${captured.code}`);
              return await kernel.redaction.read(scope => ({
                kind: 'content' as const,
                text: scope.text(captured.stdout),
              }));
            });
            if (!answer.ok) throw new ApiError(423, 'the pane is held; it cannot be read now', 'held');
            return answer.value.text;
          },
        }),
      'GET /v1/ferrets/:ferretId/surfaces/terminals/control': async (call: CallContext) =>
        jsonResponse(await tools.controlView(pathFerret(call))),
      'POST /v1/ferrets/:ferretId/surfaces/terminals/control': async (call: CallContext) => {
        const request = await parseBody(call.request, SurfaceControlRequestSchema);
        return jsonResponse(await tools.control(pathFerret(call), request, controllerOf(call)));
      },
      'POST /v1/ferrets/:ferretId/surfaces/terminals/tools': async (call: CallContext) => {
        const ferret = pathFerret(call);
        const body = await parseBody(call.request, z.looseObject({ tool: z.string().min(1).max(64) }));
        const { tool: named, ...input } = body;
        const parsed = parseToolCall(named.replace('.', '_'), input);
        if (typeof parsed === 'string') throw new ApiError(400, parsed, 'invalid_request');
        const decision = decideTerminalOpener(openerCredential(call), undefined);
        const caller: AgentToolCaller = {
          kind: 'person',
          sessionId: ferret,
          ...(decision.outcome === 'attributed' ? { openedBy: decision.openedBy } : {}),
        };
        // The same answer a ferret's MCP call gets: the rendered text, and the report as `data` (`matched` included).
        const result = await tools.call(caller, parsed);
        return jsonResponse({ text: renderToolResult(result), data: JSON.parse(JSON.stringify(result)) });
      },
    },
    sockets: { 'GET /v1/ferrets/:ferretId/terminals/:terminalId/stream': terminalStreamAccept(subsystem) },
    tools: {
      terminal_list: tool('terminal_list'),
      terminal_open: tool('terminal_open'),
      terminal_send: tool('terminal_send'),
      terminal_read: tool('terminal_read'),
      terminal_wait: tool('terminal_wait'),
      terminal_close: tool('terminal_close'),
      terminal_ask_owner: tool('terminal_ask_owner'),
      terminal_request_input: tool('terminal_request_input'),
    },
    provides: { terminals: provided },
    // At boot, before listeners: a tmux server an earlier daemon started inside a ferret's pane may still hold that
    // ferret's identity. Best effort — a failure is never a boot failure, and no value is read or logged. Each client is
    // killed at its bound, and a server that does not answer one is asked nothing more (one line says so).
    beforeListen: async () => {
      try {
        const cleared = await forgetFerretIdentity(
          new KernelTmuxProcess(boundedSpawn(kernel.spawn, IDENTITY_SCRUB_TIMEOUT_MS), socketPath),
          {
            after: releaseAfter,
            timeoutMs: IDENTITY_SCRUB_TIMEOUT_MS,
            stalled: () =>
              log.warn('the tmux server did not answer the identity scrub in time; its client was stopped', {
                timeoutMs: IDENTITY_SCRUB_TIMEOUT_MS,
              }),
          },
        );
        if (cleared.length > 0) log.info('cleared ferret identity from the tmux server', { count: cleared.length });
      } catch {
        log.warn('the tmux server identity scrub did not run');
      }
    },
    doctor: {
      // Required, as today: no tmux, no sessions. Resolved by the name every launch uses; nothing is run to find out.
      tmux: tmuxAvailabilityDoctor(async name => await kernel.paths.which(name)),
      'tmux-release': tmuxReleaseDoctor(async () => await reader.read()),
    },
    hooks: {
      'input.targets:terminal': inputTarget,
      'runners:tmux': runner,
      // The composer's `%terminal` menu (reference.catalog): the ferret's terminals. Asked only while Conversation is on.
      'reference.catalog:%terminal': new TerminalsReferenceMenu(provided),
    },
    subscribers: {
      'vault.holds-changed': (payload: {
        readonly target: { readonly kind: string; readonly key: string };
        readonly generation: number;
      }) => {
        if (payload.target.kind === 'terminal') generations.set(payload.target.key, payload.generation);
      },
    },
  };
}

export default implementDaemon(manifest, {
  build: ctx => buildTerminals(ctx),
  selftest: { 'tmux-release': tmuxReleaseSelftest },
});
