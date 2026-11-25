import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { TestHost } from '@ferretry/kernel/testing';
import {
  FerretHistoryFiles,
  FerretLaunchSectionsFiles,
  type FerretSummary,
  type RestartResult,
  type RestartStatus,
  RestartsFile,
} from '../../../../contract/index.ts';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { RUNTIME_START_KEY, RuntimeStart } from '../../../../contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../contract/testing/index.ts';
import { as, fakeLogins, host } from './route-fixture.ts';
import { connectorActor } from '@ferretry/core-gate/contract';
import { ownerStanding } from '@ferretry/core-gate/contract/testing';

/**
 * R-0323, R-0128, R-0023 (today's `mounts/session-restart.ts`): restart ferrets on the same login with their
 * conversation kept, never forced past a ferret that is busy.
 */

const ask = async (h: TestHost, body: unknown, who?: string) =>
  await h.request('POST', '/v1/restarts', { body, ...(who === undefined ? {} : as(who)) });

async function running() {
  const runner = new FakeRunner();
  const harness = new FakeHarness();
  // How each stop was asked for: a restart must END the harness, never leave it alive in its pane.
  const stops: string[] = [];
  const stop = harness.stop.bind(harness);
  harness.stop = async (ferret, handle, using, how) => {
    stops.push(how);
    await stop(ferret, handle, using, how);
  };
  const h = await host([], { harness, runner });
  const start = async (name: string): Promise<string> => {
    const answer = await h.request('POST', '/v1/ferrets', {
      body: { name, folder: `/work/${name}` },
      headers: { 'x-fy-request-id': randomUUID() },
    });
    expect(answer.status).toBe(201);
    return answer.json<{ id: string }>().id;
  };
  return { h, runner, start, stops };
}
const history = (h: TestHost, id: string): string[] =>
  (h.state('ferrets').raw(FerretHistoryFiles, id) as string)
    .split('\n')
    .filter(line => line !== '')
    .map(line => (JSON.parse(line) as { type: string }).type);

describe('restarting ferrets', () => {
  test('R-0323 a ferret on a declared wait is restarted now: stopped and resumed on the same harness', async () => {
    const { h, runner, start, stops } = await running();
    const id = await start('aniya');
    await h.request('POST', `/v1/ferrets/${id}/signal`, { body: { kind: 'waiting', condition: 'CI' } });
    expect(runner.starts).toBe(1);
    const answer = await ask(h, { scope: 'ids', ids: ['aniya'] });
    expect(answer.status).toBe(200);
    expect(answer.json<RestartResult>()).toMatchObject({ restarted: [{ id, name: 'aniya' }], queued: [], failed: [] });
    expect(runner.starts).toBe(2);
    const view = (await h.request('GET', `/v1/ferrets/${id}`)).json<FerretSummary>();
    // It is a fresh process on the same conversation: working, and no longer on the wait it had.
    expect(view.state).toBe('working');
    expect(view.waiting).toBeUndefined();
    // Stopped NOW: Claude Code answers one polite Ctrl-C at an idle prompt with "Press Ctrl-C again to exit".
    expect(stops).toEqual(['now']);
    // One relaunch that replaced the live pane (`session.resumed` says `replacedLiveTerminal`), as a move's is: no
    // separate stop, which is what let a restart stop a harness it then could not start (proof run 7).
    expect(history(h, id)).toEqual(['session.waiting', 'session.resumed', 'session.restarted']);
    await h.stop();
  });

  test('R-0323 a ferret that is working is never forced: it is queued, durably, with the reason', async () => {
    const { h, runner, start } = await running();
    const id = await start('aniya');
    const answer = await ask(h, { scope: 'ids', ids: [id] });
    expect(answer.json<RestartResult>().queued).toEqual([{ id, name: 'aniya', reason: 'mid-turn' }]);
    expect(runner.starts).toBe(1);
    const kept = JSON.parse(h.state('ferrets').raw(RestartsFile) as string) as { queued: { id: string }[] };
    expect(kept.queued.map(entry => entry.id)).toEqual([id]);
    // A daemon that restarts still holds the waiting restart.
    const again = await h.restart();
    const status = (await again.request('GET', '/v1/restarts')).json<RestartStatus>();
    expect(status.queued.map(entry => entry.id)).toEqual([id]);
    await again.stop();
  });

  test('R-0323 when: now restarts a ferret that is mid-turn at once; idle and an absent `when` queue it as before', async () => {
    const { h, runner, start } = await running();
    const id = await start('aniya');
    // `idle` is the default spelled out: the same queue as no `when` at all.
    const idle = await ask(h, { scope: 'ids', ids: [id], when: 'idle' });
    expect(idle.json<RestartResult>()).toMatchObject({ restarted: [], queued: [{ id, reason: 'mid-turn' }] });
    expect(runner.starts).toBe(1);
    // `now` takes it past the wait: restarted, and the waiting entry it had is gone.
    const now = await ask(h, { scope: 'ids', ids: [id], when: 'now' });
    expect(now.json<RestartResult>()).toMatchObject({ restarted: [{ id, name: 'aniya' }], queued: [], failed: [] });
    expect(runner.starts).toBe(2);
    expect((await h.request('GET', '/v1/restarts')).json<RestartStatus>().queued).toEqual([]);
    expect(history(h, id)).toContain('session.restarted');
    await h.stop();
  });

  test('R-0323 an unknown `when` is refused', async () => {
    const { h, start } = await running();
    const id = await start('aniya');
    expect((await ask(h, { scope: 'ids', ids: [id], when: 'later' })).status).toBe(400);
    await h.stop();
  });

  test('R-0323 the drain restarts a queued ferret once it declares a wait, and drops an entry that is done', async () => {
    const { h, runner, start } = await running();
    const id = await start('aniya');
    await ask(h, { scope: 'ids', ids: [id] });
    await h.runJob('restart-drain');
    expect(runner.starts).toBe(1);
    await h.request('POST', `/v1/ferrets/${id}/signal`, { body: { kind: 'waiting' } });
    await h.runJob('restart-drain');
    expect(runner.starts).toBe(2);
    expect((await h.request('GET', '/v1/restarts')).json<RestartStatus>().queued).toEqual([]);
    await h.stop();
  });

  test('R-0323 a ferret that is not found or not running is skipped with the reason, and a restart is idempotent under its request id', async () => {
    const { h, runner, start } = await running();
    const id = await start('aniya');
    await h.request('POST', `/v1/ferrets/${id}/stop`, { body: {} });
    const answer = await ask(h, { scope: 'ids', ids: ['nobody', id] });
    expect(answer.json<RestartResult>().skipped).toEqual([
      { id: 'nobody', reason: 'not-found' },
      { id, name: 'aniya', reason: 'not-running' },
    ]);
    expect(runner.starts).toBe(1);
    const once = await h.request('POST', '/v1/restarts', {
      body: { scope: 'ids', ids: [id] },
      headers: { 'x-fy-request-id': 'same' },
    });
    const twice = await h.request('POST', '/v1/restarts', {
      body: { scope: 'ids', ids: [id] },
      headers: { 'x-fy-request-id': 'same' },
    });
    expect(twice.body).toBe(once.body);
    await h.stop();
  });

  describe('R-0323 R-0128 scope outdated (U6)', () => {
    /** Plants what a launch recorded of the sections it told: a fingerprint the snapshot of this host does not hold. */
    const stale = (h: TestHost, id: string) =>
      h
        .state('ferrets')
        .plant(FerretLaunchSectionsFiles, JSON.stringify({ format: 1, sections: { board: 'aaaa1111' } }), id);
    const waiting = async (h: TestHost, id: string) =>
      await h.request('POST', `/v1/ferrets/${id}/signal`, { body: { kind: 'waiting', condition: 'CI' } });

    test('restart scope outdated restarts only ferrets whose launch sections differ', async () => {
      const { h, runner, start } = await running();
      const old = await start('aniya');
      const current = await start('bodhi');
      // Both launched under this snapshot; only aniya's record says it was told a section the snapshot no longer holds.
      expect(h.state('ferrets').raw(FerretLaunchSectionsFiles, old)).toBeDefined();
      stale(h, old);
      await waiting(h, old);
      await waiting(h, current);
      expect(runner.starts).toBe(2);

      const answer = await ask(h, { scope: 'outdated' });
      expect(answer.status).toBe(200);
      expect(answer.json<RestartResult>()).toMatchObject({
        restarted: [{ id: old, name: 'aniya' }],
        queued: [],
        failed: [],
      });
      // One fresh process, and it is the stale ferret's: the current one was never touched.
      expect(runner.starts).toBe(3);
      expect(history(h, current)).toEqual(['session.waiting']);
      expect(history(h, old)).toEqual(['session.waiting', 'session.resumed', 'session.restarted']);
      // The relaunch recorded what it told, so the ferret is current now and a second request has nothing to do.
      const status = (await h.request('GET', '/v1/restarts')).json<RestartStatus>();
      expect(status.outdated).toEqual([]);
      await h.stop();
    });

    test('R-0128 GET /v1/restarts lists the outdated ferrets with the sections that differ, and no ferret it cannot prove', async () => {
      const { h, start } = await running();
      const old = await start('aniya');
      const current = await start('bodhi');
      const unrecorded = await start('cyra');
      const damaged = await start('dara');
      const stopped = await start('emre');
      stale(h, old);
      h.state('ferrets').plant(FerretLaunchSectionsFiles, '{ not json', damaged);
      h.state('ferrets').plant(
        FerretLaunchSectionsFiles,
        JSON.stringify({ format: 1, sections: { board: 'bbbb2222' } }),
        stopped,
      );
      await h.request('POST', `/v1/ferrets/${stopped}/stop`, { body: {} });
      // A ferret that never recorded what it was told (launched before records were kept) is not outdated.
      expect(h.state('ferrets').files.delete(`${unrecorded}/launch-sections.json`)).toBe(true);
      const status = (await h.request('GET', '/v1/restarts')).json<RestartStatus>();
      expect(status.outdated).toEqual([{ id: old, name: 'aniya', sections: ['board'] }]);
      expect(status.outdated.map(entry => entry.id)).not.toContain(current);
      await h.stop();
    });

    test('R-0323 a busy outdated ferret is queued for its next idle moment and restarted only while it is still outdated', async () => {
      const { h, runner, start } = await running();
      const old = await start('aniya');
      stale(h, old);
      const answer = await ask(h, { scope: 'outdated' });
      expect(answer.json<RestartResult>().queued).toEqual([{ id: old, name: 'aniya', reason: 'mid-turn' }]);
      // It becomes current by some other path before it idles: the drain drops the entry and restarts nothing.
      h.state('ferrets').plant(FerretLaunchSectionsFiles, JSON.stringify({ format: 1, sections: {} }), old);
      await waiting(h, old);
      await h.runJob('restart-drain');
      expect(runner.starts).toBe(1);
      expect((await h.request('GET', '/v1/restarts')).json<RestartStatus>().queued).toEqual([]);
      await h.stop();
    });

    test('R-0128 GET /v1/ferrets marks a running outdated ferret with { sections }, and no ferret it cannot prove', async () => {
      const { h, start } = await running();
      const old = await start('aniya');
      const current = await start('bodhi');
      const damaged = await start('dara');
      const stopped = await start('emre');
      stale(h, old);
      h.state('ferrets').plant(FerretLaunchSectionsFiles, '{ not json', damaged);
      h.state('ferrets').plant(
        FerretLaunchSectionsFiles,
        JSON.stringify({ format: 1, sections: { board: 'bbbb2222' } }),
        stopped,
      );
      await h.request('POST', `/v1/ferrets/${stopped}/stop`, { body: {} });
      const list = (await h.request('GET', '/v1/ferrets')).json<FerretSummary[]>();
      const marks = Object.fromEntries(list.map(summary => [summary.id, summary.outdated]));
      expect(marks).toEqual({
        [old]: { sections: ['board'] },
        [current]: undefined,
        [damaged]: undefined,
        [stopped]: undefined,
      });
      // The one view says the same.
      expect((await h.request('GET', `/v1/ferrets/${old}`)).json<FerretSummary>().outdated).toEqual({
        sections: ['board'],
      });
      expect((await h.request('GET', `/v1/ferrets/${current}`)).json<FerretSummary>().outdated).toBeUndefined();
      await h.stop();
    });

    test('R-0128 the mark is kept 5 s, then follows the record; an unchanged fleet still answers 304', async () => {
      const { h, start } = await running();
      const old = await start('aniya');
      stale(h, old);
      const first = await h.request('GET', '/v1/ferrets');
      expect(first.json<FerretSummary[]>()[0]?.outdated).toEqual({ sections: ['board'] });
      const etag = first.headers.get('etag');
      expect(etag).toBeDefined();
      expect((await h.request('GET', '/v1/ferrets', { headers: { 'if-none-match': etag ?? '' } })).status).toBe(304);
      // It becomes current: inside the window the mark stays, after it the mark is gone and the tag moves.
      h.state('ferrets').plant(FerretLaunchSectionsFiles, JSON.stringify({ format: 1, sections: {} }), old);
      await h.clock.advance(4_000);
      expect((await h.request('GET', '/v1/ferrets')).json<FerretSummary[]>()[0]?.outdated).toEqual({
        sections: ['board'],
      });
      await h.clock.advance(1_000);
      const after = await h.request('GET', '/v1/ferrets', { headers: { 'if-none-match': etag ?? '' } });
      expect(after.status).toBe(200);
      expect(after.json<FerretSummary[]>()[0]?.outdated).toBeUndefined();
      await h.stop();
    });

    test('R-0323 a ferret caller may not restart the whole outdated fleet', async () => {
      const { h, start } = await running();
      const id = await start('aniya');
      const answer = await ask(h, { scope: 'outdated' }, id);
      expect(answer.status).toBe(403);
      await h.stop();
    });
  });

  test('R-0323 all restarts every running ferret that is at a wait and queues the rest', async () => {
    const { h, runner, start } = await running();
    const parked = await start('aniya');
    const busy = await start('bryn');
    await h.request('POST', `/v1/ferrets/${parked}/signal`, { body: { kind: 'waiting' } });
    const answer = (await ask(h, { scope: 'all' })).json<RestartResult>();
    expect(answer.restarted.map(entry => entry.id)).toEqual([parked]);
    expect(answer.queued.map(entry => [entry.id, entry.reason])).toEqual([[busy, 'mid-turn']]);
    expect(runner.starts).toBe(3);
    await h.stop();
  });

  test('R-0128 GET /v1/restarts answers the waiting restarts: empty at first, then the queued ferret with its reason', async () => {
    const { h, start } = await running();
    const empty = await h.request('GET', '/v1/restarts');
    expect(empty.status).toBe(200);
    expect(empty.json<RestartStatus>().queued).toEqual([]);
    const id = await start('aniya');
    await ask(h, { scope: 'ids', ids: [id] });
    const waiting = await h.request('GET', '/v1/restarts');
    expect(waiting.status).toBe(200);
    expect(waiting.json<RestartStatus>().queued).toMatchObject([{ id, name: 'aniya', reason: 'mid-turn' }]);
    await h.stop();
  });

  test('R-0023 the owner clears the queue and is told how many were waiting', async () => {
    const { h, start } = await running();
    const id = await start('aniya');
    await ask(h, { scope: 'ids', ids: [id] });
    const cleared = await h.request('DELETE', '/v1/restarts');
    expect(cleared.json<{ cancelled: number }>()).toEqual({ cancelled: 1 });
    expect((await h.request('GET', '/v1/restarts')).json<RestartStatus>().queued).toEqual([]);
    await h.stop();
  });
});

describe('who a restart is journalled as (G12), through the real route, adapter and files', () => {
  test('a connector is preserved in both immediate and queued session.restarted journal writes', async () => {
    const grant = 'cg_abcdefghij';
    const h = await host([], {
      harness: new FakeHarness(),
      runner: new FakeRunner(),
      standing: () => ({
        ...ownerStanding(),
        actor: connectorActor(grant),
        credential: { kind: 'authenticated', tokenClass: 'connector', grant },
      }),
    });
    try {
      const start = await h.request('POST', '/v1/ferrets', {
        body: { name: 'aniya', folder: '/work/aniya' },
        headers: { 'x-fy-request-id': randomUUID() },
      });
      expect(start.status).toBe(201);
      const { id } = start.json<{ id: string }>();
      const queued = await ask(h, { scope: 'ids', ids: [id] });
      expect(queued.json<RestartResult>().queued).toHaveLength(1);
      expect(JSON.parse(h.state('ferrets').raw(RestartsFile) as string).queued[0].requestedBy).toBe(
        `connector:${grant}`,
      );
      await h.request('POST', `/v1/ferrets/${id}/signal`, { body: { kind: 'waiting' } });
      await h.runJob('restart-drain');
      await h.request('POST', `/v1/ferrets/${id}/signal`, { body: { kind: 'waiting' } });
      expect((await ask(h, { scope: 'ids', ids: [id] })).json<RestartResult>().restarted).toHaveLength(1);
      const rows = (h.state('ferrets').raw(FerretHistoryFiles, id) as string)
        .trim()
        .split('\n')
        .map(line => JSON.parse(line));
      expect(rows.filter(row => row.type === 'session.restarted').map(row => row.data.requestedBy)).toEqual([
        `connector:${grant}`,
        `connector:${grant}`,
      ]);
    } finally {
      await h.stop();
    }
  });

  test('G12 an immediate restart by the owner is journalled as the owner', async () => {
    const { h, start } = await running();
    const id = await start('aniya');
    await h.request('POST', `/v1/ferrets/${id}/signal`, { body: { kind: 'waiting', condition: 'CI' } });
    const answer = await ask(h, { scope: 'ids', ids: ['aniya'] });
    expect(answer.json<RestartResult>().restarted).toEqual([{ id, name: 'aniya' }]);
    const lines = (h.state('ferrets').raw(FerretHistoryFiles, id) as string)
      .split('\n')
      .filter(line => line !== '')
      .map(line => JSON.parse(line) as { type: string; data?: { requestedBy?: string } });
    expect(lines.find(line => line.type === 'session.restarted')?.data?.requestedBy).toBe('owner');
    await h.stop();
  });

  test('G12 a ferret restarting itself is queued as that ferret\u2019s session, with an agent origin naming it', async () => {
    const { h, start } = await running();
    const id = await start('aniya');
    const self = await ask(h, { scope: 'ids', ids: [id] }, id);
    expect(self.json<RestartResult>().queued).toEqual([{ id, name: 'aniya', reason: 'own-session' }]);
    const kept = JSON.parse(h.state('ferrets').raw(RestartsFile) as string) as {
      queued: { id: string; requestedBy?: string; origin?: unknown }[];
    };
    expect(kept.queued.map(entry => ({ id: entry.id, requestedBy: entry.requestedBy, origin: entry.origin }))).toEqual([
      { id, requestedBy: `session:${id}`, origin: { kind: 'agent', ferret: id } },
    ]);
    await h.stop();
  });
});

describe('who may restart', () => {
  test('G43 R-0323 a ferret restarts itself, which waits for its own turn to end, and not the whole fleet', async () => {
    const { h, runner, start } = await running();
    const id = await start('aniya');
    const other = await start('bryn');
    const self = await ask(h, { scope: 'ids', ids: [id], caller: other }, id);
    // Its credential, not the body, says who is asking: a ferret cannot restart itself mid-turn by claiming another.
    expect(self.json<RestartResult>().queued).toEqual([{ id, name: 'aniya', reason: 'own-session' }]);
    expect(runner.starts).toBe(2);
    // `when: now` does not take a ferret past its own turn: it still waits for it to end.
    const selfNow = await ask(h, { scope: 'ids', ids: [id], when: 'now' }, id);
    expect(selfNow.json<RestartResult>().queued).toEqual([{ id, name: 'aniya', reason: 'own-session' }]);
    expect(runner.starts).toBe(2);
    const fleet = await ask(h, { scope: 'all' }, id);
    expect(fleet.status).toBe(403);
    const stranger = await ask(h, { scope: 'ids', ids: [other] }, id);
    expect(stranger.status).toBe(403);
    await h.stop();
  });

  test('G43 R-0323 a name two running ferrets hold restarts neither: a ferret caller is refused and no restart is made', async () => {
    const { h, runner, start } = await running();
    const first = await start('aniya');
    await h.request('POST', `/v1/ferrets/${first}/stop`, { body: {} });
    // Its reservation aged out of the callsign window, so the name is free for the next start.
    await h.clock.advance(5 * 24 * 60 * 60 * 1_000 + 1_000);
    const second = await start('aniya');
    // A stopped ferret may be resumed under a name another now holds, so two are running on one footing.
    expect((await h.request('POST', `/v1/ferrets/${first}/resume`)).status).toBe(200);
    const starts = runner.starts;
    const named = await ask(h, { scope: 'ids', ids: ['aniya'] }, second);
    expect(named.status).toBe(403);
    expect(runner.starts).toBe(starts);
    expect((await h.request('GET', '/v1/restarts')).json<RestartStatus>().queued).toEqual([]);
    await h.stop();
  });

  test('G43 R-0323 a ferret naming itself by its one name is cleared and the service is handed its resolved id', async () => {
    const { h, start } = await running();
    const id = await start('aniya');
    const answer = await ask(h, { scope: 'ids', ids: ['aniya'] }, id);
    expect(answer.status).toBe(200);
    expect(answer.json<RestartResult>().queued).toEqual([{ id, name: 'aniya', reason: 'own-session' }]);
    await h.stop();
  });

  test('G43 R-0023 a ferret does not clear the queue of every ferret', async () => {
    const { h, start } = await running();
    const id = await start('aniya');
    const cleared = await h.request('DELETE', '/v1/restarts', as(id));
    expect(cleared.status).toBe(403);
    await h.stop();
  });
});

describe('a restart proves the runtime can start BEFORE it stops the old harness', () => {
  const SIGN_IN = 'runtime rt was not started: Login codex-main needs sign-in';
  /** A Runtimes stand-in whose one runtime `rt` needs sign-in until the test signs it in. */
  const runtimes = (login: { signedIn: boolean }) =>
    implementDaemon(
      definePlugin({
        id: 'runtimes',
        title: 'Runtimes (fake)',
        version: '5.0.0',
        api: 5,
        core: false,
        kinds: [],
        hooks: { takes: [{ hook: RuntimeStart, key: RUNTIME_START_KEY }] },
      }),
      {
        build: () => ({
          hooks: {
            'runtime.start:runtimes': {
              login: async () => ({ ok: true }),
              resolve: async () =>
                login.signedIn
                  ? { ok: true, harness: 'claude-code', login: 'fake-login' }
                  : { ok: false, sentence: SIGN_IN },
            },
          },
        }),
      },
    );

  test('run 7: a ferret whose login needs sign-in keeps its harness running; the restart waits and then goes', async () => {
    const login = { signedIn: true };
    const runner = new FakeRunner();
    const harness = new FakeHarness();
    const stops: string[] = [];
    const stop = harness.stop.bind(harness);
    harness.stop = async (ferret, handle, using, how) => {
      stops.push(how);
      await stop(ferret, handle, using, how);
    };
    const h = await host([], { harness, runner, plugins: [runtimes(login), fakeLogins()] });
    const started = await h.request('POST', '/v1/ferrets', {
      body: { name: 'wells', folder: '/work/wells', runtime: 'rt' },
      headers: { 'x-fy-request-id': randomUUID() },
    });
    expect(started.status).toBe(201);
    const id = started.json<{ id: string }>().id;
    await h.request('POST', `/v1/ferrets/${id}/signal`, { body: { kind: 'waiting', condition: 'CI' } });
    const before = (await h.request('GET', `/v1/ferrets/${id}`)).json<FerretSummary>();

    login.signedIn = false;
    const blocked = await ask(h, { scope: 'ids', ids: ['wells'] });
    expect(blocked.status).toBe(200);
    expect(blocked.json<RestartResult>()).toMatchObject({
      restarted: [],
      queued: [{ id, name: 'wells', reason: 'blocked' }],
      failed: [],
    });
    // The old harness was never stopped: same pane, still live, the ferret not stopped.
    expect(stops).toEqual([]);
    const during = (await h.request('GET', `/v1/ferrets/${id}`)).json<FerretSummary>();
    expect(during.state).not.toBe('stopped');
    expect(during.state).toBe(before.state);
    expect(runner.starts).toBe(1);
    // Said once in its history, with the reason the owner can act on; nothing says it was stopped.
    expect(history(h, id)).toEqual(['session.waiting', 'session.restart_blocked']);
    expect((h.state('ferrets').raw(FerretHistoryFiles, id) as string).includes('needs sign-in')).toBe(true);
    // Still waiting, durably, as blocked.
    const status = (await h.request('GET', '/v1/restarts')).json<RestartStatus>();
    expect(status.queued.map(entry => [entry.id, entry.reason])).toEqual([[id, 'blocked']]);

    // The owner signs the login in: the next restart goes, stopping the old harness outright first.
    login.signedIn = true;
    const done = await ask(h, { scope: 'ids', ids: ['wells'] });
    expect(done.json<RestartResult>()).toMatchObject({ restarted: [{ id, name: 'wells' }], queued: [], failed: [] });
    expect(stops).toEqual(['now']);
    expect(runner.starts).toBe(2);
    expect(history(h, id).filter(type => type === 'session.restart_blocked')).toHaveLength(1);
    expect(history(h, id).at(-1)).toBe('session.restarted');
    await h.stop();
  });
});
