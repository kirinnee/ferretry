/** `fy daemon status|start|stop|restart|install|uninstall|logs|which|reset` (§1.4). The daemon starts itself on the first other command (§9.1). */
import { DaemonUpdateViewSchema } from '@ferretry/plugin-updates/contract';
import type { Manifest, PluginClient } from '@ferretry/kernel/manifest';
import { optionOn } from '../argv.ts';
import type { DaemonController } from '../daemon/controller.ts';
import { ClientResetInventory } from '../daemon/reset-inventory.ts';
import { EXIT } from '../errors.ts';
import { judgePlugin } from '../guard.ts';
import type { ShellContext, ShellVerb } from '../shell-context.ts';

export const daemonStatus: ShellVerb = async ctx => {
  const { io, identity } = ctx.world;
  const probe = await ctx.world.probe();
  if (probe.state === 'down') {
    io.err(
      `daemon  not running at ${probe.baseUrl} (${probe.why})\nstart it with \`${identity.binary} daemon start\`\n`,
    );
    return EXIT.failure;
  }
  const lines = [
    `daemon   running at ${probe.baseUrl}`,
    `version  ${probe.health.version}`,
    `protocol ${String(probe.health.protocol)}`,
  ];
  try {
    const inventory = await (await ctx.deps()).inventory.current();
    const off = inventory.plugins.filter(held => !held.on).map(held => held.id);
    const apart = ctx.world.registry.plugins.filter(entry => {
      const verdict = judgePlugin(inventory, ctx.surfaces.compiled, entry.id);
      return !verdict.ok && verdict.reason !== 'off';
    });
    lines.push(
      `plugins  ${String(inventory.plugins.length)} plugins, ${String(off.length)} off${off.length > 0 ? ` (${off.join(', ')})` : ''}`,
      apart.length === 0
        ? `contract every plugin of this ${identity.binary} agrees with the daemon`
        : `contract ${apart.map(entry => entry.id).join(', ')} differ or are missing: restart the daemon with \`${identity.binary} daemon restart\``,
    );
  } catch (error) {
    lines.push(`plugins  not read: ${error instanceof Error ? error.message : String(error)}`);
  }
  io.out(`${lines.join('\n')}\n`);
  return EXIT.ok;
};

export const daemonStart: ShellVerb = async ctx => {
  const probe = await ctx.world.probe();
  if (probe.state === 'up') {
    ctx.world.io.out(`the daemon is already running at ${probe.baseUrl}\n`);
    return EXIT.ok;
  }
  const launched = await ctx.world.launch();
  if (!launched.started) {
    ctx.world.io.err(`${launched.why}\n`);
    return EXIT.failure;
  }
  ctx.world.io.out(`the daemon is running at ${launched.baseUrl}\n`);
  return EXIT.ok;
};

/**
 * The process-control verbs run one {@link DaemonController} method each. The two reads that need the daemon are
 * made through the guarded client, and only while the daemon answers: asking would otherwise start the daemon a
 * `stop` or `reset` has just been told to take down.
 */
const controlled =
  (run: (controller: DaemonController, ctx: ShellContext) => Promise<void>): ShellVerb =>
  async ctx => {
    const { world } = ctx;
    if (world.daemon === undefined) {
      world.io.err('This fy has no local daemon-control adapters.\n');
      return EXIT.unavailable;
    }
    const whileUp = async <T>(fallback: T, read: () => Promise<T>): Promise<T> => {
      if ((await world.probe()).state !== 'up') return fallback;
      try {
        return await read();
      } catch {
        return fallback;
      }
    };
    // EACH of the three counts is asked only while the daemon answers, like the mid-turn read: a daemon that died since
    // the controller's probe is not started by a read in the middle of a reset.
    const whileAnswering = (id: Manifest['id']): Pick<PluginClient, 'call'> => ({
      call: async (route, init) => {
        if ((await world.probe()).state !== 'up') throw new Error('the daemon stopped answering');
        return await ctx.client(id).call(route, init);
      },
    });
    const built = world.daemon({
      resetInventory: new ClientResetInventory(
        whileAnswering('vault'),
        whileAnswering('access'),
        whileAnswering('ferrets'),
      ),
      turns: {
        midTurn: () =>
          whileUp(
            0,
            async () => DaemonUpdateViewSchema.parse(await ctx.client('updates').call(MID_TURN_ROUTE)).midTurn,
          ),
      },
    });
    await run(built.controller, ctx);
    return built.exitCode();
  };

/** The Updates plugin's read of the daemon's own account of itself, which counts the ferrets mid-turn. */
const MID_TURN_ROUTE = 'GET /v1/daemon/update';

export const daemonStop: ShellVerb = controlled(async controller => controller.stop());

/** V-0237: `--when-idle` waits until no ferret is mid-turn; without it the restart goes ahead and ferrets keep running. */
export const daemonRestart: ShellVerb = controlled(async (controller, ctx) =>
  controller.restart(optionOn(ctx.invocation, 'when-idle') ? { whenIdle: true } : {}),
);

export const daemonInstall: ShellVerb = controlled(async controller => controller.install());
export const daemonUninstall: ShellVerb = controlled(async controller => controller.uninstall());
export const daemonWhich: ShellVerb = controlled(async (controller, ctx) =>
  controller.which({ json: optionOn(ctx.invocation, 'json') }),
);
export const daemonLogs: ShellVerb = controlled(async (controller, ctx) =>
  controller.logs({ follow: optionOn(ctx.invocation, 'follow') || optionOn(ctx.invocation, 'f') }),
);
export const daemonReset: ShellVerb = controlled(async (controller, ctx) =>
  controller.reset({ yes: optionOn(ctx.invocation, 'yes') || optionOn(ctx.invocation, 'y') }),
);
