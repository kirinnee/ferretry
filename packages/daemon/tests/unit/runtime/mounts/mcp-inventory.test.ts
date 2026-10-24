/**
 * The MCP inventory at the daemon's front door (docs/mcp-scopes.md): which capability each route needs,
 * that the answers parse as the wire contract, and which status a refusal becomes. The services behind
 * it are the real ones over the in-memory machine in `../../mcp-inventory/support.ts`.
 */
import { describe, it } from 'bun:test';
import { McpCheckResultSchema, McpInventorySchema } from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { McpCheckService, McpInventoryService } from '../../../../src/lib/mcp-inventory/index.ts';
import { mcpInventoryRoutes } from '../../../../src/lib/runtime/mounts/mcp-inventory.ts';
import { jsonBody, request } from '../../api/support.ts';
import { inventoryWorld } from '../../mcp-inventory/support.ts';
import { CREDENTIALS, GRANTED, human } from './support.ts';

function subsystem() {
  const inventory = new McpInventoryService(inventoryWorld().deps);
  const check = new McpCheckService({
    inventory,
    probe: { probe: async () => ({ serverName: 'fake', tools: ['one'] }) },
    launchEnvironment: async () => ({}),
    baseEnvironment: () => ({}),
    bearer: async () => undefined,
    redactor: { redact: async text => text },
    now: () => 0,
  });
  return { inventory, check };
}

const api = () => new ApiDispatcher(new ApiRouter(mcpInventoryRoutes(subsystem())), CREDENTIALS, GRANTED);

describe('the MCP inventory routes', () => {
  it('should list with fleet.use and filesystem.use, and check with terminal.use: a check can start a command', () => {
    // Act
    const routes = mcpInventoryRoutes(subsystem());

    // Assert
    should(
      routes.map(route => `${route.method} ${route.path} ${route.capability?.capability}.${route.capability?.axis}`),
    ).deepEqual([
      'GET /v1/mcp fleet.use',
      'POST /v1/mcp/check terminal.use',
      'GET /v1/sessions/:sessionId/mcp/servers filesystem.use',
    ]);
    should(routes.every(route => route.noStore === true && route.minimum === 'operator')).be.true();
  });

  it('should answer the machine and a ferret in the wire shape, and check a server from the ferret’s list', async () => {
    // Arrange
    const dispatcher = api();

    // Act
    const machine = await dispatcher.dispatch(request({ path: '/v1/mcp', headers: human }));
    const ferret = await dispatcher.dispatch(request({ path: '/v1/sessions/s1/mcp/servers', headers: human }));
    const docs = McpInventorySchema.parse(jsonBody(ferret)).servers.find(server => server.name === 'docs');
    const checked = await dispatcher.dispatch(
      request({
        method: 'POST',
        path: '/v1/mcp/check',
        headers: { ...human, 'content-type': 'application/json' },
        body: JSON.stringify({ id: docs?.id, sessionId: 's1' }),
      }),
    );

    // Assert
    should(machine.status).equal(200);
    should(McpInventorySchema.safeParse(jsonBody(machine)).success).be.true();
    should(McpCheckResultSchema.parse(jsonBody(checked))).containEql({
      name: 'docs',
      outcome: 'connected',
      toolCount: 1,
    });
    should(checked.headers.get('cache-control')).equal('no-store');
  });

  it('should answer 404 for a ferret or a server that is not there, and 409 for Ferretry’s own', async () => {
    // Arrange
    const dispatcher = api();
    const ferret = McpInventorySchema.parse(
      jsonBody(await dispatcher.dispatch(request({ path: '/v1/sessions/s1/mcp/servers', headers: human }))),
    );
    const check = (id: string) =>
      dispatcher.dispatch(
        request({
          method: 'POST',
          path: '/v1/mcp/check',
          headers: { ...human, 'content-type': 'application/json' },
          body: JSON.stringify({ id, sessionId: 's1' }),
        }),
      );

    // Act
    const noSession = await dispatcher.dispatch(request({ path: '/v1/sessions/nope/mcp/servers', headers: human }));
    const noServer = await check('0'.repeat(24));
    const builtin = await check(ferret.servers.find(server => server.scope === 'ferretry')?.id ?? '');

    // Assert
    should(noSession.status).equal(404);
    should(noServer.status).equal(404);
    should(jsonBody(noServer)).containEql({ code: 'mcp_server_unknown' });
    should(builtin.status).equal(409);
    should(jsonBody(builtin)).containEql({ code: 'mcp_check_builtin' });
  });
});
