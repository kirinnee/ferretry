import { HOSTED_APP_ORIGIN } from '@ferretry/kernel/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { doorRoute } from './routes/door.ts';
import { ownerRoutes } from './routes/owner.ts';
import { GateConnectorAudit } from './lib/audit.ts';
import { ConnectorService } from './lib/service.ts';

/**
 * Connector (daemon half): the authorization server and its door, the owner's routes over it, and the listener that serves
 * them at the operator's own address (docs/mcp-connector.md). `lib/service.ts` owns what is on and where; the features are
 * thin: a door route asks the service whether it serves the arrival and hands the request to the handlers, an owner route
 * is a person's act over the authority.
 *
 * SEAMS NOT BOUND HERE (declared GAPS): `/mcp` answers `401`/`501` until the tools unit; the 'connector off' page is a bare
 * 404 (the same as an unrouted path), as in v4.
 */
export default implementDaemon(manifest, {
  build(ctx) {
    const { kernel } = ctx;
    const { connections } = ctx.uses;
    const service = new ConnectorService({
      config: kernel.config,
      state: kernel.state,
      publicDoor: kernel.publicDoor,
      audit: new GateConnectorAudit(ctx.needs.gate),
      clock: { now: () => kernel.clock.nowMs() },
      tunnelOrigin: () => {
        const carrier = connections
          .current()
          ?.carriers()
          .find(published => published.kind === 'tunnel');
        return carrier?.kind === 'tunnel' ? new URL(carrier.url).origin : undefined;
      },
      appOrigin: HOSTED_APP_ORIGIN,
      daemonId: kernel.identity.daemonId,
      log: kernel.log,
    });
    kernel.lifecycle.onStop(() => service.stop());
    const door = doorRoute(service);
    return {
      routes: {
        'GET /.well-known/oauth-protected-resource': door,
        'GET /.well-known/oauth-protected-resource/mcp': door,
        'GET /.well-known/oauth-authorization-server': door,
        'POST /oauth/register': door,
        'GET /oauth/authorize': door,
        'GET /oauth/authorize/wait': door,
        'POST /oauth/token': door,
        'POST /oauth/revoke': door,
        'POST /mcp': door,
        'GET /mcp': door,
        'DELETE /mcp': door,
        ...ownerRoutes(service),
      },
      beforeListen: async () => await service.start(),
    };
  },
});
