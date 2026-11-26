import { HOSTED_APP_ORIGIN } from '@ferretry/kernel/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { doorRoute } from './routes/door.ts';
import { ownerRoutes } from './routes/owner.ts';
import { ConnectorMcpEndpoint } from './adapters/mcp/mcp-endpoint.ts';
import { GateConnectorAudit } from './lib/audit.ts';
import { KernelConnectorCallsLog } from './lib/mcp/calls-log.ts';
import { ConnectorTextGuard } from './lib/mcp/redaction.ts';
import { ConnectorToolbox } from './lib/mcp/toolbox.ts';
import { ConnectorService } from './lib/service.ts';

/**
 * Connector (daemon half): the authorization server and its door, the owner's routes over it, and the listener that serves
 * them at the operator's own address (docs/mcp-connector.md). `lib/service.ts` owns what is on and where; the features are
 * thin: a door route asks the service whether it serves the arrival and hands the request to the handlers, an owner route
 * is a person's act over the authority.
 *
 * The connector's tools act through `kernel.delegate`, the kernel's delegated dispatch: the REAL route table and Gate on
 * every call, as the grant's connector principal, never a second control path. SEAM NOT BOUND HERE (declared GAP): the
 * 'connector off' page is a bare 404 (the same as an unrouted path), as in v4.
 */
export default implementDaemon(manifest, {
  build(ctx) {
    const { kernel } = ctx;
    const { connections } = ctx.uses;
    const audit = new GateConnectorAudit(ctx.needs.gate);
    const clock = { now: () => kernel.clock.nowMs() };
    const service = new ConnectorService({
      config: kernel.config,
      state: kernel.state,
      mcp: wiring =>
        new ConnectorMcpEndpoint({
          ...wiring,
          delegate: kernel.delegate,
          toolbox: new ConnectorToolbox({
            daemonGrants: () => ctx.needs.gate.policy()?.grants,
            guard: new ConnectorTextGuard(async text => await kernel.redaction.read(scope => scope.text(text))),
            callsLog: new KernelConnectorCallsLog(kernel.state),
            audit,
            now: clock.now,
          }),
          now: clock.now,
          newRequestId: () => `mcp-${crypto.randomUUID()}`,
          serverVersion: manifest.version,
        }),
      publicDoor: kernel.publicDoor,
      audit,
      clock,
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
