/** Production composition copied from today's bin/program.ts: package managers, verified releases and lifecycle. */
import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { HealthSchema, HomeJsonSchema } from '@ferretry/kernel/contract';
import type { TerminalIo } from '@ferretry/kernel/manifest';
import { DAEMON_RELEASE_KEYS } from '@ferretry/plugin-updates/contract';
import { z } from 'zod';
import { resolveDaemonBinaryPath } from '../../lib/daemon/binary.ts';
import { resolveDaemonLayout } from '../../lib/daemon/layout.ts';
import type { IStateHomeClaimPort } from '../../lib/daemon/ports.ts';
import { DirectSupervisor, LaunchdSupervisor, SystemdSupervisor } from '../../lib/daemon/supervisor.ts';
import type { Environment } from '../../lib/credential.ts';
import { daemonConfigPath } from '../../lib/home.ts';
import { resolveDaemonUrl } from '../../lib/address.ts';
import { UpdateLifecycle } from '../../lib/update/lifecycle.ts';
import type { IDaemonUpdateViewPort } from '../../lib/update/ports.ts';
import { NixProfileSwitch } from '../../lib/update/profile-switch.ts';
import { PlainProgress } from '../../lib/update/progress.ts';
import type { DaemonUpdaterDeps } from '../../lib/update/updater.ts';
import { readDaemonConfigDocument } from '../daemon/config-file.ts';
import { FileDaemonLifecycleLock } from '../daemon/lifecycle-lock.ts';
import { NixStoreGcRoot } from '../daemon/nix-gc-root.ts';
import { BunDaemonProcess } from '../daemon/process.ts';
import { HostProcessIncarnations } from '../daemon/process-incarnation.ts';
import { privateRuntimeDirectory } from '../daemon/runtime-directory.ts';
import { FileServiceStore } from '../daemon/service-files.ts';
import { HostInstallFacts } from './install-facts.ts';
import { GitHubLatestRelease } from './latest-release.ts';
import { CommandPackageManagers } from './package-managers.ts';
import { StandaloneRelease } from './standalone-release.ts';

export interface UpdateMachineInputs {
  readonly environment: Environment;
  readonly userHome: string;
  readonly home: string;
  readonly product: string;
  readonly clientName: string;
  readonly daemonName: string;
  readonly binaries: readonly string[];
  readonly io: TerminalIo;
  readonly selfPath: string;
}

export function executable(path: string): boolean {
  try {
    const state = statSync(path);
    return state.isFile() && (state.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** Bounded exactly as today's composition: a hung wrapper cannot hang an invocation forever. */
export function versionOf(path: string): string | undefined {
  const result = Bun.spawnSync([path, '--version'], { stdout: 'pipe', stderr: 'ignore', timeout: 5_000 });
  if (result.exitCode !== 0) return undefined;
  return new TextDecoder().decode(result.stdout).trim() || undefined;
}

export function buildUpdateMachine(
  inputs: UpdateMachineInputs,
  updateView: IDaemonUpdateViewPort,
): {
  readonly deps: DaemonUpdaterDeps;
  exitCode(): number;
} {
  const { environment, io, product, clientName, daemonName, userHome } = inputs;
  let code = 0;
  const out = {
    success: (line: string) => io.out(`${line}\n`),
    warn: (line: string) => io.err(`${line}\n`),
    error: (line: string) => io.err(`${line}\n`),
    setExitCode: (value: number) => {
      code = value;
    },
  };
  const prompt = {
    ask: async (question: string): Promise<string> => {
      const terminal = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await terminal.question(`${question} `);
      } finally {
        terminal.close();
      }
    },
  };
  const clock = { now: () => Date.now(), sleep: (ms: number) => Bun.sleep(ms) };
  const processes = new BunDaemonProcess();
  const files = new FileServiceStore();
  const uid = process.getuid?.() ?? 0;
  const layout = resolveDaemonLayout({
    platform: process.platform,
    homeDirectory: userHome,
    stateHome: inputs.home,
    configHome: environment.XDG_CONFIG_HOME,
    stateDirectory: environment.XDG_STATE_HOME,
    runtimeDirectory: privateRuntimeDirectory(environment.XDG_RUNTIME_DIR, uid),
    userId: uid,
    daemonName,
    product,
    searchPath: environment.PATH ?? '',
    locale: environment,
  });
  // Updates only restart an existing format-1 home; the kernel creates new homes itself.
  const claims: IStateHomeClaimPort = {
    async claim(home) {
      HomeJsonSchema.parse(JSON.parse(await readFile(join(home, 'home.json'), 'utf8')));
    },
    async inspect(home) {
      try {
        return HomeJsonSchema.safeParse(JSON.parse(await readFile(join(home, 'home.json'), 'utf8'))).success
          ? 'claimed'
          : 'unclaimed';
      } catch {
        return 'unclaimed';
      }
    },
  };
  const service =
    layout.manager === 'systemd'
      ? new SystemdSupervisor(layout, processes, files, claims)
      : layout.manager === 'launchd'
        ? new LaunchdSupervisor(layout, processes, files, claims)
        : undefined;
  const lifecycle = new UpdateLifecycle({
    layout,
    service,
    direct: new DirectSupervisor(layout, processes, files, claims),
    locks: new FileDaemonLifecycleLock(processes, new HostProcessIncarnations(processes), clock),
    nix: new NixStoreGcRoot(processes),
    clock,
    out,
    installed: () => {
      const beside = join(dirname(inputs.selfPath), daemonName);
      const found = executable(beside)
        ? beside
        : (Bun.which(daemonName, { PATH: environment.PATH ?? '' }) ?? undefined);
      const binary = resolveDaemonBinaryPath({ daemonName, pinned: environment.FY_DAEMON_BIN, found, executable });
      return { ...binary, version: versionOf(binary.path) };
    },
    versionOf,
    executable,
    health: async () => {
      try {
        // Always this home's own listener. FY_URL may name a forwarded or remote daemon.
        const url = resolveDaemonUrl('', await readDaemonConfigDocument(daemonConfigPath(inputs.home)));
        const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(3_000) });
        if (!response.ok) return undefined;
        return HealthSchema.extend({ pid: z.number().int().min(2) })
          .strip()
          .parse(await response.json());
      } catch {
        return undefined;
      }
    },
  });
  const facts = new HostInstallFacts({ product, homeDirectory: userHome, platform: process.platform });
  const packages = new CommandPackageManagers((argv, onLine) => processes.runStreaming(argv, onLine));
  return {
    deps: {
      facts,
      latest: new GitHubLatestRelease(product),
      packages,
      standalone: new StandaloneRelease({
        product,
        clientName,
        platform: process.platform,
        arch: process.arch,
        binaries: inputs.binaries,
        keys: DAEMON_RELEASE_KEYS,
        run: argv => processes.run(argv),
      }),
      lifecycle,
      updateView,
      switcher: new NixProfileSwitch({
        facts,
        packages,
        lifecycle,
        out,
        prompt,
        interactive: () => io.isTty,
        product,
        clientName,
        daemonName,
        homeDirectory: userHome,
      }),
      reports: {
        writePrivate: async (path, body) => {
          await files.ensureDirectory(dirname(path));
          await files.writePrivate(path, body);
        },
      },
      out,
      prompt,
      interactive: () => io.isTty,
      clock,
      product,
      clientName,
      daemonName,
      progress: new PlainProgress(line => io.err(`${line}\n`)),
    },
    exitCode: () => code,
  };
}
