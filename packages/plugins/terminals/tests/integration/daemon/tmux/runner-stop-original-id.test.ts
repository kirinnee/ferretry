import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunnerHandle } from '@ferretry/core-ferrets/contract';
import { FerretIdSchema } from '@ferretry/core-ferrets/contract';
import type { SpawnPort } from '@ferretry/kernel/contract';
import { ownedScopePath, paneProcessHost } from '../../../../daemon/adapters/tmux/pane-process-host.ts';
import { TmuxRunner, ferretTmuxSession } from '../../../../daemon/adapters/tmux/tmux-runner.ts';
import { agentScopeName, ferretSliceName } from '../../../../daemon/lib/cgroups/scope.ts';

const homes: string[] = [];
const linuxTest = test.skipIf(process.platform !== 'linux');
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

/** Synthetic procfs and manager metadata; every signal is captured, never sent to a real PID. */
async function world(original: string, placementOwner: string, record: boolean, stale = false) {
  const id = FerretIdSchema.parse(original);
  const home = await mkdtemp(join(tmpdir(), 'fx2679-r4-'));
  homes.push(home);
  const unit = agentScopeName(placementOwner, 'fixture');
  const slice = ferretSliceName(placementOwner);
  const path = `/fleet/${slice}/${unit}`;
  const metadata = `Id=${unit}\nSlice=${slice}\nControlGroup=${path}\n`;
  const rows = [
    { pid: 10, start: 100, ppid: 1, scope: path },
    { pid: 12, start: 120, ppid: 10, scope: path },
  ];
  for (const row of rows) {
    await mkdir(join(home, String(row.pid)));
    await writeFile(
      join(home, String(row.pid), 'stat'),
      `${row.pid} (helper) S ${row.ppid} ${Array(17).fill('0').join(' ')} ${row.start}\n`,
    );
    await writeFile(join(home, String(row.pid), 'cgroup'), `0::${path}\n`);
  }
  const spawn = {
    run: async () => ({ exitCode: 0, stdout: metadata, stderr: '' }),
  } as unknown as SpawnPort;
  const host = paneProcessHost(spawn, 'linux', home);
  const live = new Map(rows.map(row => [row.pid, row]));
  let enumerations = 0;
  const signals: string[] = [];
  const proofs: string[] = [];
  const runner = new TmuxRunner({
    spawn,
    socketPath: join(home, 'unused-private.sock'),
    now: () => 'now' as never,
    instantOf: () => 'then' as never,
    scopes: {
      scopeOf: async () => (record ? unit : undefined),
      recordScope: async () => {},
    },
    tmux: {
      execute: async args => ({
        code: args[0] === 'display-message' && stale ? 1 : 0,
        stderr: '',
        stdout:
          args[0] === 'display-message'
            ? `%5|10|0|${ferretTmuxSession(id)}|1\n`
            : args[0] === 'list-panes'
              ? '10\n'
              : '',
      }),
    },
    processes: {
      ...host,
      startOf: async pid => live.get(pid)?.start,
      processOf: async pid => live.get(pid),
      tree: async () => ({ kind: 'read', rows: [...live.values()].filter(row => row.ppid === 10) as never }),
      protectedPids: async () => [99],
      ownedProcess: async (pid, ferret) => {
        proofs.push(ferret);
        return live.has(pid) ? await host.ownedProcess?.(pid, ferret) : undefined;
      },
      scopeMembers: async (scope, ferret = original) => {
        if (ownedScopePath(scope, metadata, ferret) === undefined) return [];
        enumerations++;
        return [...live.values()].map(row => ({ ...row }));
      },
      signal: (pid, signal) => {
        signals.push(`${signal}:${pid}`);
        // The helper resists TERM, so escalation must also retain the original ownership identity.
        if (pid === 12 && signal === 'SIGTERM') return;
        live.delete(pid);
        for (const row of live.values()) if (row.ppid === pid) row.ppid = 1;
      },
    },
    treeEnd: { stepMs: 0, pollMs: 1 },
    politeGraceMs: 0,
  });
  return {
    stop: async (how: 'now' | 'polite') => await runner.stop('%5' as RunnerHandle, how, id),
    attachAndStop: async () => {
      expect((await runner.attach('%5' as RunnerHandle, undefined, undefined, id)).ok).toBe(true);
      await runner.stop('%5' as RunnerHandle, 'now');
    },
    signals,
    proofs,
    enumerations: () => enumerations,
  };
}

test('R4-1: schema-valid ids that collapse to one unit part require the ORIGINAL exact manager Slice', () => {
  const original = FerretIdSchema.parse('own-');
  const foreign = FerretIdSchema.parse('own');
  const unit = agentScopeName(original, 'fixture');
  expect(unit).toBe(agentScopeName(foreign, 'fixture'));
  const slice = ferretSliceName(foreign);
  const metadata = `Id=${unit}\nSlice=${slice}\nControlGroup=/fleet/${slice}/${unit}\n`;
  expect(ownedScopePath(unit, metadata, original)).toBeUndefined();
  expect(ownedScopePath(unit, metadata, foreign)).toBe(`/fleet/${slice}/${unit}`);
});

linuxTest('R4-1: a colliding foreign record is refused before enumeration and sends zero signals', async () => {
  const w = await world('own-', 'own', true);
  await w.stop('now');
  expect(w.enumerations()).toBe(0);
  expect(w.signals).toEqual([]);
});

linuxTest('R4-1: the original id still stops its own helper when its unit part collides with another id', async () => {
  const w = await world('own-', 'own-', true);
  await w.stop('now');
  expect(w.signals).toEqual(['SIGTERM:10', 'SIGTERM:12', 'SIGKILL:12']);
  expect(w.enumerations()).toBeGreaterThan(0);
});

for (const record of [false, true]) {
  linuxTest(
    `R4-2: attaching remembers the original 78-char id for a later stop (${record ? 'valid' : 'missing'} record)`,
    async () => {
      const original = 'a'.repeat(78);
      const w = await world(original, original, record);
      await w.attachAndStop();
      expect(w.signals).toEqual(['SIGTERM:10', 'SIGTERM:12', 'SIGKILL:12']);
      expect(w.proofs.every(id => id === original)).toBe(true);
    },
  );
  for (const stale of [false, true]) {
    for (const how of ['now', 'polite'] as const) {
      linuxTest(
        `R4-2: 78-char original id ends its helper (${record ? 'valid' : 'missing'} record, ${stale ? 'stale' : 'live'} handle, ${how})`,
        async () => {
          const original = 'a'.repeat(78);
          expect(ferretTmuxSession(original).slice(3)).not.toBe(original);
          const w = await world(original, original, record, stale);
          await w.stop(how);
          expect(w.signals).toEqual(['SIGTERM:10', 'SIGTERM:12', 'SIGKILL:12']);
          expect(w.proofs.length).toBeGreaterThan(0);
          expect(w.proofs.every(id => id === original)).toBe(true);
          if (record) expect(w.enumerations()).toBeGreaterThan(0);
          else expect(w.enumerations()).toBe(0);
        },
      );
    }
  }
}
