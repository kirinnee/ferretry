import { expect, test } from 'bun:test';
import { FerretRegistry } from '../../daemon/lib/registry/registry.ts';
import { ferretId, T0 } from '../../contract/testing/index.ts';
import type { FerretRecord } from '../../contract/index.ts';

test('I108 registry changes announce every state and mark removal gone exactly once', () => {
  const events: unknown[] = [];
  const registry = new FerretRegistry([], change => events.push(change));
  const record: FerretRecord = {
    format: 1,
    id: ferretId('s'),
    name: 's',
    role: 'lead',
    harness: 'claude-code',
    runner: 'tmux',
    folder: '/work',
    state: 'starting',
    createdAt: T0,
    stateAt: T0,
  };
  for (const state of ['starting', 'working', 'idle', 'stopped'] as const) registry.put({ ...record, state });
  expect(registry.remove(record.id)).toBe(true);
  expect(registry.remove(record.id)).toBe(false);
  expect(events).toEqual([
    { ferret: record.id, state: 'starting' },
    { ferret: record.id, state: 'working' },
    { ferret: record.id, state: 'idle' },
    { ferret: record.id, state: 'stopped' },
    { ferret: record.id, state: 'stopped', gone: true },
  ]);
});

test('generation bumps on every change, and a public summary never carries the launch baseline', () => {
  const registry = new FerretRegistry();
  const before = registry.generation();
  const record: FerretRecord = {
    format: 1,
    id: ferretId('g'),
    name: 'g',
    role: 'lead',
    harness: 'codex',
    runner: 'tmux',
    folder: '/work',
    state: 'working',
    createdAt: T0,
    stateAt: T0,
    transcript: { v: 1, home: '/h', identity: 'undiscovered', baseline: ['old-1'] },
  };
  registry.put(record);
  expect(registry.generation()).toBeGreaterThan(before);
  const shown = registry.summary(record.id);
  expect(shown?.transcript).toEqual({ v: 1, home: '/h', identity: 'undiscovered' });
  expect(registry.get(record.id)?.transcript?.baseline).toEqual(['old-1']);
});
