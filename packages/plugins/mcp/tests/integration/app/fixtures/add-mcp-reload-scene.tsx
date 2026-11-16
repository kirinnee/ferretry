/**
 * The browser entry for Add MCP server: the REAL `AddMcpForm` over an in-memory client, framed as the actions
 * popover frames it (`.fy-action-form`). Nothing reads a network: every answer is made up below, and every name and
 * path is fake.
 *
 * Parameters:
 *
 *   ?theme=<family>-<mode>
 */

import { createRoot } from 'react-dom/client';
import { AddMcpForm } from '../../../../app/views/add-mcp-form.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const ferret = (id: string, name: string, state: string) => ({
  id,
  name,
  runtime: 'marin',
  state,
  harness: 'claude-code',
  folder: '/work/example',
});

const ANSWERS: Record<string, unknown> = {
  'GET /v1/ferrets/:ferretId/mcp': { project: null },
  'POST /v1/ferrets/:ferretId/mcp/login/preview': {
    scope: 'login',
    runtime: 'marin',
    profile: 'default',
    replaces: false,
    ferrets: 3,
  },
  'POST /v1/ferrets/:ferretId/mcp/login': { scope: 'login', name: 'sentry', runtime: 'marin', profile: 'default' },
  'GET /v1/ferrets': [ferret('f1', 'Wren', 'working'), ferret('f2', 'Otter', 'idle'), ferret('f3', 'Heron', 'working')],
  'POST /v1/restarts': { restarted: [{ id: 'f1' }], queued: [], skipped: [], failed: [] },
};

const client = {
  call: async (route: string) => {
    if (!(route in ANSWERS)) throw new Error(`no route ${route}`);
    return ANSWERS[route];
  },
} as never;

createRoot(document.getElementById('root') as HTMLElement).render(
  <div className="fy-action-form" style={{ margin: '0 auto', maxWidth: 400 }}>
    <h2 className="fy-action-form__title">Add MCP server…</h2>
    <AddMcpForm
      agentName="Wren"
      client={client}
      ferretId="f1"
      host={{ close: () => undefined }}
      initialScope="login"
      login="marin"
      origin="https://pwa.example.test"
      previewDebounceMs={0}
    />
  </div>,
);
