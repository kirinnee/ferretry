/** Settings › MCP servers: the machine's inventory with Check and Sign in, and a component server's sign-in section. */
import { afterEach, describe, expect, it } from 'bun:test';
import type { Mounted } from '@ferretry/app/testing';
import { McpSettings } from '../../../app/views/servers-settings.tsx';
import { type Answers, type Call, MCP, mcpConnection, NOW, scriptedClient, SECRETS } from './mcp-fixtures.ts';
import { click, mountSettled, text } from './mcp-view-support.tsx';

const GRANTS_OPEN = { capabilities: [{ capability: 'fleet', configure: true, configureRefusal: 'granted' }] };

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const settings = async (answers: Answers = {}, calls: Call[] = []) => {
  const client = scriptedClient(
    {
      'GET /v1/mcp': MCP,
      'GET /v1/mcp/auth': { connections: [mcpConnection()] },
      'GET /v1/grants': GRANTS_OPEN,
      ...answers,
    },
    calls,
  );
  mounted = await mountSettled(<McpSettings client={client} now={() => NOW} origin="https://ferretry.pages.dev" />);
  return { root: mounted.container, calls };
};

describe('DOM tests — Settings › MCP servers', () => {
  it('reads the machine’s servers, not one ferret’s, and lists every one once', async () => {
    const calls: Call[] = [];
    const { root } = await settings({}, calls);
    expect(calls[0]).toEqual({ route: 'GET /v1/mcp', params: undefined, body: undefined });
    expect(calls.some(call => call.route === 'GET /v1/ferrets/:ferretId/mcp/servers')).toBe(false);
    expect([...root.querySelectorAll('[data-context-mcp]')].map(row => row.getAttribute('data-context-mcp'))).toEqual([
      'ferretry',
      'scratch',
      'lint',
      'notion',
      'github',
      'linear',
    ]);
    expect(root.querySelector('[data-settings="mcp"]')).not.toBeNull();
  });

  it('checks a server as the machine, with no ferret named', async () => {
    const calls: Call[] = [];
    const { root } = await settings(
      {
        'POST /v1/mcp/check': {
          id: 'id-github-user',
          name: 'github',
          transport: 'stdio',
          outcome: 'connected',
          toolCount: 3,
          tools: ['a', 'b', 'c'],
          elapsedMs: 4,
          checkedAt: '2026-10-16T10:00:00.000Z',
        },
      },
      calls,
    );
    await click(root, '[data-mcp-check="github"]');
    expect(calls.at(-1)?.body).toEqual({ id: 'id-github-user' });
    expect(text(root, '[data-mcp-row="github"] [data-mcp-status]')).toBe('Connected · 3 tools');
  });

  it('S174 gives a Ferretry component server its sign-in section, which names its secrets and never a value', async () => {
    const { root } = await settings();
    const section = root.querySelector('[data-context-mcp="linear"] [data-mcp-section="mcp-sign-in"]');
    expect(section).not.toBeNull();
    expect(text(root, '[data-context-mcp="linear"] [data-mcp-sign-in-secrets]')).toContain(SECRETS[0]);
    // The section owns Sign in for that server: its row does not offer a second one.
    expect(root.querySelector('[data-context-mcp="linear"] [data-mcp-sign-in="linear"]')).toBeNull();
    // A project server signs in from its row, with no section.
    expect(root.querySelector('[data-context-mcp="notion"] [data-mcp-section]')).toBeNull();
  });

  it('says a failed read in plain words and reads again on Try again', async () => {
    let fail = true;
    const { root } = await settings({
      'GET /v1/mcp': () => {
        if (fail) throw new Error('the machine is offline');
        return MCP;
      },
    });
    expect(root.querySelector('[data-context-failed] p')?.textContent).toBe('This machine isn’t reachable right now');
    fail = false;
    await click(root, '[data-context-retry]');
    expect(root.querySelectorAll('[data-context-mcp]')).toHaveLength(6);
  });
});
