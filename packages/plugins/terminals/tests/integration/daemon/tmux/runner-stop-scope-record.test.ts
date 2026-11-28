import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunnerHandle } from '@ferretry/core-ferrets/contract';
import { ferretId } from '@ferretry/core-ferrets/contract/testing';
import type { SpawnPort } from '@ferretry/kernel/contract';
import { state } from '@ferretry/kernel/host';
import {
  StateTerminalPanes,
  type TerminalsStateFile,
} from '../../../../daemon/adapters/terminal/state-surface-events.ts';
import { TmuxRunner, type PaneProcessHost } from '../../../../daemon/adapters/tmux/tmux-runner.ts';
import manifest from '../../../../manifest.ts';

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

/** Real disk + a reopened kernel state port. Every process and signal is synthetic. */
async function world(record?: string) {
  const home = await mkdtemp(join(tmpdir(), 'fx2679-r2-'));
  homes.push(home);
  const open = () =>
    state.createStatePort({ home, pluginId: 'terminals', files: manifest.data.state, fs: state.createNodeHostFs() });
  const file = manifest.data.state[1] as TerminalsStateFile;
  await new StateTerminalPanes(open(), file).recordScope('fy-own', record);
  const scopes = new StateTerminalPanes(open(), file);
  const live = new Map([
    [10, { pid: 10, ppid: 1, start: 10, scope: '/fleet/ferretry-agent-own-1.scope' }],
    [11, { pid: 11, ppid: 10, start: 11, scope: '/fleet/ferretry-agent-other-1.scope' }],
    [12, { pid: 12, ppid: 10, start: 12, scope: '/fleet/ferretry-agent-own-1.scope' }],
    [77, { pid: 77, ppid: 1, start: 77, scope: '/fleet/ferretry-agent-own-1.scope' }],
  ]);
  const signals: string[] = [];
  const reads: string[] = [];
  const processes: PaneProcessHost = {
    startOf: async pid => live.get(pid)?.start,
    processOf: async pid => live.get(pid),
    ownedProcess: async (pid, ferret) => {
      const row = live.get(pid);
      return ferret === 'own' && row?.scope === '/fleet/ferretry-agent-own-1.scope' ? { ...row } : undefined;
    },
    protectedPids: async () => [99],
    tree: async () => ({ kind: 'read', rows: [...live.values()].filter(row => row.ppid === 10) as never }),
    scopeMembers: async unit => {
      reads.push(unit);
      return [...live.values()].filter(row => row.scope === `/fleet/${unit}`);
    },
    signal: (pid, signal) => {
      signals.push(`${signal}:${pid}`);
      live.delete(pid);
      for (const row of live.values()) if (row.ppid === pid) row.ppid = 1;
    },
  };
  const runner = new TmuxRunner({
    scopes,
    processes,
    tmux: {
      execute: async args => ({
        code: 0,
        stderr: '',
        stdout: args[0] === 'display-message' ? '%5|10|0|fy-own|1\n' : args[0] === 'list-panes' ? '10\n' : '',
      }),
    },
    spawn: {} as SpawnPort,
    socketPath: join(home, 'unused-private.sock'),
    now: () => 'now' as never,
    instantOf: () => 'then' as never,
    treeEnd: { stepMs: 0, pollMs: 1 },
  });
  return {
    scopes,
    signals,
    reads,
    live,
    stop: async () => await runner.stop('%5' as RunnerHandle, 'now', ferretId('own')),
  };
}

test('R3-1 / R2-1: missing record ends proved pane descendants, with no foreign signals or orphan sweep', async () => {
  const w = await world();
  await w.stop();
  expect(w.signals).toEqual(['SIGTERM:10', 'SIGTERM:12']);
  expect(w.reads).toEqual([]);
  expect(w.live.has(11)).toBe(true);
  expect(w.live.has(77)).toBe(true);
});

test('R3-1 / R2-2: foreign record ends proved pane descendants, with no foreign signals or orphan sweep', async () => {
  const w = await world('ferretry-agent-other-1.scope');
  await w.stop();
  expect(w.signals).toEqual(['SIGTERM:10', 'SIGTERM:12']);
  expect(w.reads).toEqual([]);
  expect(await w.scopes.scopeOf('fy-own')).toBeUndefined();
  expect(w.live.has(11)).toBe(true);
  expect(w.live.has(77)).toBe(true);
});

test('a valid reopened scope still selects only owned members and leaves a cross-scope child alone', async () => {
  const w = await world('ferretry-agent-own-1.scope');
  await w.stop();
  expect(w.signals).toEqual(['SIGTERM:10', 'SIGTERM:12', 'SIGTERM:77']);
  expect(w.reads).toEqual(['ferretry-agent-own-1.scope']);
  expect(w.live.has(11)).toBe(true);
});
