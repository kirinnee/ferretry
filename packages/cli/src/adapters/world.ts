/** The production {@link CliWorld}: the real terminal, environment, disk and network, wired once. */
import { existsSync } from 'node:fs';
import type { TerminalIo } from '@ferretry/kernel/manifest';
import { isLocalDaemonUrl } from '../lib/address.ts';
import { AS_OWNER_NOTE, credentialPlan, type Environment, ownFerretId } from '../lib/credential.ts';
import { ShellError } from '../lib/errors.ts';
import { adminTokenPath, resolveHome } from '../lib/home.ts';
import type { CommandRegistry } from '../lib/registry.ts';
import type { CliWorld, Connection, Identity } from '../lib/world.ts';
import {
  daemonAddressing,
  inventoryCache,
  openFerretConnection,
  remoteRefusal,
  restartWaiting,
} from './daemon/ferret-connection.ts';
import { type Fetcher, HttpTransport } from './daemon/http-transport.ts';
import { DAEMON_BINARY, type LaunchPorts, launchDaemon } from './daemon/launcher.ts';
import { assertOwnLoopbackListener } from './daemon/listener-guard.ts';
import { probeHealth } from './daemon/probe.ts';
import { readAdminToken } from './daemon/token-file.ts';
import { createPluginHost } from './plugin-host.ts';
import { createStatuslinePorts } from './statusline/index.ts';
import { terminalPrompt } from './terminal/prompt.ts';
import { buildDaemonController } from './daemon/control.ts';
import { buildUpdateMachine } from './update/machine.ts';
import { DaemonUpdater } from '../lib/update/updater.ts';

export interface WorldInputs {
  readonly io: TerminalIo;
  readonly environment: Environment;
  readonly userHome: string;
  readonly identity: Identity;
  /** The product name: it names the default home `~/.<product>`. */
  readonly product: string;
  readonly registry: CommandRegistry;
  /** Where this program lives; the daemon binary is looked for beside it. */
  readonly selfPath: string;
  /** The process ports the daemon launcher uses. Production leaves this out; tests must pass fakes so no test starts a real daemon. */
  readonly process?: Partial<Pick<LaunchPorts, 'exists' | 'which' | 'spawnDetached'>>;
  /** The network. Production leaves this out (the global `fetch`); tests pass a fake so no test reaches a socket. */
  readonly fetcher?: Fetcher;
}

export function createWorld(inputs: WorldInputs): CliWorld {
  const { io, environment, identity, registry } = inputs;
  const home = resolveHome(inputs.userHome, environment.FY_HOME, inputs.product);
  const fetcher: Fetcher = inputs.fetcher ?? ((url, init) => fetch(url, init));
  /** The kernel's run record, read each time: a daemon that has just started decides its own port and records it. */
  const addressing = daemonAddressing(environment, home);
  const { pinned, baseUrl } = addressing;
  const probe = async () => probeHealth(await baseUrl(), fetcher);
  const launch = async () =>
    launchDaemon({
      selfPath: inputs.selfPath,
      exists: inputs.process?.exists ?? existsSync,
      which: inputs.process?.which ?? (name => Bun.which(name)),
      spawnDetached:
        inputs.process?.spawnDetached ??
        ((command, env) => {
          Bun.spawn([...command], { env: { ...env }, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }).unref();
        }),
      probe,
      sleep: milliseconds => Bun.sleep(milliseconds),
      nowMs: () => Date.now(),
      environment,
    });
  const restart = restartWaiting(io, identity.binary);
  const ferretId = ownFerretId(environment);
  const clientHeaders = {
    'x-ferretry-client': 'cli',
    ...(ferretId === undefined ? {} : { 'x-ferretry-session-id': ferretId }),
  };

  return {
    io,
    environment,
    identity,
    registry,
    probe,
    launch,
    prompt: terminalPrompt,
    statusline: createStatuslinePorts(home),
    readText: path => Bun.file(path).text(),
    host: createPluginHost({ home }),
    daemon: reads =>
      buildDaemonController(
        {
          environment,
          io,
          home,
          userHome: inputs.userHome,
          product: inputs.product,
          clientName: identity.binary,
          daemonName: DAEMON_BINARY,
          selfPath: inputs.selfPath,
          fetcher,
          launch,
        },
        reads,
      ),
    async update(options, updateView) {
      const machine = buildUpdateMachine(
        {
          environment,
          io,
          home,
          userHome: inputs.userHome,
          product: inputs.product,
          clientName: identity.binary,
          daemonName: DAEMON_BINARY,
          binaries: [identity.binary, DAEMON_BINARY],
          selfPath: inputs.selfPath,
        },
        updateView,
      );
      await new DaemonUpdater(machine.deps).update(options);
      return machine.exitCode();
    },
    async connect({ asOwner }): Promise<Connection> {
      const plan = credentialPlan(environment, { asOwner });
      if (plan.kind === 'admin' && plan.why === 'as-owner') io.err(`${identity.binary}: ${AS_OWNER_NOTE}\n`);
      // A ferret never starts a daemon: it exists because one ran. Its connection is the same one the slim `mcp serve` opens.
      if (plan.kind === 'ferret')
        return await openFerretConnection({ environment, addressing, restart, fetcher, bearer: plan.bearer });
      const address = await baseUrl();
      if (plan.kind !== 'explicit' && !isLocalDaemonUrl(address)) throw new ShellError(remoteRefusal(address));
      // The daemon starts itself on the first command of a person's shell.
      if (!pinned && isLocalDaemonUrl(address) && (await probe()).state === 'down') {
        const launched = await launch();
        if (!launched.started) throw new ShellError(launched.why);
      }
      const transport = new HttpTransport({
        baseUrl,
        headers: clientHeaders,
        fetcher,
        authorization: async () =>
          `Bearer ${plan.kind === 'explicit' ? plan.token : await readAdminToken(adminTokenPath(home))}`,
        ...(plan.kind === 'explicit'
          ? {}
          : {
              // The address is read again for every request, so it is judged again for every request, BEFORE the
              // token is read (S57): one checked at connect time says nothing about where the next request goes.
              beforeSend: async (base: string) => {
                if (!isLocalDaemonUrl(base)) throw new ShellError(remoteRefusal(base));
                await assertOwnLoopbackListener(base, 'the daemon admin token');
              },
            }),
      });
      const inventory = inventoryCache(transport, addressing.instance);
      return { baseUrl: address, transport, inventory };
    },
  };
}
