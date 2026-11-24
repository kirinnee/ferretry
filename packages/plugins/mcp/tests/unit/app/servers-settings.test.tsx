/** Settings › MCP servers: the machine's inventory with Check and Sign in, and a component server's sign-in section. */
import { afterEach, describe, expect, it } from 'bun:test';
import type { Mounted } from '@ferretry/app/testing';
import { McpSettings } from '../../../app/views/servers-settings.tsx';
import {
  type Answers,
  type Call,
  MCP,
  mcpConnection,
  mcpServer,
  NOW,
  RUNTIMES,
  CLAUDE_WORK_WORDS,
  scriptedClient,
  SECRETS,
} from './mcp-fixtures.ts';
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
      'GET /v1/runtimes': RUNTIMES,
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

  it('says "Seen by" in words: a runtime by its login, never by its stored name; a runtime not found by its tool', async () => {
    const { root } = await settings();
    const seen = (name: string): string => text(root, `[data-mcp-details="${name}"]`);
    expect(seen('notion')).toContain(`Seen by${CLAUDE_WORK_WORDS} (approved)`);
    expect(seen('lint')).toContain(`Seen by${CLAUDE_WORK_WORDS} (waiting for approval)`);
    for (const name of ['notion', 'lint', 'github']) expect(seen(name)).not.toContain('claude-work');
    await mounted?.unmount();
    // Runtimes cannot be read: still no stored name, only the tool.
    const { root: unread } = await settings({ 'GET /v1/runtimes': new Error('off') });
    expect(text(unread, '[data-mcp-details="notion"]')).toContain('Seen byClaude runtime (approved)');
    expect(unread.textContent).not.toContain('claude-work');
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

  it('reads the sign-ins and the grants once, however many component servers sign in', async () => {
    const more = ['asana', 'sentry', 'figma'].map(name =>
      mcpServer({ name, signIn: { subject: name, required: true } }),
    );
    const calls: Call[] = [];
    const { root } = await settings(
      {
        'GET /v1/mcp': { ...MCP, servers: [...MCP.servers, ...more] },
        'GET /v1/mcp/auth': {
          connections: ['linear', 'asana', 'sentry', 'figma'].map(c => mcpConnection({ component: c })),
        },
      },
      calls,
    );
    expect(root.querySelectorAll('[data-mcp-section="mcp-sign-in"]')).toHaveLength(4);
    expect(calls.filter(call => call.route === 'GET /v1/mcp/auth')).toHaveLength(1);
    expect(calls.filter(call => call.route === 'GET /v1/grants')).toHaveLength(1);
    // Each section finds its own server in the one list.
    expect(text(root, '[data-context-mcp="figma"] [data-mcp-sign-in-status]')).toContain('Signed in');
  });

  it('says a failed read in plain words and reads again on Try again', async () => {
    const calls: Call[] = [];
    let fail = true;
    const { root } = await settings(
      {
        'GET /v1/mcp': () => {
          if (fail) throw new Error('the machine is offline');
          return MCP;
        },
      },
      calls,
    );
    expect(root.querySelector('[data-context-failed] p')?.textContent).toBe('This machine isn’t reachable right now');
    fail = false;
    await click(root, '[data-context-retry]');
    expect(root.querySelectorAll('[data-context-mcp]')).toHaveLength(6);
    // The opening read is the page's own; only Try again is a person's press.
    expect(calls.filter(call => call.route === 'GET /v1/mcp').map(call => call.quiet)).toEqual([undefined, false]);
  });
});
