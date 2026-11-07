/** The production {@link CliWorld}: the real terminal, environment, disk and network, wired once. */
import { existsSync } from 'node:fs';
import { PluginInventorySchema } from '@ferretry/kernel/contract';
import type { TerminalIo } from '@ferretry/kernel/manifest';
import { isLocalDaemonUrl, resolveDaemonUrl } from '../lib/address.ts';
import { InventoryCache } from '../lib/client.ts';
import { AS_OWNER_NOTE, credentialPlan, type Environment, ownFerretId } from '../lib/credential.ts';
import { DaemonRefusal, ShellError } from '../lib/errors.ts';
import { adminTokenPath, daemonConfigPath, resolveHome } from '../lib/home.ts';
import type { CommandRegistry } from '../lib/registry.ts';
import type { CliWorld, Connection, Identity } from '../lib/world.ts';
import { SessionCredentialGateway } from './agent-tools/session-credential-gateway.ts';
import { readDaemonConfigDocument } from './daemon/config-file.ts';
import { HttpTransport, type RestartWaiting } from './daemon/http-transport.ts';
import { DAEMON_BINARY, type LaunchPorts, launchDaemon } from './daemon/launcher.ts';
import { assertOwnLoopbackListener } from './daemon/listener-guard.ts';
import { probeHealth } from './daemon/probe.ts';
import { readAdminToken } from './daemon/token-file.ts';
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
}

export function createWorld(inputs: WorldInputs): CliWorld {
  const { io, environment, identity, registry } = inputs;
  const home = resolveHome(inputs.userHome, environment.FY_HOME, inputs.product);
  const pinned = (environment.FY_URL?.trim() ?? '') !== '';
  /** Read each time: a daemon that has just started decides its own port and records it. */
  const baseUrl = async (): Promise<string> =>
    resolveDaemonUrl(environment.FY_URL ?? '', await readDaemonConfigDocument(daemonConfigPath(home)));
  const probe = async () => probeHealth(await baseUrl());
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
  let told = false;
  const restart: RestartWaiting = {
    patience: {
      expected: () => true,
      waiting: () => {
        if (told) return;
        told = true;
        io.err(`${identity.binary}: daemon restarting, retrying for up to 60s…\n`);
      },
    },
    nowMs: () => Date.now(),
    sleep: milliseconds => Bun.sleep(milliseconds),
  };
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
      const address = await baseUrl();
      if (plan.kind !== 'explicit' && !isLocalDaemonUrl(address))
        throw new ShellError(
          `FY_TOKEN is required when the daemon is not on this machine (${address}); local daemon credentials are never sent remotely. Set FY_TOKEN to that daemon's own token.`,
        );
      // The daemon starts itself on the first command of a person's shell. A ferret never starts one: it exists because one ran.
      if (plan.kind !== 'ferret' && !pinned && isLocalDaemonUrl(address) && (await probe()).state === 'down') {
        const launched = await launch();
        if (!launched.started) throw new ShellError(launched.why);
      }
      const transport =
        plan.kind === 'ferret'
          ? new SessionCredentialGateway({
              baseUrl,
              bearer: plan.bearer,
              ...(ferretId === undefined ? {} : { ferretId }),
              restart,
            })
          : new HttpTransport({
              baseUrl,
              headers: clientHeaders,
              authorization: async () =>
                `Bearer ${plan.kind === 'explicit' ? plan.token : await readAdminToken(adminTokenPath(home))}`,
              ...(plan.kind === 'explicit'
                ? {}
                : { beforeSend: (base: string) => assertOwnLoopbackListener(base, 'the daemon admin token') }),
            });
      const inventory = new InventoryCache(async () => {
        const reply = await transport.send({ method: 'GET', path: '/v1/plugins' }, { repeatable: true });
        if (reply.status !== 200) {
          const said = (reply.body as { error?: unknown } | undefined)?.error;
          throw new DaemonRefusal(
            typeof said === 'string' ? said : `the daemon answered HTTP ${String(reply.status)} to the plugin list`,
            reply.status,
          );
        }
        const parsed = PluginInventorySchema.safeParse(reply.body);
        if (!parsed.success)
          throw new ShellError('the daemon’s plugin list was not in a shape this fy reads; update fy or the daemon');
        return parsed.data;
      });
      return { baseUrl: address, transport, inventory };
    },
  };
}
