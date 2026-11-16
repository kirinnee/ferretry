/** R-0036: `GET /healthz` — the liveness answer `fy daemon status` and supervisors wait on, served by the kernel's own handler. */
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { AdmissionPort } from '../../../contract/bound.ts';
import { PROTOCOL } from '../../../contract/session.ts';
import { bootHost } from '../../../host/host.ts';
import { type KernelHalfSources, kernelRoutes } from '../../../host/kernel-half.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import kernelPlugin from '../../../plugin.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { recordingAdmission, request } from './fixtures.ts';

const gate = definePlugin({
  id: 'gate',
  title: 'Gate',
  version: '5.0.0',
  api: 5,
  core: true,
  kinds: [],
  provides: { admission: AdmissionPort },
});

test('R-0036 GET /healthz is open to any caller, never stored, and a booted host answers 200 with status, uptime, pid, version and protocol', async () => {
  const declared = kernelPlugin.actions?.routes.find(route => route.key === 'GET /healthz');
  expect(declared).toMatchObject({ minimum: 'none', caller: 'any', noStore: true });
  const root = await mkdtemp(`${tmpdir()}/healthz-route-`);
  const home = `${root}/home`;
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    pid: 4242,
    adapters: {
      ...realAdapters(home, () => {}, { binary: 'fy' }),
      clock: fixedClock(),
      homeLock: async () => ({ release: async () => {} }),
    },
    implementations: [implementDaemon(gate, { build: () => ({ provides: { admission: recordingAdmission() } }) })],
  });
  try {
    if (outcome.kind !== 'running') throw new Error(outcome.sentence);
    // Over a remote carrier too: the liveness read needs no standing.
    for (const local of [true, false]) {
      const response = await outcome.host.dispatch(request('GET', '/healthz', { local }));
      expect(response.status).toBe(200);
      expect(response.headers.has('retry-after')).toBe(false);
      expect(JSON.parse(response.body)).toEqual({
        status: 'ok',
        uptimeSeconds: expect.any(Number),
        pid: 4242,
        version: '5.0.0',
        protocol: PROTOCOL,
        sessionProtocol: 'ferretry-relay/2',
        boot: { phase: 'ready', step: 'jobs', stepElapsedSeconds: 0, elapsedSeconds: 0 },
        eventLoop: { lagMs: 0, maxLagMs: 0, stalls: 0 },
      });
    }
  } finally {
    if (outcome.kind === 'running') await outcome.host.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('R-0036 GET /healthz answers 503 while the daemon is still starting, with the same body shape and a retry-after, naming the step it is on and how the loop is doing', async () => {
  const eventLoop = {
    lagMs: 300,
    maxLagMs: 900,
    stalls: 2,
    lastStall: {
      at: '2026-11-06T09:00:01.000Z',
      durationMs: 300,
      during: [],
      innermost: [],
      stacks: [],
      cause: 'disk',
      io: { someAvg10: 40, saturated: true },
    },
    io: { someAvg10: 40, saturated: true },
  };
  const boot = { phase: 'starting', step: 'state:board', stepElapsedSeconds: 12, elapsedSeconds: 30 };
  const routes = kernelRoutes({
    version: '5.0.0',
    liveness: () => ({ status: 'starting', uptimeSeconds: 0, pid: 7, boot, eventLoop }),
  } as unknown as KernelHalfSources);
  const response = await routes['GET /healthz']({} as never);
  expect(response.status).toBe(503);
  expect(response.headers.get('retry-after')).toBe('2');
  expect(JSON.parse(response.body)).toEqual({
    status: 'starting',
    uptimeSeconds: 0,
    pid: 7,
    version: '5.0.0',
    protocol: PROTOCOL,
    sessionProtocol: 'ferretry-relay/2',
    boot,
    eventLoop,
  });
});
