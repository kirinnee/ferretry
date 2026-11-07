import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { bootHost, type HostOptions } from '../../../host/host.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import kernelPlugin from '../../../plugin.ts';
import { DoctorReportSchema } from '../../../contract/doctor.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { recordingAdmission, request } from './fixtures.ts';
import { AdmissionPort } from '../../../contract/bound.ts';

const plugin = definePlugin({
  id: 'checked',
  title: 'Checked',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  doctor: ['checked-ok', 'checked-unbuilt'],
});

test('G158 a declared doctor check with no run still boots, and fy doctor names it as a failure', async () => {
  const root = await mkdtemp(`${tmpdir()}/doctor-unimplemented-`);
  const home = `${root}/home`;
  const adapters: HostOptions['adapters'] = {
    ...realAdapters(home, () => {}, { binary: 'fy' }),
    clock: fixedClock(),
    homeLock: async () => ({ release: async () => {} }),
  };
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    adapters,
    implementations: [
      implementDaemon(plugin, {
        build: () => ({ doctor: { 'checked-ok': async () => ({ state: 'ok', detail: 'fine' }) } }),
      }),
    ],
  });
  try {
    if (outcome.kind !== 'running') throw new Error(outcome.sentence);
    expect(outcome.host.plugins.get('checked')?.status).toBe('serving');
    const lines = await outcome.host.doctor();
    expect(lines).toContainEqual({ plugin: 'checked', check: 'checked-ok', state: 'ok', detail: 'fine' });
    expect(lines).toContainEqual({
      plugin: 'checked',
      check: 'checked-unbuilt',
      state: 'fail',
      detail: 'The check checked-unbuilt has no implementation.',
    });
  } finally {
    if (outcome.kind === 'running') await outcome.host.stop();
    await rm(root, { recursive: true, force: true });
  }
});

const gate = definePlugin({
  id: 'gate',
  title: 'Gate',
  version: '5.0.0',
  api: 5,
  core: true,
  kinds: [],
  provides: { admission: AdmissionPort },
});

test('R-0081 GET /v1/doctor is the kernel’s: it runs every plugin’s declared checks and a missing run is a required failure', async () => {
  const root = await mkdtemp(`${tmpdir()}/doctor-route-`);
  const home = `${root}/home`;
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    adapters: {
      ...realAdapters(home, () => {}, { binary: 'fy' }),
      clock: fixedClock(),
      homeLock: async () => ({ release: async () => {} }),
    },
    implementations: [
      implementDaemon(gate, { build: () => ({ provides: { admission: recordingAdmission() } }) }),
      implementDaemon(plugin, {
        build: () => ({
          doctor: {
            'checked-ok': async () => ({ state: 'warn', detail: 'two things are stale', fix: 'Run fy tidy.' }),
          },
        }),
      }),
    ],
  });
  try {
    if (outcome.kind !== 'running') throw new Error(outcome.sentence);
    const declared = kernelPlugin.actions?.routes.find(r => r.key === 'GET /v1/doctor');
    expect(declared).toMatchObject({ minimum: 'operator', caller: 'any', noStore: true });
    const response = await outcome.host.dispatch(request('GET', '/v1/doctor'));
    expect(response.status).toBe(200);
    const report = DoctorReportSchema.parse(JSON.parse(response.body));
    expect(report.checks).toContainEqual({
      name: 'checked: checked-ok',
      requirement: 'optional',
      status: 'missing',
      summary: 'two things are stale',
      impact: 'Run fy tidy.',
    });
    expect(report.checks).toContainEqual({
      name: 'checked: checked-unbuilt',
      requirement: 'required',
      status: 'missing',
      summary: 'The check checked-unbuilt has no implementation.',
      impact: 'Ferretry cannot rely on this until it is resolved.',
    });
    expect(report.ready).toBe(false);
  } finally {
    if (outcome.kind === 'running') await outcome.host.stop();
    await rm(root, { recursive: true, force: true });
  }
});
