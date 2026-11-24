import { expect, test } from 'bun:test';
import type { BearerDigest, FerretBearerDirectory } from '@ferretry/core-gate/contract';
import { FakeGate, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { testHost } from '@ferretry/kernel/testing';
import { FerretFiles, FerretTokensFile } from '../../../../contract/index.ts';
import { ferretId, T0 } from '../../../../contract/testing/index.ts';
import daemon from '../../../../daemon/index.ts';
import manifest from '../../../../manifest.ts';
import { record } from './route-fixture.ts';

test('S47 R-0364 a persisted live digest cannot authenticate a stopped or absent ferret after daemon restart', async () => {
  let directory: FerretBearerDirectory | undefined;
  const build = daemon.build;
  if (build === undefined) throw new Error('Ferrets daemon must be built');
  const watched = implementDaemon(manifest, {
    build: ctx => {
      const half = build(ctx);
      directory = half.hooks['bearers:ferret'];
      return half;
    },
  });
  let h = await testHost({
    everyDirectory: true,
    plugins: [watched],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: { gate: new FakeGate(), vault: new FakeVault(), asks: new FakeAsks() },
  });
  for (const state of ['working', 'starting', 'stopped'] as const) {
    h.state('ferrets').plant(FerretFiles, JSON.stringify({ ...record(state), state }), state);
  }
  // Synthetic digests only. Simulates revocation storage failing before the old live entry could be removed.
  const entries = ['working', 'starting', 'stopped', 'absent'].map((ferret, index) => ({
    ferret,
    digest: String(index + 1).repeat(64),
    issuedAt: T0,
  }));
  h.state('ferrets').plant(FerretTokensFile, JSON.stringify({ format: 1, tokens: entries }));
  h = await h.restart();
  expect((await h.request('GET', '/v1/ferrets')).status).toBe(200);
  expect(directory).toBeDefined();
  expect(directory?.ferretFor('1'.repeat(64) as BearerDigest)).toBe(ferretId('working'));
  expect(directory?.ferretFor('2'.repeat(64) as BearerDigest)).toBe(ferretId('starting'));
  expect(directory?.ferretFor('3'.repeat(64) as BearerDigest)).toBeUndefined();
  expect(directory?.ferretFor('4'.repeat(64) as BearerDigest)).toBeUndefined();
});

test('a valid token is known the moment the daemon listens: boot waits for the token load (no 401 for a live ferret)', async () => {
  let directory: FerretBearerDirectory | undefined;
  const build = daemon.build;
  if (build === undefined) throw new Error('Ferrets daemon must be built');
  const watched = implementDaemon(manifest, {
    build: ctx => {
      // Every state read answers a macrotask late, so a load nobody waits for is still pending when boot ends.
      const state = ctx.kernel.state as unknown as Record<string, unknown>;
      const slow = new Proxy(state, {
        get: (target, key) => {
          const member = target[key as string];
          return typeof member === 'function' && (key === 'read' || key === 'list')
            ? async (...args: unknown[]) => {
                await new Promise(resolve => setTimeout(resolve, 5));
                return await (member as (...rest: unknown[]) => unknown).apply(target, args);
              }
            : member;
        },
      });
      const half = build({ ...ctx, kernel: { ...ctx.kernel, state: slow } } as unknown as typeof ctx);
      directory = half.hooks['bearers:ferret'];
      return half;
    },
  });
  let h = await testHost({
    everyDirectory: true,
    plugins: [watched],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: { gate: new FakeGate(), vault: new FakeVault(), asks: new FakeAsks() },
  });
  h.state('ferrets').plant(FerretFiles, JSON.stringify({ ...record('working'), state: 'working' }), 'working');
  h.state('ferrets').plant(
    FerretTokensFile,
    JSON.stringify({ format: 1, tokens: [{ ferret: 'working', digest: '1'.repeat(64), issuedAt: T0 }] }),
  );
  h = await h.restart();
  // No request first: a caller who arrives at the first listening instant is judged on what boot left behind.
  expect(directory?.ferretFor('1'.repeat(64) as BearerDigest)).toBe(ferretId('working'));
});
