import type { PluginClient, TerminalIo, VerbHandler } from '@ferretry/kernel/manifest';
import { TunnelStatusViewSchema } from '../../contract/index.ts';
import { renderTunnelChange } from './render.ts';

/** The declared tunnel verbs, bound to the kernel's per-daemon client. */
export function buildTunnelVerbs(
  client: PluginClient,
  io: TerminalIo,
): Record<'tunnel' | 'tunnel status' | 'tunnel on' | 'tunnel off', VerbHandler> {
  const change =
    (enabled: boolean): VerbHandler =>
    async () => {
      const view = TunnelStatusViewSchema.parse(await client.call('PUT /v1/tunnel', { body: { enabled } }));
      io.out(renderTunnelChange(view));
      return 0;
    };
  const status: VerbHandler = async ({ options }) => {
    const view = TunnelStatusViewSchema.parse(await client.call('GET /v1/tunnel'));
    io.out(options.json === true ? JSON.stringify(view) : view.sentence);
    return 0;
  };
  return {
    // Today's `status` is the group's default (`isDefault: true`): the bare group shows the tunnel.
    tunnel: status,
    'tunnel status': status,
    'tunnel on': change(true),
    'tunnel off': change(false),
  };
}
