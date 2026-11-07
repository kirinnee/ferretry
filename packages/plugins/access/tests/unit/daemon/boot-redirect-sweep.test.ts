import { expect, test } from 'bun:test';
import { DEFAULT_GATE_CONFIG } from '@ferretry/core-gate/contract';
import type { KernelPorts } from '@ferretry/kernel/contract';
import type { DaemonContext } from '@ferretry/kernel/manifest';
import { fixedClock } from '@ferretry/kernel/testing';
import { PairingRedirectsFile } from '../../../contract/index.ts';
import daemon from '../../../daemon/index.ts';
import type {
  PairingBootHalf,
  PairingRedirectStatePort,
} from '../../../daemon/adapters/pairing/boot-redirect-sweep.ts';
import manifest from '../../../manifest.ts';
import { MemoryStateFolder } from '../../support/daemon/state-folder.ts';
import {
  createPairingRedirectPage,
  type PairingRedirectCliStatePort,
} from '../../../cli/adapters/pair/browser-opener.ts';
import { sweepPairingRedirectState as cliSweep } from '../../../cli/adapters/pairing-redirect-sweep.ts';

function fixture() {
  const clock = fixedClock('2026-11-06T09:00:00.000Z');
  const nodes = new Map<string, { kind: 'file' | 'directory' | 'symlink' | 'other'; modifiedMs: number }>();
  const calls: string[] = [];
  const warnings: string[] = [];
  let locked = false;
  const check = () => {
    expect(locked).toBe(true);
  };
  const state: PairingRedirectStatePort = {
    ...new MemoryStateFolder().port([PairingRedirectsFile]),
    list: async file => {
      check();
      expect(file.name).toBe(PairingRedirectsFile.name);
      calls.push('list');
      return [...nodes.keys()].filter(name => !name.includes('/'));
    },
    stat: async (_file, name) => {
      check();
      calls.push(`stat:${name}`);
      return nodes.get(name);
    },
    remove: async (_file, name) => {
      check();
      if (nodes.get(name as string)?.kind !== 'file') throw new Error('only regular files');
      calls.push(`unlink:${name}`);
      nodes.delete(name as string);
    },
    removeEmptyDirectory: async (_file, name) => {
      check();
      if ([...nodes.keys()].some(path => path.startsWith(`${name}/`))) throw new Error('directory is not empty');
      calls.push(`rmdir:${name}`);
      nodes.delete(name);
    },
  };
  const kernel = { clock, state, log: { warn: (message: string) => warnings.push(message) } } as unknown as KernelPorts;
  const context = {
    manifest,
    kernel,
    needs: { gate: { policy: () => DEFAULT_GATE_CONFIG } },
    uses: { connections: { current: () => undefined } },
    hooks: { provider: () => 'unavailable' },
  } as unknown as DaemonContext<typeof manifest>;
  if (daemon.build === undefined) throw new Error('daemon must build');
  const half = daemon.build(context) as ReturnType<NonNullable<typeof daemon.build>> & PairingBootHalf;
  return {
    nodes,
    calls,
    clock,
    state,
    kernel,
    warnings,
    half,
    underLock: async (run: () => Promise<void>) => {
      locked = true;
      await run();
      locked = false;
    },
    boot: async () => {
      locked = true;
      await half.beforeListen(context);
      locked = false;
      calls.push('listen');
    },
  };
}

test('P106 daemon build exposes a boot sweep that removes stale pages under the home lock before listen', async () => {
  const f = fixture();
  const old = { kind: 'directory' as const, modifiedMs: f.clock.nowMs() - 30_001 };
  const page = { ...old, kind: 'file' as const };
  f.nodes.set('pair-open-Ab1234', old);
  f.nodes.set('pair-open-Ab1234/pairing.html', page);
  f.nodes.set('pair-open-Empty1', old);
  f.nodes.set('pair-open-Fresh1', old);
  f.nodes.set('pair-open-Fresh1/pairing.html', { ...page, modifiedMs: f.clock.nowMs() - 30_000 });
  f.nodes.set('pair-open-Links1', { ...old, kind: 'symlink' });
  f.nodes.set('pair-open-PageL1', old);
  f.nodes.set('pair-open-PageL1/pairing.html', { ...page, kind: 'symlink' });
  f.nodes.set('pair-open-Extra1', old);
  f.nodes.set('pair-open-Extra1/pairing.html', page);
  f.nodes.set('pair-open-Extra1/notes', page);
  f.nodes.set('pair-open-near-miss', old);
  expect(f.calls).toEqual([]);
  expect(typeof f.half.beforeListen).toBe('function');
  await f.boot();
  expect(f.nodes.has('pair-open-Ab1234')).toBe(false);
  expect(f.nodes.has('pair-open-Empty1')).toBe(false);
  expect(f.nodes.has('pair-open-Fresh1/pairing.html')).toBe(true);
  expect(f.nodes.has('pair-open-Links1')).toBe(true);
  expect(f.nodes.has('pair-open-PageL1/pairing.html')).toBe(true);
  expect(f.nodes.has('pair-open-Extra1/notes')).toBe(true);
  expect(f.nodes.has('pair-open-Extra1')).toBe(true);
  expect(f.nodes.has('pair-open-near-miss')).toBe(true);
  expect(f.calls).not.toContain('stat:pair-open-Links1/pairing.html');
  expect(f.calls.at(-1)).toBe('listen');
  expect(f.warnings).toEqual([]);
});

test('P106 daemon boot treats an absent redirect tree as a no-op', async () => {
  const f = fixture();
  f.state.list = async () => {
    throw new Error('absent');
  };
  await f.boot();
  expect(f.calls).toEqual(['listen']);
});

test('P106 CLI writes the same private opaque tree that daemon boot and the next pair sweep', async () => {
  const f = fixture();
  const state: PairingRedirectCliStatePort = {
    ...f.state,
    createPrivateDirectory: async (file, name) => {
      expect(file.name).toBe(PairingRedirectsFile.name);
      if (f.nodes.has(name)) throw new Error('already exists');
      f.nodes.set(name, { kind: 'directory', modifiedMs: f.clock.nowMs() });
    },
    write: async (file, value, name) => {
      expect(file.name).toBe(PairingRedirectsFile.name);
      expect(value).toBeInstanceOf(Uint8Array);
      f.nodes.set(name as string, { kind: 'file', modifiedMs: f.clock.nowMs() });
    },
    pathOf: (file, name) => `/fixture/state/access/${file.path.replace('*', name)}`,
  };
  const page = await createPairingRedirectPage(state, '<html>fixture</html>');
  expect(page.file).toMatch(/^\/fixture\/state\/access\/pairing-redirects\/pair-open-[A-Za-z0-9]{6}\/pairing.html$/u);
  expect(PairingRedirectsFile.mode).toBe(0o600);
  await f.boot();
  expect(f.nodes.size).toBe(2);
  await f.clock.advance(30_001);
  await f.underLock(async () => await cliSweep(state, f.clock.nowMs()));
  expect(f.nodes.size).toBe(0);
  await createPairingRedirectPage(state, '<html>fixture</html>');
  await f.clock.advance(30_001);
  await f.boot();
  expect(f.nodes.size).toBe(0);
});

test('P106 daemon boot names the missing kernel state ports instead of claiming a sweep', async () => {
  const f = fixture();
  Object.assign(f.kernel, { state: {} });
  await f.boot();
  expect(f.warnings).toEqual([
    'pairing redirect boot cleanup needs kernel state stat and empty-directory removal ports',
  ]);
  expect(f.calls).toEqual(['listen']);
});
