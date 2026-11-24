/**
 * Settings › MCP servers over fake data, in a real browser: the REAL tab, an in-memory client, and the runtime behind
 * "Seen by" (Q8a): it must read as words, never as the stored runtime name.
 */
import { createRoot } from 'react-dom/client';
import { McpSettings } from '../../../../app/views/servers-settings.tsx';
import { MCP, mcpConnection, NOW, RUNTIMES, scriptedClient } from '../../../unit/app/mcp-fixtures.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const client = scriptedClient({
  'GET /v1/mcp': MCP,
  'GET /v1/runtimes': RUNTIMES,
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
