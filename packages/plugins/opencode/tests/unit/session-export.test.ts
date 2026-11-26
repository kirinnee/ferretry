import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { decodeExport, exportEntries, exportUsage } from '../../daemon/lib/session-export.ts';
import { isolatedEnvironment, isolatedCommand } from '../../daemon/lib/environment.ts';
import { exportReader } from '../../daemon/lib/export-reader.ts';

const capture = async (name: string) =>
  JSON.parse(await readFile(new URL(`../fixtures/spike/${name}.json`, import.meta.url), 'utf8'));

describe('OpenCode V2 session export captures', () => {
  test('resume preserves the prefix and tool call/result identities', async () => {
    const before = exportEntries(decodeExport(await capture('export-before'), 'ses_spike_001'));
    const after = exportEntries(decodeExport(await capture('export-after'), 'ses_spike_001'));
    expect([...after.slice(0, before.length)]).toEqual([...before]);
    expect(after.find(entry => entry.tools?.calls?.includes('call_spike_001'))?.role).toBe('assistant');
    const result = after.find(entry => entry.tools?.results?.includes('call_spike_001'));
    expect(result?.role).toBe('tool');
    expect(result?.text).toBe('FERRETRY_TOOL_OK');
    expect(after.some(entry => entry.text?.includes('The system is telling me'))).toBe(false);
    expect(new Set(after.map(entry => entry.id)).size).toBe(after.length);
  });

  test('denied tools retain structured errors; session totals never double count visible steps', async () => {
    const snapshot = decodeExport(await capture('export-deny'), 'ses_spike_002');
    const tool = exportEntries(snapshot).find(entry => entry.role === 'tool');
    expect(tool?.text).toBe('Permission denied: read');
    expect(tool?.data).toMatchObject({ name: 'read', error: { type: 'permission.rejected' } });
    const usage = exportUsage(snapshot);
    expect(usage.turns).toHaveLength(2);
    expect(usage.session.inputTokens).toBe(1267);
    expect(usage.turns.reduce((sum, turn) => sum + turn.inputTokens, 0)).toBe(797);
    expect(usage.session.cost).toBeCloseTo(0.000411498, 12);
    expect(usage.visibleCost).toBeCloseTo(0.000337998, 12);
    expect(usage.session.reasoningTokens).toBe(180);
  });

  test('wrong session, duplicate IDs and malformed records refuse with value-free errors', async () => {
    const raw = await capture('export-before');
    expect(() => decodeExport(raw, 'ses_other')).toThrow('another session');
    expect(() => decodeExport({ ...raw, messages: [...raw.messages, raw.messages[0]] }, raw.info.id)).toThrow(
      'duplicate',
    );
    expect(() => decodeExport({ info: { id: 'SECRET_IN_PAYLOAD' } }, 'ses_other')).toThrow('not a supported');
    try {
      decodeExport({ info: { id: 'SECRET_IN_PAYLOAD' } }, 'ses_other');
    } catch (error) {
      expect(String(error)).not.toContain('SECRET_IN_PAYLOAD');
    }
  });

  test('streaming assistants are deferred until complete, then emitted exactly once', async () => {
    const raw = await capture('export-before');
    delete raw.messages[1].time.completed;
    expect(exportEntries(decodeExport(raw, raw.info.id)).some(entry => entry.role === 'assistant')).toBe(false);
    raw.messages[1].time.completed = 1795666789603;
    expect(exportEntries(decodeExport(raw, raw.info.id)).filter(entry => entry.role === 'assistant')).toHaveLength(1);
  });

  test('polling coalesces reads, masks entries, deduplicates snapshots and cancels', async () => {
    const before = decodeExport(await capture('export-before'), 'ses_spike_001');
    const after = decodeExport(await capture('export-after'), 'ses_spike_001');
    let reads = 0;
    let now = 0;
    const controller = new AbortController();
    const reader = exportReader({
      snapshot: async () => {
        reads += 1;
        return reads === 1 ? before : after;
      },
      mask: async entry => ({ ...entry, text: entry.text?.replaceAll('FERRETRY_SPIKE_OK', '[masked]') }),
      nowMs: () => now,
      wait: async (_ms, signal) => {
        now += 3000;
        if (reads >= 2) controller.abort();
        expect(signal).toBe(controller.signal);
      },
    });
    const [first, second] = await Promise.all([reader.read(), reader.read()]);
    expect(first).toEqual(second);
    expect(reads).toBe(1);
    expect(first.some(entry => entry.text === '[masked]')).toBe(true);
    const followed = [];
    for await (const entry of reader.follow(controller.signal)) followed.push(entry);
    expect(new Set(followed.map(entry => entry.id)).size).toBe(followed.length);
    expect(followed).toHaveLength(exportEntries(after).length);
    const initial = first[0];
    if (initial === undefined) throw new Error('capture has no first entry');
    expect(await reader.find(initial.id)).toEqual(initial);
    expect(await reader.read('missing-cursor')).toEqual([]);
    expect(await reader.read(initial.id, 1)).toHaveLength(1);
  });
});

test('all storage and temp paths are isolated; inherited server/config and subscription selectors are scrubbed', () => {
  const env = isolatedEnvironment('/fixture/home/a');
  expect(Object.values(env).every(value => value.startsWith('/fixture/home/a/'))).toBe(true);
  expect(env.OPENCODE_DB).toBe('/fixture/home/a/data/opencode.db');
  expect(env.TMPDIR).toBe('/fixture/home/a/tmp');
  const command = isolatedCommand('/fixture/home/a', '/bin/opencode', ['session', 'export', 'ses_test']);
  for (const name of [
    'OPENCODE_CONFIG',
    'OPENCODE_CONFIG_CONTENT',
    'OPENCODE_CONFIG_DIR',
    'OPENCODE_SERVER',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
  ]) {
    expect(command.join(' ')).toContain(`-u ${name}`);
  }
  expect(command.slice(-5)).toEqual(['/bin/opencode', 'session', 'export', 'ses_test', '--standalone']);
  expect(() => isolatedEnvironment('/')).toThrow();
  expect(() => isolatedEnvironment('/a/../b')).toThrow();
});
