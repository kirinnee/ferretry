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
