import { describe, expect, it } from 'bun:test';
import {
  draftRequest,
  EMPTY_MCP_DRAFT,
  parseEnvLines,
  projectFolderName,
  reloadOutcome,
  splitCommandLine,
} from '../../../app/lib/add-model.ts';

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

describe('mcp#1 Reload reads Ferrets’ RestartResult for this ferret', () => {
  const none = { restarted: [], queued: [], skipped: [], failed: [] };

  it('is a reload only when the ferret is in restarted', () => {
    expect(reloadOutcome({ ...none, restarted: [{ id: 'f1' }] }, 'f1', 'Marin')).toEqual({ kind: 'restarted' });
  });

  it('says a queued reload waits for the next idle moment, with the reason or the daemon’s detail', () => {
    expect(reloadOutcome({ ...none, queued: [{ id: 'f1', reason: 'mid-turn' }] }, 'f1', 'Marin')).toEqual({
      kind: 'queued',
      sentence: 'Marin reloads at its next idle moment (it is working on a turn).',
    });
    expect(reloadOutcome({ ...none, queued: [{ id: 'f1', reason: 'in-flight' }] }, 'f1', 'Marin')).toEqual({
      kind: 'queued',
      sentence: 'Marin reloads at its next idle moment (it has work a restart would lose).',
    });
    expect(reloadOutcome({ ...none, queued: [{ id: 'f1', reason: 'own-session' }] }, 'f1', 'Marin')).toEqual({
      kind: 'queued',
      sentence: 'Marin reloads at its next idle moment (its own turn has to end first).',
    });
    expect(
      reloadOutcome({ ...none, queued: [{ id: 'f1', reason: 'in-flight', detail: '2 tools running' }] }, 'f1', 'Marin'),
    ).toEqual({ kind: 'queued', sentence: 'Marin reloads at its next idle moment (2 tools running).' });
  });

  it('says a skipped or failed reload did not happen, in words', () => {
    expect(reloadOutcome({ ...none, skipped: [{ id: 'f1', reason: 'not-running' }] }, 'f1', 'Marin')).toEqual({
      kind: 'failed',
      sentence: 'Marin was not reloaded: it is not running.',
    });
    expect(reloadOutcome({ ...none, skipped: [{ id: 'f1', reason: 'not-found' }] }, 'f1', 'Marin')).toEqual({
      kind: 'failed',
      sentence: 'Marin was not reloaded: it was not found.',
    });
    expect(reloadOutcome({ ...none, skipped: [{ id: 'f1', reason: 'not-outdated' }] }, 'f1', 'Marin')).toEqual({
      kind: 'failed',
      sentence: 'Marin was not reloaded: it is already up to date.',
    });
    expect(
      reloadOutcome({ ...none, failed: [{ id: 'f1', reason: 'the pane did not answer' }] }, 'f1', 'Marin'),
    ).toEqual({
      kind: 'failed',
      sentence: 'Marin could not be reloaded: the pane did not answer',
    });
  });

  it('never calls an answer that does not mention the ferret a reload', () => {
    expect(reloadOutcome(none, 'f1', 'Marin')).toEqual({
      kind: 'failed',
      sentence: 'Ferretry did not say whether Marin reloaded.',
    });
    expect(reloadOutcome({ ...none, restarted: [{ id: 'other' }] }, 'f1', 'Marin').kind).toBe('failed');
  });
});

describe('mcp#0 Add MCP server — the project’s name in the words', () => {
  it('names the folder the .mcp.json sits in', () => {
    expect(projectFolderName('/work/ferretry/.mcp.json')).toBe('ferretry');
    expect(projectFolderName('/.mcp.json')).toBeNull();
    expect(projectFolderName('.mcp.json')).toBeNull();
  });
});
