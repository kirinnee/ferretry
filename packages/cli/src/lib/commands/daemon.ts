/** `fy daemon status|start|stop|restart` (§1.4). The daemon starts itself on the first other command (§9.1). */
import { skeletonSentence } from '@ferretry/kernel/contract';
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

/** Stopping needs the kernel host's stop route (or its lock file), which this build of the host does not serve yet. */
const unwired =
  (what: string) =>
  async (ctx: ShellContext): Promise<number> => {
    ctx.world.io.err(`${skeletonSentence(what)}\n`);
    return EXIT.unavailable;
  };

export const daemonStop: ShellVerb = unwired('Stopping the daemon from fy');
export const daemonRestart: ShellVerb = unwired('Restarting the daemon from fy');
