/**
 * The daemon self-check, MOUNTED as the `ferrets.self-check` job (parity rows J-0032, J-0118, F-0203, F-0209): the
 * Ferrets feature registers it on the kernel, and a run of it writes the health journal. The check itself is proven
 * in the integration tier over the real adapters; this proves the job exists and is wired to the real session store.
 *
 * A run of the job STARTS a check and returns (the kernel's job runner coalesces a run that is awaited: see
 * `buildHealthJob`), so each test stops the host before it reads what the check wrote: stopping waits for the check.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { HealthEventsFile, RUNTIME_START_KEY, RuntimeStart, SelfRestartFile } from '../../../../../contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../../contract/testing/index.ts';
import { HEALTH_JOB } from '../../../../../daemon/modules/health.ts';
import { sessionState } from '../../../../support/daemon/storage.ts';
import { fakeLogins, fakeRuntimeStartAnswer, host } from '../../ferrets/route-fixture.ts';

/** Runtimes, as far as a start needs it: the runtime's login answers, so a ferret can be started. */
const startOnlyRuntimes = () =>
  implementDaemon(
    definePlugin({
      id: 'runtimes',
      title: 'runtimes (start only) (fake)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: RuntimeStart, key: RUNTIME_START_KEY }] },
    }),
    { build: () => ({ hooks: { 'runtime.start:runtimes': fakeRuntimeStartAnswer } }) },
  );

const boot = async () =>
  await host([], {
    harness: new FakeHarness(),
    runner: new FakeRunner(),
    plugins: [startOnlyRuntimes(), fakeLogins()],
  });

describe('the self-check job, mounted', () => {
  test('J-0032 the daemon registers the self-check as a job of its own', async () => {
    const h = await boot();

    expect(h.jobIds()).toContain(HEALTH_JOB);
    expect(HEALTH_JOB).toBe('ferrets.self-check');
    await h.stop();
  });

  test('F-0203 a run over a healthy fleet writes no health line and no restart stamp', async () => {
    const h = await boot();
    const started = await h.request('POST', '/v1/ferrets', {
      body: { name: 'alder', folder: '/work/alder', runtime: 'claude-work' },
      headers: { 'x-fy-request-id': randomUUID() },
    });
    expect(started.status).toBe(201);

    await h.runJob(HEALTH_JOB);
    await h.stop();

    expect(h.state('ferrets').raw(HealthEventsFile)).toBeUndefined();
    expect(h.state('ferrets').raw(SelfRestartFile)).toBeUndefined();
  });

  test('F-0203 a session folder the index does not list is written to health.jsonl, as the index it then repaired', async () => {
    const h = await boot();
    const folder = h.state('ferrets');
    // A session the index lost: its folder is there, its row is not.
    folder.files.set(
      'mw4qug00-00000001/state.json',
      JSON.stringify({ format: 1, ...sessionState('mw4qug00-00000001') }),
    );

    await h.runJob(HEALTH_JOB);
    await h.stop();

    const lines = (folder.raw(HealthEventsFile) ?? '')
      .split('\n')
      .filter(line => line.trim() !== '')
      .map(line => JSON.parse(line) as { type: string; data: { missingFromIndex?: string[] } });
    expect(lines.map(line => line.type)).toEqual(['fleet.index_incoherent']);
    expect(lines[0]?.data.missingFromIndex).toEqual(['mw4qug00-00000001']);
  });
});
