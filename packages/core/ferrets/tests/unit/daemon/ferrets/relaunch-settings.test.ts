/**
 * W2-c: `GET /v1/ferrets/:ferretId/relaunch-settings` (R-0169) MOUNTED over the additive `Harness.launchSettings`
 * (RULING #27 Q9). Today's answer is `{ current, reasons }` from `SessionLaunchService.drift` (`fyd.ts:5963`); the
 * settings half now comes from the ferret's own harness, and Ferrets reads no harness file.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { TestHost } from '@ferretry/kernel/testing';
import type { FerretId, HarnessLaunchSettings } from '../../../../contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../contract/testing/index.ts';
import { RELAUNCH_SETTINGS_TIMEOUT_MS, relaunchSettings } from '../../../../daemon/modules/relaunch-settings.ts';
import type { SessionId } from '../../../../daemon/lib/session-id.ts';
import { as, host } from './route-fixture.ts';

/** A setting value and a path a harness might hold: neither may reach the response, a log line or an error. */
const SECRET = 'sk-live-W2C-0123456789abcdef';
const PATH = '/home/owner/.claude-private/settings.json';

async function boot(harness = new FakeHarness()) {
  const h = await host([], { harness, runner: new FakeRunner() });
  return { h, harness };
}

const start = async (h: TestHost, name: string): Promise<FerretId> => {
  const answer = await h.request('POST', '/v1/ferrets', {
    body: { name, folder: `/work/${name}` },
    headers: { 'x-fy-request-id': randomUUID() },
  });
  expect(answer.status).toBe(201);
  return answer.json<{ id: FerretId }>().id;
};

const read = async (h: TestHost, id: string, init: Parameters<TestHost['request']>[2] = {}) =>
  await h.request('GET', `/v1/ferrets/${id}/relaunch-settings`, init);

describe('R-0169 GET /v1/ferrets/:ferretId/relaunch-settings', () => {
  test('R-0169 a ferret its harness says launched under older settings answers today’s { current: false, reasons: [settings] }', async () => {
    const { h, harness } = await boot();
    const id = await start(h, 'alder');
    harness.launchAnswers.set(id, { kind: 'drifted', sections: ['permission-mode', 'fixed-layer'] });

    const response = await read(h, id);

    expect(response.status).toBe(200);
    // Today's shape and words, field for field: a KIND of drift, never the sections or a value.
    expect(response.json()).toEqual({ current: false, reasons: ['settings'] });
    expect(Object.keys(response.json<object>()).toSorted()).toEqual(['current', 'reasons']);
    expect(harness.launchAsked).toEqual([id]);
    await h.stop();
  });

  test('R-0169 a ferret on the settings it would be relaunched with answers { current: true, reasons: [] }', async () => {
    const { h, harness } = await boot();
    const id = await start(h, 'birch');
    harness.launchAnswers.set(id, { kind: 'current' });

    const response = await read(h, id);

    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ current: true, reasons: [] });
    await h.stop();
  });

  test('R-0169 nothing to say is today’s UNKNOWN: an unknown answer, a throw, a malformed answer or no comparison claims nothing', async () => {
    const { h, harness } = await boot();
    const unknown = await start(h, 'cedar');
    const thrown = await start(h, 'damson');
    const malformed = await start(h, 'elder');
    harness.launchAnswers.set(unknown, { kind: 'unknown' });
    harness.launchAnswers.set(thrown, new Error('boom'));
    harness.launchAnswers.set(malformed, { kind: 'stale', sections: [] } as unknown as HarnessLaunchSettings);

    const answers = await Promise.all([unknown, thrown, malformed].map(async id => (await read(h, id)).json()));
    harness.launchSettings = undefined;
    const offered = (await read(h, unknown)).json();

    for (const answer of [...answers, offered]) expect(answer).toEqual({ current: true, reasons: [] });
    await h.stop();
  });

  test('R-0169 leak probe: what a harness throws or adds to its answer never reaches the response, a log line or an error', async () => {
    const { h, harness } = await boot();
    const thrown = await start(h, 'fir');
    const padded = await start(h, 'gean');
    harness.launchAnswers.set(thrown, new Error(`could not read ${PATH}: token=${SECRET}`));
    harness.launchAnswers.set(padded, {
      kind: 'drifted',
      sections: [SECRET, PATH],
      value: SECRET,
      path: PATH,
    } as unknown as HarnessLaunchSettings);

    const bodies = [(await read(h, thrown)).body, (await read(h, padded)).body];

    expect(bodies).toEqual([
      JSON.stringify({ current: true, reasons: [] }),
      JSON.stringify({ current: false, reasons: ['settings'] }),
    ]);
    const logged = JSON.stringify(h.logs);
    for (const leaked of [SECRET, PATH]) {
      for (const body of bodies) expect(body).not.toContain(leaked);
      expect(logged).not.toContain(leaked);
    }
    await h.stop();
  });

  test('R-0169 a ferret reads only its own and its helpers’ settings: a stranger’s is refused before its harness is asked', async () => {
    const { h, harness } = await boot();
    const mine = await start(h, 'hazel');
    const theirs = await start(h, 'holly');
    harness.launchAnswers.set(theirs, { kind: 'drifted', sections: ['settings'] });

    const refused = await read(h, theirs, as(mine));
    const own = await read(h, mine, as(mine));

    expect(refused.status).toBe(403);
    expect(refused.json<{ code?: string }>().code).toBe('forbidden');
    expect(refused.body).not.toContain('settings"');
    expect(own.status).toBe(200);
    expect(harness.launchAsked).toEqual([mine]);
    await h.stop();
  });

  test('R-0169 a ferret the daemon does not hold is a 404, and no harness is asked', async () => {
    const { h, harness } = await boot();

    const response = await read(h, 'no-such-ferret');

    expect(response.status).toBe(404);
    expect(harness.launchAsked).toEqual([]);
    await h.stop();
  });
});

/** A timer that never fires: the harness answers first. */
const never = () => () => {};

describe('the relaunch-settings read over the harness hook', () => {
  const ID = 'f1' as unknown as SessionId;

  test('R-0169 a harness that does not answer in time claims nothing, on the kernel clock, and never throws', async () => {
    const harness = new FakeHarness();
    harness.launchSettings = () => new Promise(() => {});
    const timers: { delayMs: number; fire: () => void; cancelled: boolean }[] = [];
    const served = relaunchSettings({
      harnessOf: () => 'claude-code',
      harness: () => harness,
      after: (delayMs, fire) => {
        const timer = { delayMs, fire, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
    });

    const pending = served.drift(ID);
    await Promise.resolve();
    expect(timers.map(timer => timer.delayMs)).toEqual([RELAUNCH_SETTINGS_TIMEOUT_MS]);
    timers[0]?.fire();

    expect(await pending).toEqual({ current: true, reasons: [] });
    expect(timers[0]?.cancelled).toBe(true);
  });

  test('R-0169 a prompt answer cancels the timer', async () => {
    const harness = new FakeHarness();
    harness.launchAnswers.set('f1' as FerretId, { kind: 'drifted', sections: ['settings'] });
    let cancelled = 0;
    const served = relaunchSettings({
      harnessOf: () => 'claude-code',
      harness: () => harness,
      after: () => () => {
        cancelled += 1;
      },
    });

    expect(await served.drift(ID)).toEqual({ current: false, reasons: ['settings'] });
    expect(cancelled).toBe(1);
  });

  test('a ferret whose harness plugin is not loaded, or whose record names none, claims nothing', async () => {
    const harness = new FakeHarness();
    harness.launchAnswers.set('f1' as FerretId, { kind: 'drifted', sections: ['settings'] });
    const gone = relaunchSettings({ harnessOf: () => 'claude-code', harness: () => undefined, after: never });
    const unheld = relaunchSettings({ harnessOf: () => undefined, harness: () => harness, after: never });
    const served = relaunchSettings({ harnessOf: () => 'claude-code', harness: () => harness, after: never });

    expect(await gone.drift(ID)).toEqual({ current: true, reasons: [] });
    expect(await unheld.drift(ID)).toEqual({ current: true, reasons: [] });
    expect(await served.drift(ID)).toEqual({ current: false, reasons: ['settings'] });
    expect(harness.launchAsked).toEqual(['f1' as FerretId]);
  });
});
