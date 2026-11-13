import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdmissionPort } from '@ferretry/core-gate/contract';
import { ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FerretsPort } from '@ferretry/core-ferrets/contract';
import { VaultPort } from '@ferretry/core-vault/contract';
import { bootHost, realAdapters, type RunningHost } from '@ferretry/kernel/host';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { fixedClock } from '@ferretry/kernel/testing';
import { doctorReport } from '../../../../../../core/kernel/host/doctor-report.ts';
import terminals from '../../../../daemon/index.ts';
import { fakeFerrets, fakeVault } from '../../../support/daemon/half.ts';

/**
 * The `tmux` doctor row through the REAL Terminals half on the REAL host (real config, real executable probe, real
 * `PATH` search over a temporary folder), with every spawn, network and worker launch refused: tmux absent is a
 * REQUIRED, missing check and the report is not ready, exactly as the v4 doctor says (`Sessions cannot start or be
 * managed`); a tmux that is there is `ok`, and the checks nobody built yet stay notes.
 */

const gate = definePlugin({
  id: 'gate',
  title: 'Gate',
  version: '5.0.0',
  api: 5,
  core: true,
  kinds: [],
  provides: { admission: AdmissionPort, vault: VaultPort, ferrets: FerretsPort },
});

const homes: string[] = [];
const running: RunningHost[] = [];
afterEach(async () => {
  for (const host of running.splice(0)) await host.stop();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

/** A host whose `PATH` is one temporary folder, holding a `tmux` program only when `withTmux`. */
async function boot(withTmux: boolean) {
  const home = await mkdtemp(join(tmpdir(), 'fy-tmux-doctor-'));
  homes.push(home);
  await writeFile(
    join(home, 'home.json'),
    JSON.stringify({ format: 1, createdBy: '5.0.0', createdAt: '2026-11-13T00:00:00Z' }),
    { mode: 0o600 },
  );
  const bin = join(home, 'bin');
  await mkdir(bin);
  if (withTmux) {
    await writeFile(join(bin, 'tmux'), '#!/bin/sh\nexit 0\n');
    await chmod(join(bin, 'tmux'), 0o755);
  }
  const launched: string[] = [];
  const real = realAdapters(home, () => undefined, { binary: 'fy' });
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    adapters: {
      ...real,
      clock: fixedClock(),
      ownerHome: () => join(home, 'person'),
      searchPath: () => bin,
      operatorVariable: () => undefined,
      homeLock: async () => ({ release: async () => undefined }),
      spawn: {
        run: async (program: string) => {
          launched.push(program);
          return { exitCode: 127, signal: null, stdout: '', stderr: 'not found' };
        },
        runBytes: async () => {
          throw new Error('no child allowed');
        },
        start: () => {
          throw new Error('no child allowed');
        },
      },
      fetch: {
        request: async () => {
          throw new Error('no network allowed');
        },
      },
      websocket: {
        connect: () => {
          throw new Error('no network allowed');
        },
      },
      workers: {
        start: () => {
          throw new Error('no worker allowed');
        },
      },
    } as never,
    implementations: [
      implementDaemon(gate, {
        build: () => ({
          provides: {
            admission: new StandInAdmission(() => ownerStanding()),
            vault: fakeVault([]),
            ferrets: fakeFerrets(),
          },
        }),
      }),
      terminals,
    ],
  });
  if (outcome.kind !== 'running') throw new Error(outcome.sentence);
  running.push(outcome.host);
  return { host: outcome.host, bin, launched };
}

describe('the tmux doctor row on the real Terminals half', () => {
  test('tmux absent is a required, missing check and the report is not ready', async () => {
    const { host } = await boot(false);
    expect(host.plugins.get('terminals')?.status).toBe('serving');

    const report = doctorReport(await host.doctor());

    expect(report.checks).toContainEqual({
      name: 'terminals: tmux',
      requirement: 'required',
      status: 'missing',
      summary: 'not found on PATH',
      impact: 'Sessions cannot start or be managed.',
    });
    expect(report.ready).toBe(false);
  });

  test('tmux present is an ok row, and the checks nobody built yet are still notes: ready', async () => {
    const { host, bin, launched } = await boot(true);

    const report = doctorReport(await host.doctor());

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        name: 'terminals: tmux',
        requirement: 'optional',
        status: 'present',
        summary: `found on PATH at ${bin}/tmux`,
      }),
    );
    const userSlice = report.checks.find(check => check.name === 'terminals: user-slice');
    expect(userSlice).toMatchObject({ requirement: 'optional', status: 'missing' });
    expect(userSlice?.summary).toContain('not built yet');
    expect(report.ready).toBe(true);
    // Finding tmux ran nothing but the release row's own bounded questions, never a program to look for tmux.
    expect(launched.every(program => program === 'tmux')).toBe(true);
  });
});
