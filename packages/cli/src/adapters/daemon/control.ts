/**
 * The production {@link DaemonController}: the real service managers, process runner, lifecycle claims, Nix roots, log
 * reader and state-home trees, wired once. Mirrors the update machine's composition for the pieces both share; the
 * reads that need the daemon (what a reset destroys, who is mid-turn) are handed in by the verb, through the guarded
 * client, so this holds no credential and opens no connection.
 */
import { dirname, join } from 'node:path';
import type { TerminalIo } from '@ferretry/kernel/manifest';
import { parseDaemonRun, resolveDaemonUrl } from '../../lib/address.ts';
import { resolveDaemonBinaryPath } from '../../lib/daemon/binary.ts';
import { DaemonController, type DaemonControlReads } from '../../lib/daemon/controller.ts';
import { resolveDaemonLayout } from '../../lib/daemon/layout.ts';
import { DirectSupervisor, LaunchdSupervisor, SystemdSupervisor } from '../../lib/daemon/supervisor.ts';
import type { Environment } from '../../lib/credential.ts';
import { daemonRunPath } from '../../lib/home.ts';
import { PlainProgress } from '../../lib/update/progress.ts';
import { executable, versionOf } from '../update/machine.ts';
import { RunRecordDaemonHealth } from './health.ts';
import { FileDaemonLifecycleLock } from './lifecycle-lock.ts';
import { TailDaemonLog } from './log-stream.ts';
import { NixStoreGcRoot } from './nix-gc-root.ts';
import { BunDaemonProcess } from './process.ts';
import { HostProcessIncarnations } from './process-incarnation.ts';
import { FileResetTrees } from './reset-trees.ts';
import { privateRuntimeDirectory } from './runtime-directory.ts';
import { readDaemonRunDocument } from './run-file.ts';
import { FileServiceStore } from './service-files.ts';
import { TmuxSessionTerminalServer } from './session-terminals.ts';
import { terminalPrompt } from '../terminal/prompt.ts';
import { homeMarker } from './state-home-marker.ts';
import type { Fetcher } from './http-transport.ts';

export interface DaemonControlInputs {
  readonly environment: Environment;
  readonly io: TerminalIo;
  /** The state home `FY_HOME` resolved to. */
  readonly home: string;
  readonly userHome: string;
  readonly product: string;
  readonly clientName: string;
  readonly daemonName: string;
  readonly selfPath: string;
  readonly fetcher?: Fetcher | undefined;
}

export function buildDaemonController(
  inputs: DaemonControlInputs,
  reads: DaemonControlReads,
): { readonly controller: DaemonController; exitCode(): number } {
  const { environment, io, daemonName } = inputs;
  let code = 0;
  const out = {
    success: (line: string) => io.out(`${line}\n`),
    warn: (line: string) => io.err(`${line}\n`),
    error: (line: string) => io.err(`${line}\n`),
    setExitCode: (value: number) => {
      code = value;
    },
  };
  const clock = { now: () => Date.now(), sleep: (ms: number) => Bun.sleep(ms) };
  const processes = new BunDaemonProcess();
  const files = new FileServiceStore();
  const uid = process.getuid?.() ?? 0;
  const layout = resolveDaemonLayout({
    platform: process.platform,
    homeDirectory: inputs.userHome,
    stateHome: inputs.home,
    configHome: environment.XDG_CONFIG_HOME,
    stateDirectory: environment.XDG_STATE_HOME,
    runtimeDirectory: privateRuntimeDirectory(environment.XDG_RUNTIME_DIR, uid),
    userId: uid,
    daemonName,
    product: inputs.product,
    searchPath: environment.PATH ?? '',
    locale: environment,
  });
  // The kernel creates the home itself; the supervisors only need to know whether a marker is there.
  const claims = {
    ...homeMarker,
    claim: async (home: string) => {
      if ((await homeMarker.inspect(home)) !== 'claimed')
        throw new Error(`${home} is not a Ferretry home; the daemon creates it on its first start`);
    },
  };
  const service =
    layout.manager === 'systemd'
      ? new SystemdSupervisor(layout, processes, files, claims)
      : layout.manager === 'launchd'
        ? new LaunchdSupervisor(layout, processes, files, claims)
        : undefined;
  const controller = new DaemonController({
    layout,
    service,
    direct: new DirectSupervisor(layout, processes, files, claims),
    health: new RunRecordDaemonHealth(
      async () => resolveDaemonUrl('', parseDaemonRun(await readDaemonRunDocument(daemonRunPath(inputs.home)))),
      inputs.fetcher,
    ),
    logs: new TailDaemonLog(),
    nix: new NixStoreGcRoot(processes),
    lifecycle: new FileDaemonLifecycleLock(processes, new HostProcessIncarnations(processes), clock),
    installedDaemon: () => {
      const beside = join(dirname(inputs.selfPath), daemonName);
      const found = executable(beside)
        ? beside
        : (Bun.which(daemonName, { PATH: environment.PATH ?? '' }) ?? undefined);
      const binary = resolveDaemonBinaryPath({ daemonName, pinned: environment.FY_DAEMON_BIN, found, executable });
      return { ...binary, version: versionOf(binary.path) };
    },
    resetTrees: new FileResetTrees(),
    resetInventory: reads.resetInventory,
    sessionTerminals: new TmuxSessionTerminalServer(processes),
    claims,
    prompt: terminalPrompt,
    interactive: () => io.isTty,
    clientName: inputs.clientName,
    clock,
    out,
    turns: reads.turns,
    progress: new PlainProgress(line => io.err(`${line}\n`)),
  });
  return { controller, exitCode: () => code };
}
