import { describe, expect, it } from 'bun:test';
import {
  draftRequest,
  EMPTY_MCP_DRAFT,
  parseEnvLines,
  FALLBACK_FERRET_NAME,
  othersOutcome,
  otherLiveFerrets,
  projectFolderName,
  reloadOutcome,
  reloadReport,
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
      sentence: 'Marin could not be reloaded: the pane did not answer.',
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

describe('mcp#1 Reload — the words', () => {
  const none = { restarted: [], queued: [], skipped: [], failed: [] };

  it('an empty detail from the daemon falls back to the reason, never to ()', () => {
    expect(reloadOutcome({ ...none, queued: [{ id: 'f1', reason: 'mid-turn', detail: '  ' }] }, 'f1', 'Marin')).toEqual(
      {
        kind: 'queued',
        sentence: 'Marin reloads at its next idle moment (it is working on a turn).',
      },
    );
  });

  it('a reason that already ends a sentence is not given a second full stop, and one that does not gets it', () => {
    expect(reloadOutcome({ ...none, failed: [{ id: 'f1', reason: 'No pane.' }] }, 'f1', 'Marin')).toEqual({
      kind: 'failed',
      sentence: 'Marin could not be reloaded: No pane.',
    });
  });

  it('the placeholder name reads lower-case mid-sentence, a real name keeps its own', () => {
    expect(reloadOutcome(none, 'f1', FALLBACK_FERRET_NAME).kind === 'failed').toBe(true);
    expect(reloadOutcome(none, 'f1', FALLBACK_FERRET_NAME)).toEqual({
      kind: 'failed',
      sentence: 'Ferretry did not say whether this ferret reloaded.',
    });
    expect(reloadOutcome(none, 'f1', 'Marin')).toEqual({
      kind: 'failed',
      sentence: 'Ferretry did not say whether Marin reloaded.',
    });
  });
});

describe('mcp#1 the other ferrets on this login', () => {
  const ferret = (id: string, runtime: string | undefined, state: 'starting' | 'working' | 'idle' | 'stopped') => ({
    id,
    name: `name-${id}`,
    runtime,
    state,
  });
  const all = [
    ferret('f1', 'marin', 'idle'),
    ferret('f2', 'marin', 'working'),
    ferret('f3', 'marin', 'starting'),
    ferret('f4', 'marin', 'stopped'),
    ferret('f5', 'other', 'idle'),
    ferret('f6', undefined, 'idle'),
  ];

  it('are the live ferrets on the same runtime, never this one, a stopped one or another runtime', () => {
    expect(otherLiveFerrets('marin', 'f1', all).map(row => row.id)).toEqual(['f2', 'f3']);
    expect(otherLiveFerrets('marin', 'f1', [])).toEqual([]);
  });

  it('are counted per outcome, and a ferret the answer does not name is not counted as reloaded', () => {
    const result = {
      restarted: [{ id: 'f2' }],
      queued: [{ id: 'f3', reason: 'mid-turn' as const }],
      skipped: [{ id: 'f4', reason: 'not-running' as const }],
      failed: [{ id: 'f5', name: 'Five', reason: 'the pane did not answer' }],
    };
    expect(othersOutcome(result, ['f2', 'f3', 'f4', 'f5', 'f6', 'f7'])).toEqual({
      sentence:
        'Other ferrets: 1 reloaded, 1 waits for its next idle moment, 1 not reloaded (not running), 1 could not be reloaded: Five: the pane did not answer, Ferretry did not say whether 2 reloaded.',
      allRestarted: false,
    });
    expect(othersOutcome({ ...result, restarted: [{ id: 'f2' }, { id: 'f3' }], queued: [] }, ['f2', 'f3'])).toEqual({
      sentence: 'Other ferrets: 2 reloaded.',
      allRestarted: true,
    });
    expect(
      othersOutcome(
        {
          restarted: [],
          queued: [
            { id: 'f2', reason: 'mid-turn' },
            { id: 'f3', reason: 'mid-turn' },
          ],
          skipped: [],
          failed: [{ id: 'f4', reason: 'x' }],
        },
        ['f2', 'f3', 'f4'],
      ).sentence,
    ).toBe('Other ferrets: 2 wait for their next idle moment, 1 could not be reloaded: f4: x.');
  });

  it('close the dialog only when this ferret and every other one restarted', () => {
    const none = { restarted: [], queued: [], skipped: [], failed: [] };
    expect(reloadReport({ ...none, restarted: [{ id: 'f1' }] }, 'f1', 'Marin', [])).toEqual({
      closes: true,
      retry: false,
      sentence: '',
    });
    expect(reloadReport({ ...none, restarted: [{ id: 'f1' }, { id: 'f2' }] }, 'f1', 'Marin', ['f2']).closes).toBe(true);
    expect(reloadReport({ ...none, restarted: [{ id: 'f1' }] }, 'f1', 'Marin', ['f2'])).toEqual({
      closes: false,
      retry: false,
      sentence: 'Marin reloaded. Other ferrets: Ferretry did not say whether 1 reloaded.',
    });
    expect(
      reloadReport({ ...none, failed: [{ id: 'f1', reason: 'no' }], restarted: [{ id: 'f2' }] }, 'f1', 'Marin', ['f2']),
    ).toEqual({
      closes: false,
      retry: true,
      sentence: 'Marin could not be reloaded: no. Other ferrets: 1 reloaded.',
    });
  });
});

describe('mcp#0 Add MCP server — the project’s name in the words', () => {
  it('names the folder the .mcp.json sits in', () => {
    expect(projectFolderName('/work/ferretry/.mcp.json')).toBe('ferretry');
    expect(projectFolderName('/.mcp.json')).toBeNull();
    expect(projectFolderName('.mcp.json')).toBeNull();
  });
});
