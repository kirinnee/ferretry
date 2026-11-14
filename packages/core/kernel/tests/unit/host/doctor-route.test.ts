import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { bootHost, type HostOptions } from '../../../host/host.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import kernelPlugin from '../../../plugin.ts';
import { DoctorReportSchema } from '../../../contract/doctor.ts';
import { doctorReport } from '../../../host/doctor-report.ts';
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
  doctor: ['checked-ok', 'checked-unbuilt', 'checked-silent'],
});

test('G158 a declared doctor check with no run still boots, and fy doctor names it as a note, not a failure', async () => {
  const root = await mkdtemp(`${tmpdir()}/doctor-route-`);
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
        build: () => ({
          doctor: {
            'checked-ok': async () => ({ state: 'ok', detail: 'fine' }),
            // Nothing to judge (today's tmux release with no answer): no row at all.
            'checked-silent': async () => undefined,
          },
        }),
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
      state: 'warn',
      detail: 'The check checked-unbuilt is not built yet in this build, so nothing was checked.',
    });
    expect(lines.some(line => line.check === 'checked-silent')).toBe(false);
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

test('R-0081 GET /v1/doctor is the kernel’s: it runs every plugin’s declared checks and a missing run is a note, never a failure', async () => {
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
      requirement: 'optional',
      status: 'missing',
      summary: 'The check checked-unbuilt is not built yet in this build, so nothing was checked.',
      impact: 'Ferretry keeps working, with less than it could do.',
    });
    // A check nobody built yet is a note, never a failure: a healthy daemon is ready.
    expect(report.ready).toBe(true);
  } finally {
    if (outcome.kind === 'running') await outcome.host.stop();
    await rm(root, { recursive: true, force: true });
  }
});

const leaky = definePlugin({ id: 'leaky', title: 'Leaky', version: '5.0.0', api: 5, core: false, kinds: [] });

test('R-0081 the doctor body never carries a plugin’s thrown build-error text; the local log does', async () => {
  const root = await mkdtemp(`${tmpdir()}/doctor-leak-`);
  const home = `${root}/home`;
  const logged: string[] = [];
  const thrown = "ENOENT '/secret/path/state.json' sk-ant-0123456789abcdef";
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    adapters: {
      ...realAdapters(home, () => {}, { binary: 'fy' }),
      clock: fixedClock(),
      homeLock: async () => ({ release: async () => {} }),
      logSink: record => logged.push(JSON.stringify(record)),
    },
    implementations: [
      implementDaemon(gate, { build: () => ({ provides: { admission: recordingAdmission() } }) }),
      implementDaemon(leaky, {
        build: () => {
          throw new Error(thrown);
        },
      }),
    ],
  });
  try {
    if (outcome.kind !== 'running') throw new Error(outcome.sentence);
    const response = await outcome.host.dispatch(request('GET', '/v1/doctor'));
    expect(response.status).toBe(200);
    const report = DoctorReportSchema.parse(JSON.parse(response.body));
    expect(report.checks.map(check => check.summary)).toContain('Leaky failed to build.');
    expect(response.body).not.toContain('/secret/path');
    expect(response.body).not.toContain('sk-ant');
    expect(JSON.stringify(await outcome.host.doctor())).not.toContain('/secret/path');
    expect(logged.join('\n')).toContain('/secret/path');
  } finally {
    if (outcome.kind === 'running') await outcome.host.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('V-0257 the booted host’s report carries the program inventory, named and kinded as today’s was, and a plugin’s own row name', async () => {
  const root = await mkdtemp(`${tmpdir()}/doctor-programs-`);
  const home = `${root}/home`;
  const named = definePlugin({
    id: 'named',
    title: 'Named',
    version: '5.0.0',
    api: 5,
    core: false,
    kinds: [],
    doctor: ['harness'],
  });
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    adapters: {
      ...realAdapters(home, () => {}, { binary: 'fy' }),
      clock: fixedClock(),
      homeLock: async () => ({ release: async () => {} }),
    },
    implementations: [
      implementDaemon(named, {
        build: () => ({
          doctor: {
            harness: async () => ({
              state: 'warn',
              detail: 'not found in the inherited environment, and no extra search path is declared',
              name: 'codex',
              requirement: 'alternative',
              fix: 'no codex session can start',
            }),
          },
        }),
      }),
    ],
  });
  try {
    if (outcome.kind !== 'running') throw new Error(outcome.sentence);
    const report = DoctorReportSchema.parse(
      await outcome.host.doctor().then(lines => JSON.parse(JSON.stringify(doctorReport(lines)))),
    );
    const names = report.checks.map(check => check.name);
    for (const program of ['bash', 'git', 'launchctl', 'systemctl', 'cat', 'tail', 'ps', 'nix-store', 'jq', 'gh'])
      expect(names).toContain(program);
    expect(report.checks.find(check => check.name === 'bash')?.requirement).toBe('required');
    // A finding's own name and requirement reach the report: `codex` is an alternative, not "named: harness".
    expect(report.checks.find(check => check.name === 'codex')).toMatchObject({
      requirement: 'alternative',
      status: 'missing',
      impact: 'no codex session can start',
    });
    expect(names).not.toContain('named: harness');
  } finally {
    if (outcome.kind === 'running') await outcome.host.stop();
    await rm(root, { recursive: true, force: true });
  }
});
