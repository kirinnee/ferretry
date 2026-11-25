/**
 * Settings › MCP servers over fake data, in a real browser: the REAL tab, an in-memory client, and the runtime behind
 * "Seen by" (Q8a): it must read as words, never as the stored runtime name.
 *
 *   ?theme=<family>-<mode>
 *   ?data=healthy    one server that needs nothing (the Needs attention chip is empty)
 *   ?data=builtins   Claude's and Codex's built-in `ferretry` server side by side
 *   ?data=twins      one server seen by two look-alike runtimes on one profile (told apart by account)
 */
import { McpInventorySchema } from '../../../../contract/index.ts';
import { createRoot } from 'react-dom/client';
import { McpSettings } from '../../../../app/views/servers-settings.tsx';
import {
  MCP,
  mcpConnection,
  mcpServer,
  NOW,
  RUNTIMES,
  scriptedClient,
  TWIN_LOGINS,
  TWIN_MCP,
  TWIN_RUNTIMES,
} from '../../../unit/app/mcp-fixtures.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const inventory = () => {
  switch (params.get('data')) {
    case 'healthy':
      return McpInventorySchema.parse({
        problems: [],
        servers: [mcpServer({ name: 'github', scope: 'user', transport: 'stdio', target: 'npx' })],
      });
    case 'builtins':
      return McpInventorySchema.parse({
        problems: [],
        servers: [
          mcpServer({ name: 'ferretry', scope: 'ferretry', transport: 'stdio', target: 'fy mcp serve' }),
          mcpServer({
            name: 'ferretry',
            scope: 'ferretry',
            harness: 'codex',
            transport: 'stdio',
            target: 'fy mcp serve',
            runtimes: [{ runtime: 'codex-work' }],
          }),
        ],
      });
    case 'twins':
      return TWIN_MCP;
    default:
      return MCP;
  }
};

const client = scriptedClient({
  'GET /v1/mcp': inventory(),
  'GET /v1/runtimes': params.get('data') === 'twins' ? TWIN_RUNTIMES : RUNTIMES,
  'GET /v1/logins': params.get('data') === 'twins' ? TWIN_LOGINS : { logins: [] },
  'GET /v1/mcp/auth': { connections: [mcpConnection()] },
  'GET /v1/grants': { capabilities: [{ capability: 'fleet', configure: true, configureRefusal: 'granted' }] },
});

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div data-scene-ready="" className="mx-auto max-w-3xl p-4">
      <McpSettings client={client} now={() => NOW} origin="https://ferretry.pages.dev" />
    </div>,
  );
