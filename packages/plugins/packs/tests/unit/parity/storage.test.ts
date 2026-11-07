/** Parity rows F-0169, F-0171, F-0280, F-0281, F-0282, F-0283, F-0392, F-0403 (docs/design/rebuild-parity.md, packs). */
import { describe, expect, test } from 'bun:test';
import type { StatePort } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import { PACK_REPLACED, PACK_RUNS, PACKS_CONFIG, PacksFileSchema } from '../../../contract/index.ts';
import { StateCleanUpRunStore } from '../../../daemon/adapters/run-store.ts';
import manifest from '../../../manifest.ts';

/** An opaque state port that keeps what it is given by file and name. */
function memoryState() {
  const files = new Map<string, unknown>();
  const key = (file: { path: string }, name?: string): string => file.path.replace('*', name ?? '');
  const port = {
    read: async (file: { path: string }, name?: string) => ({ ok: true, value: files.get(key(file, name)) }),
    write: async (file: { path: string }, value: unknown, name?: string) => void files.set(key(file, name), value),
    list: async (file: { path: string }) =>
      [...files.keys()].filter(path => path.startsWith(file.path.replace('*', ''))).map(path => path.slice(5)),
    remove: async (file: { path: string }, name?: string) => void files.delete(key(file, name)),
  } as unknown as StatePort;
  return { port, files };
}

const JOB = {
  id: 'run-1',
  ferret: 'builder',
  name: 'Routing Prompt Clean-up',
  runtime: 'claude-work',
  startedAt: '2026-11-07T10:00:00.000Z' as Instant,
  status: 'running' as const,
};

describe('the packs configuration and state files', () => {
  test('F-0171 F-0392 today’s pack.yaml is config/packs.yaml: one file, a configure edit, its loosening held', () => {
    expect(PACKS_CONFIG.shape === 'file' ? PACKS_CONFIG.file : undefined).toBe('packs.yaml');
    expect(manifest.data.config).toEqual([PACKS_CONFIG]);
    expect(PACKS_CONFIG.loosens({ enabled: false }, { enabled: true })).toContain('Pack mode is switched on');
  });

  test('F-0169 today’s models-guide.yaml (the routing prompt) is the `routing` key of packs.yaml, not a second file', () => {
    expect(PacksFileSchema.safeParse({ routing: { prompt: 'Use the strongest model for plans.' } }).success).toBe(true);
    expect(manifest.data.config).toHaveLength(1);
  });

  test('F-0280 F-0282 F-0403 a Clean up run lives in state/packs/runs as <id>.run.json (format 1) beside its own files', async () => {
    expect([PACK_RUNS.path, PACK_RUNS.store]).toEqual(['runs/*', 'opaque']);
    const state = memoryState();
    const runs = new StateCleanUpRunStore(state.port);

    await runs.save({ job: JOB });
    await runs.writeFile('run-1', 'rough.txt', 'Use opus for plans.\n');

    expect(JSON.parse(state.files.get('runs/run-1.run.json') as string)).toEqual({ format: 1, job: JOB });
    expect(await runs.load('run-1')).toEqual({ job: JOB });
    expect(await runs.readFile('run-1', 'rough.txt')).toBe('Use opus for plans.\n');
    await runs.remove('run-1');
    expect(state.files.size).toBe(0);
  });

  test('F-0281 the prompt the last accepted clean-up replaced is state/packs/replaced.json, format 1', () => {
    expect([PACK_REPLACED.path, PACK_REPLACED.store, PACK_REPLACED.format]).toEqual(['replaced.json', 'json', 1]);
    expect(manifest.data.state).toContain(PACK_REPLACED);
  });

  test('F-0283 Jev’s spend ledger went with `fy new --auto` (Ferrets’ verb now): Packs declares no spend file', () => {
    expect(manifest.data.state.map(file => file.path)).not.toContain('jev-spend.json');
    expect(manifest.permissions.secrets).toEqual([]);
    expect(manifest.permissions.network).toEqual([]);
  });
});
