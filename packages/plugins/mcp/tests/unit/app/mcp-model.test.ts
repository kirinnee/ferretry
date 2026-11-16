import { describe, expect, it } from 'bun:test';
import type { McpCheckResult, McpInventoryServer } from '../../../contract/index.ts';
import {
  checkedTools,
  checkResultOf,
  MCP_SCOPE_LABEL,
  mcpChips,
  mcpRowStatus,
  sortedMcpServers,
  visibleMcpServers,
} from '../../../app/lib/mcp-model.ts';
import { MCP, mcpServer, NOW } from './mcp-fixtures.ts';

const result = (overrides: Partial<McpCheckResult>): McpCheckResult => ({
  id: 'id',
  name: 'docs',
  transport: 'http',
  outcome: 'connected',
  elapsedMs: 5,
  checkedAt: '2026-10-16T10:00:00.000Z',
  ...overrides,
});

const project = (approval: 'approved' | 'pending' | 'disabled', extra: Partial<McpInventoryServer> = {}) =>
  mcpServer({ name: 'docs', scope: 'project', runtimes: [{ runtime: 'claude-work', approval }], ...extra });

describe('mcpRowStatus', () => {
  it('reads Ferretry’s own server as built in, with nothing to check', () => {
    expect(mcpRowStatus(mcpServer({ name: 'ferretry', scope: 'ferretry' }), undefined, NOW)).toEqual({
      label: 'Built in',
      tone: 'ok',
      detail: 'Started with every ferret.',
      canCheck: false,
      attention: false,
    });
  });

  it('says a server another scope overrides is not the one in use', () => {
    const status = mcpRowStatus(mcpServer({ name: 'docs', scope: 'user', shadowedBy: 'local' }), undefined, NOW);
    expect(status.label).toBe('Overridden by Local');
    expect(status.attention).toBe(false);
  });

  it('reads each check outcome, the freshest fact', () => {
    const approved = project('approved', { signIn: { subject: 'docs..a1b2c3d4e5f6', required: false } });
    expect(mcpRowStatus(approved, result({ toolCount: 1 }), NOW)).toMatchObject({
      label: 'Connected · 1 tool',
      tone: 'ok',
      attention: false,
    });
    expect(mcpRowStatus(approved, result({ toolCount: undefined }), NOW).label).toBe('Connected · 0 tools');
    expect(mcpRowStatus(approved, result({ outcome: 'needs-sign-in', message: 'asks' }), NOW)).toMatchObject({
      label: 'Needs sign-in',
      detail: 'asks',
      signIn: 'Sign in',
      attention: true,
    });
    expect(mcpRowStatus(approved, result({ outcome: 'error', message: 'boom' }), NOW)).toMatchObject({
      label: 'Couldn’t connect',
      tone: 'err',
      detail: 'boom',
    });
    // Connected, but this ferret never starts it: amber, and still worth attention.
    expect(mcpRowStatus(project('pending'), result({ toolCount: 2 }), NOW)).toMatchObject({
      tone: 'warn',
      attention: true,
    });
    expect(mcpRowStatus(project('disabled'), result({ outcome: 'not-approved' }), NOW).label).toBe(
      'Disabled in this project',
    );
    expect(mcpRowStatus(project('pending'), result({ outcome: 'not-approved' }), NOW).label).toBe(
      'Not approved in this project',
    );
  });

  it('reads a project server’s approval when nothing was checked, a project with no runtime as pending', () => {
    expect(mcpRowStatus(project('disabled'), undefined, NOW)).toMatchObject({ label: 'Disabled in this project' });
    expect(mcpRowStatus(project('pending'), undefined, NOW)).toMatchObject({
      label: 'Not approved in this project',
      attention: true,
    });
    expect(mcpRowStatus(mcpServer({ name: 'docs', scope: 'project', runtimes: [] }), undefined, NOW).label).toBe(
      'Not approved in this project',
    );
  });

  it('reads a sign-in: signed in, expired, needed, or one this harness cannot use', () => {
    const signedIn = mcpServer({
      name: 'linear',
      signIn: { subject: 'linear', required: true },
      connection: { component: 'linear', state: 'signed-in', renewable: true, secrets: [] },
    });
    expect(mcpRowStatus(signedIn, undefined, NOW)).toMatchObject({ tone: 'ok', attention: false });
    expect(mcpRowStatus(signedIn, undefined, NOW).signIn).toBeUndefined();

    const expired = mcpServer({
      name: 'linear',
      signIn: { subject: 'linear', required: true },
      connection: {
        component: 'linear',
        state: 'needs-sign-in',
        signedInAt: '2026-10-01T00:00:00.000Z',
        renewable: false,
        secrets: [],
      },
    });
    expect(mcpRowStatus(expired, undefined, NOW)).toMatchObject({ tone: 'warn', signIn: 'Sign in again' });

    const renewing = mcpServer({
      name: 'linear',
      signIn: { subject: 'linear', required: true },
      connection: {
        component: 'linear',
        state: 'expired',
        signedInAt: '2026-10-01T00:00:00.000Z',
        renewable: true,
        secrets: [],
      },
    });
    expect(mcpRowStatus(renewing, undefined, NOW).tone).toBe('none');

    expect(
      mcpRowStatus(mcpServer({ name: 'linear', signIn: { subject: 'linear', required: true } }), undefined, NOW),
    ).toMatchObject({ label: 'Needs sign-in', signIn: 'Sign in' });
    expect(
      mcpRowStatus(
        mcpServer({ name: 'linear', signIn: { subject: 's', required: true, unsupported: 'Codex cannot.' } }),
        undefined,
        NOW,
      ),
    ).toMatchObject({ signInUnsupported: 'Codex cannot.' });
    expect(
      mcpRowStatus(mcpServer({ name: 'plain' }), result({ outcome: 'needs-sign-in' }), NOW).signIn,
    ).toBeUndefined();
  });

  it('says a server nobody checked yet just that', () => {
    expect(mcpRowStatus(mcpServer({ name: 'github', scope: 'user' }), undefined, NOW)).toEqual({
      label: 'Not checked yet',
      tone: 'none',
      canCheck: true,
      attention: false,
    });
  });
});

describe('checks', () => {
  it('reads only a finished check, and its tools only when it connected', () => {
    const done = result({ tools: ['a'] });
    const checks = new Map([
      ['one', { kind: 'done' as const, result: done }],
      ['two', { kind: 'checking' as const }],
    ]);
    expect(checkResultOf(checks, 'one')).toBe(done);
    expect(checkResultOf(checks, 'two')).toBeUndefined();
    expect(checkedTools(done)).toEqual(['a']);
    expect(checkedTools(result({ tools: undefined }))).toEqual([]);
    expect(checkedTools(result({ outcome: 'error', tools: ['a'] }))).toEqual([]);
    expect(checkedTools(undefined)).toEqual([]);
  });
});

describe('ordering and words', () => {
  it('sorts servers by the weight the harness gives each scope, then by name', () => {
    const servers = sortedMcpServers([
      mcpServer({ name: 'b', scope: 'user' }),
      mcpServer({ name: 'z', scope: 'project' }),
      mcpServer({ name: 'a', scope: 'project' }),
      mcpServer({ name: 'f', scope: 'ferretry' }),
    ]);
    expect(servers.map(server => server.name)).toEqual(['f', 'a', 'z', 'b']);
    expect(MCP_SCOPE_LABEL.component).toBe('Ferretry');
  });
});

describe('the panel’s search and Needs attention chip', () => {
  it('counts and filters by Needs attention under the search, moved by a Check’s answer', () => {
    const none = new Map();
    expect(mcpChips(MCP.servers, '', none, NOW)).toEqual([
      { key: 'all', label: 'All', count: 6 },
      { key: 'attention', label: 'Needs attention', count: 1 },
    ]);
    expect(visibleMcpServers(MCP.servers, '', 'attention', none, NOW).map(server => server.name)).toEqual(['lint']);
    // The search reads the name, the scope's word and where it points.
    expect(visibleMcpServers(MCP.servers, 'project', 'all', none, NOW).map(server => server.name)).toEqual([
      'notion',
      'lint',
    ]);
    expect(visibleMcpServers(MCP.servers, 'linear.example', 'all', none, NOW).map(server => server.name)).toEqual([
      'linear',
    ]);

    const failed = new Map([
      [
        'id-github-user',
        {
          kind: 'done' as const,
          result: {
            id: 'id-github-user',
            name: 'github',
            transport: 'stdio' as const,
            outcome: 'error' as const,
            elapsedMs: 1,
            checkedAt: '2026-10-16T10:00:00.000Z',
          },
        },
      ],
    ]);
    expect(visibleMcpServers(MCP.servers, '', 'attention', failed, NOW).map(server => server.name)).toEqual([
      'github',
      'lint',
    ]);
  });
});
