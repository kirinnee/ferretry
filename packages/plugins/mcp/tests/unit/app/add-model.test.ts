import { describe, expect, it } from 'bun:test';
import { draftRequest, EMPTY_MCP_DRAFT, parseEnvLines, splitCommandLine } from '../../../app/lib/add-model.ts';

const command = (over: Partial<typeof EMPTY_MCP_DRAFT> = {}) => ({
  ...EMPTY_MCP_DRAFT,
  name: 'sentry',
  command: 'npx -y @sentry/mcp-server',
  ...over,
});

describe('mcp#0 Add MCP server — the draft', () => {
  it('splits a command line, honouring quotes and backslashes', () => {
    expect(splitCommandLine(`a "b c" 'd e' f\\ g "h\\"i" \\`)).toEqual(['a', 'b c', 'd e', 'f g', 'h"i', '\\']);
    expect(splitCommandLine('   ')).toEqual([]);
    expect(splitCommandLine('x ""')).toEqual(['x', '']);
  });

  it('parses NAME=value lines and names the first bad one', () => {
    expect(parseEnvLines('A=1\n\n B = ok ')).toEqual({ error: 'Line 3: use NAME=value, with an upper-case NAME.' });
    expect(parseEnvLines('A=1\n\nB=  two ')).toEqual({ env: { A: '1', B: 'two' } });
  });

  it('is incomplete without a name, and says nothing about an empty field', () => {
    expect(draftRequest(EMPTY_MCP_DRAFT)).toEqual({ kind: 'incomplete', reason: null });
    expect(draftRequest(command({ command: '  ' }))).toEqual({ kind: 'incomplete', reason: null });
    expect(draftRequest(command({ transport: 'url', url: ' ' }))).toEqual({ kind: 'incomplete', reason: null });
  });

  it('refuses a bad name, a bad url, a bad env line and a raw secret in words', () => {
    expect(draftRequest(command({ name: '-no' }))).toEqual({
      kind: 'incomplete',
      reason: 'Name: use letters, digits, - and _, starting with a letter or digit.',
    });
    expect(draftRequest(command({ transport: 'url', url: 'ftp://x' }))).toEqual({
      kind: 'incomplete',
      reason: 'URL: use an http:// or https:// address.',
    });
    expect(draftRequest(command({ env: 'bad' }))).toEqual({
      kind: 'incomplete',
      reason: 'Line 1: use NAME=value, with an upper-case NAME.',
    });
    const raw = draftRequest(command({ env: 'SENTRY_TOKEN=sk-ant-abcdefghijklmnopqrstuvwxyz' }));
    expect(raw.kind).toBe('incomplete');
  });

  it('builds the command and url requests', () => {
    expect(draftRequest(command({ env: 'A=${A}' }))).toEqual({
      kind: 'ready',
      request: {
        name: 'sentry',
        server: { transport: 'command', command: 'npx', args: ['-y', '@sentry/mcp-server'], env: { A: '${A}' } },
      },
    });
    expect(
      draftRequest(command({ transport: 'url', url: ' https://mcp.example.test/mcp ', scope: 'login', oauth: true })),
    ).toEqual({
      kind: 'ready',
      request: { name: 'sentry', server: { transport: 'url', url: 'https://mcp.example.test/mcp', oauth: true } },
    });
    expect(
      draftRequest(command({ transport: 'url', url: 'https://mcp.example.test/mcp', scope: 'project', oauth: true })),
    ).toEqual({
      kind: 'ready',
      request: { name: 'sentry', server: { transport: 'url', url: 'https://mcp.example.test/mcp', oauth: false } },
    });
  });
});
