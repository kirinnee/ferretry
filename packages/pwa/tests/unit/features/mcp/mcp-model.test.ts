import { describe, expect, it } from 'bun:test';
import type { McpCheckResult, McpInventoryServer } from '@ferretry/protocol';
import {
  checkedTools,
  checkResultOf,
  MCP_SCOPE_LABEL,
  mcpRowStatus,
  plainFailure,
  skillOverride,
  sortedMcpServers,
  sortedSkills,
} from '../../../../src/features/mcp/mcp-model.ts';
import { mcpServer, NOW, skill } from '../context-rail/context-rail-fixtures.ts';

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

  it('sorts skills winners first, Project before User before Ferretry, and names what overrides one', () => {
    const skills = sortedSkills([
      skill({ name: 'b', scope: 'ferretry' }),
      skill({ name: 'a', shadowedBy: 'project' }),
      skill({ name: 'c', scope: 'project' }),
      skill({ name: 'a' }),
    ]);
    expect(skills.map(entry => `${entry.scope}:${entry.name}`)).toEqual([
      'project:c',
      'user:a',
      'ferretry:b',
      'user:a',
    ]);
    expect(skillOverride(skills[3] ?? skill({ name: 'x' }))).toBe('Overridden by Project');
    expect(skillOverride(skill({ name: 'x' }))).toBeUndefined();
  });
});

describe('plainFailure', () => {
  it('says a machine that cannot be reached, or is slow, in plain words, keeping the raw text for Details', () => {
    expect(plainFailure('could not reach fyd at 127.0.0.1:7777', 'Liftoff MBP', 'read')).toEqual({
      headline: 'Liftoff MBP isn’t reachable right now',
      details: 'could not reach fyd at 127.0.0.1:7777',
    });
    expect(plainFailure('the daemon did not answer within 10s', 'Liftoff MBP', 'read').headline).toBe(
      'Liftoff MBP isn’t answering right now',
    );
  });

  it('keeps a refusal the daemon already words for people, and frames anything else', () => {
    expect(plainFailure('Unlock this device first.', 'm', 'read')).toEqual({ headline: 'Unlock this device first.' });
    expect(plainFailure('HTTP 500', 'm', 'read this ferret’s skills')).toEqual({
      headline: 'Couldn’t read this ferret’s skills',
      details: 'HTTP 500',
    });
    expect(plainFailure('  ', 'm', 'read')).toEqual({ headline: 'Couldn’t read' });
  });

  it('never reads a refusal the machine answered as the machine being unreachable, whatever it says', () => {
    const said =
      'Ferretry’s daemon couldn’t reach auth.example.com to register Ferretry — no answer came back (network error: ENOTFOUND).';
    expect(plainFailure(said, 'Liftoff MBP', 'start signing in to phoebe', true)).toEqual({
      headline: 'Couldn’t start signing in to phoebe',
      details: said,
    });
    expect(plainFailure(said, 'Liftoff MBP', 'start signing in to phoebe').headline).toBe(
      'Liftoff MBP isn’t reachable right now',
    );
  });
});
