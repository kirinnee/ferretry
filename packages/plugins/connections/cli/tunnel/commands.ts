import type { PluginClient, TerminalIo, VerbHandler } from '@ferretry/kernel/manifest';
import { TunnelStatusViewSchema } from '../../contract/index.ts';
import { renderTunnelChange } from './render.ts';

/** The declared tunnel verbs, bound to the kernel's per-daemon client. */
export function buildTunnelVerbs(
  client: PluginClient,
  io: TerminalIo,
): Record<'tunnel status' | 'tunnel on' | 'tunnel off', VerbHandler> {
  const change =
    (enabled: boolean): VerbHandler =>
    async () => {
      const view = TunnelStatusViewSchema.parse(await client.call('PUT /v1/tunnel', { body: { enabled } }));
      io.out(renderTunnelChange(view));
      return 0;
    };
  return {
    'tunnel status': async ({ options }) => {
      const view = TunnelStatusViewSchema.parse(await client.call('GET /v1/tunnel'));
      io.out(options.json === true ? JSON.stringify(view) : view.sentence);
      return 0;
    },
    'tunnel on': change(true),
    'tunnel off': change(false),
  };
}
