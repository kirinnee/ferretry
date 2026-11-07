/** Manual updates belong to the shell, so disabling Updates leaves this verb available (§2.2). */
import { DaemonUpdateViewSchema } from '@ferretry/plugin-updates/contract';
import { pluginClient } from '../client.ts';
import { EXIT } from '../errors.ts';
import type { ShellVerb } from '../shell-context.ts';

export const updateVerb: ShellVerb = async ctx => {
  if (ctx.world.update === undefined) {
    ctx.world.io.err('This fy has no local update adapters.\n');
    return EXIT.unavailable;
  }
  const flags = ctx.invocation.options;
  const text = (name: string): string | undefined => (typeof flags[name] === 'string' ? flags[name] : undefined);
  return await ctx.world.update(
    {
      check: flags.check === true,
      to: text('to'),
      yes: flags.yes === true,
      whenIdle: flags['when-idle'] === true,
      switchToProfile: flags['switch-to-profile'] === true,
      report: text('report'),
      json: flags.json === true,
    },
    {
      view: async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          // One budget for connecting, the inventory pre-read and the view, as in today's update client.
          const deadline = new Promise<undefined>(resolve => {
            timer = setTimeout(() => resolve(undefined), 3_000);
          });
          const read = async () =>
            DaemonUpdateViewSchema.parse(await pluginClient(await ctx.deps(), 'updates').call('GET /v1/daemon/update'));
          return await Promise.race([deadline, read()]);
        } catch {
          return undefined;
        } finally {
          clearTimeout(timer);
        }
      },
    },
  );
};
