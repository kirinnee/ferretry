import { describe, expect, test } from 'bun:test';
import type { SpawnPort, SpawnResult } from '@ferretry/kernel/contract';
import { probe, spawnRun } from '../../daemon/adapters/update-ports.ts';

/** A spawn port that answers one result for every program and never starts anything. */
const answering = (result: SpawnResult): SpawnPort => ({
  run: async () => result,
  runBytes: async () => {
    throw new Error('not used here');
  },
  start: () => {
    throw new Error('not used here');
  },
});

const KILLED: SpawnResult = { exitCode: null, signal: 'SIGTERM', stdout: '', stderr: '' };

describe('what a killed child is to the update probe', () => {
  test('a child killed at its deadline is timed-out, never an exit', async () => {
    const result = await spawnRun(answering(KILLED))({ program: 'claude', args: ['--version'], timeoutMs: 20_000 });
    expect(result.kind).toBe('timed-out');
  });

  test('a child that exited by itself is its code', async () => {
    const result = await spawnRun(answering({ exitCode: 3, signal: null, stdout: 'x', stderr: '' }))({
      program: 'claude',
      args: [],
      timeoutMs: 1000,
    });
    expect(result).toMatchObject({ kind: 'exited', code: 3 });
  });

  test('the version probe says it did not answer, not that it exited 143', async () => {
    expect(await probe(answering(KILLED)).version('/opt/bin/claude')).toEqual({
      state: 'unreadable',
      reason: 'it did not answer within 20 seconds',
    });
  });

  test('the startup probe says --help did not finish', async () => {
    expect(await probe(answering(KILLED)).startup('/opt/bin/claude')).toEqual({
      ok: false,
      reason: '--help did not finish within 20 seconds',
    });
  });
});
