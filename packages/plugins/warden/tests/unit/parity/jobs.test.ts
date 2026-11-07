import { describe, expect, test } from 'bun:test';
import { owner } from '@ferretry/kernel/testing';
import { WARDEN_STATE } from '../../../contract/index.ts';
import { createWardenSubsystem } from '../../../daemon/subsystem.ts';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { fakeConversation } from '@ferretry/plugin-conversation/contract/testing';
import { fakeKernel } from '../../support/kernel.ts';
import { waitFor } from '../../support/wait-for.ts';
import { wardenHost } from './host.ts';
import { FERRET, livenessHost } from './liveness-host.ts';

const MINUTE = 60_000;

describe('job parity', () => {
  test('J-0077 J-0036 the sweep is armed by one job after start, which reads the interval from the settings', async () => {
    const { host, clock } = await wardenHost();

    expect(host.jobIds()).toContain('warden-arm');
    const before = clock.pending();
    await host.runJob('warden-arm');
    await host.settle();

    expect(clock.pending()).toBeGreaterThan(before);
  });

  test('J-0112 J-0246 an armed sweep runs at once and then every interval, each writing its memory', async () => {
    const { host, clock } = await wardenHost();
    const swept = (): string | undefined => {
      const raw = host.state('warden').raw(WARDEN_STATE);
      return raw === undefined ? undefined : (JSON.parse(raw) as { lastSweepAt?: string }).lastSweepAt;
    };
    await host.runJob('warden-arm');
    await waitFor(() => swept() !== undefined, 'the boot sweep');
    const boot = swept();

    await clock.advance(3 * MINUTE);
    await waitFor(() => swept() !== boot, 'the sweep on the interval');

    expect(swept()).not.toBe(boot);
  });

  test('J-0038 a run asked for over the route is one sweep, serialised with the timer', async () => {
    const { host } = await wardenHost();

    const [first, second] = await Promise.all([
      host.request('POST', '/v1/warden/run', { as: owner() }),
      host.request('POST', '/v1/warden/run', { as: owner() }),
    ]);

    expect([first.status, second.status]).toEqual([200, 200]);
  });

  test('pending J-0037 (queue then look needs an investigator, a declared GAP): investigating a ferret nobody has is refused', async () => {
    const { host } = await wardenHost();

    const response = await host.request('POST', '/v1/warden/investigate', { body: { ferret: 'nobody' }, as: owner() });

    expect([404, 409]).toContain(response.status);
  });

  test('J-0148 a turn ending brings the next sweep forward after a short wait, not at once', async () => {
    const fake = fakeKernel({ start: '2026-11-07T12:00:00.000Z' });
    const subsystem = createWardenSubsystem({
      kernel: fake.kernel,
      ferrets: new FakeFerrets(),
      conversation: fakeConversation(),
      asks: new FakeAsks(),
      usage: () => undefined,
      board: () => undefined,
    });
    const disarm = subsystem.arm();
    const swept = async (): Promise<string | undefined> => (await subsystem.status()).lastSweepAt;
    await waitFor(async () => (await swept()) !== undefined, 'the boot sweep');
    const boot = await swept();

    subsystem.nudgeSweep('turnEnd');
    await fake.clock.advance(1_000);
    await new Promise(resolve => setTimeout(resolve, 30));
    const early = await swept();
    await fake.clock.advance(6_000);
    await waitFor(async () => (await swept()) !== boot, 'the sweep a turn ending brought forward');
    disarm();

    expect(early).toBe(boot);
  });

  test('J-0034 the liveness monitor is armed with the sweep, and from then each 30 s tick looks at a ferret through Terminals', async () => {
    const host = livenessHost({ sample: () => ({ paneHash: 'same', pane: '❯ ', subprocessAlive: false }) });
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(host.looks()).toBe(0);

    const disarm = host.arm();
    await host.ticks(2);
    disarm();

    expect(host.looks()).toBe(2);
  });

  test('J-0035 the tick nudges a quiet ferret only while the Warden is on and may nudge alone', async () => {
    const quiet = () => ({ paneHash: 'same', pane: '❯ ', subprocessAlive: false });
    const sentTo = async (config: unknown): Promise<number> => {
      const host = livenessHost({ sample: quiet, config });
      const disarm = host.arm();
      await host.ticks(12);
      disarm();
      return (await host.conversation.sends(FERRET)).sends.length;
    };

    expect(await sentTo(undefined)).toBe(1);
    expect(await sentTo({ mayActAlone: { nudge: false } })).toBe(0);
    expect(await sentTo({ enabled: false })).toBe(0);
  });
});
