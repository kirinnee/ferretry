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
import { FakeHarness, FakeRunner } from '../../../../contract/testing/index.ts';
import { as, host } from './route-fixture.ts';

/**
 * R-0323, R-0128, R-0023 (today's `mounts/session-restart.ts`): restart ferrets on the same login with their
 * conversation kept, never forced past a ferret that is busy.
 */

const ask = async (h: TestHost, body: unknown, who?: string) =>
  await h.request('POST', '/v1/restarts', { body, ...(who === undefined ? {} : as(who)) });

async function running() {
  const runner = new FakeRunner();
  const h = await host([], { harness: new FakeHarness(), runner });
  const start = async (name: string): Promise<string> => {
    const answer = await h.request('POST', '/v1/ferrets', {
      body: { name, folder: `/work/${name}` },
      headers: { 'x-fy-request-id': randomUUID() },
    });
    expect(answer.status).toBe(201);
    return answer.json<{ id: string }>().id;
  };
  return { h, runner, start };
}
const history = (h: TestHost, id: string): string[] =>
  (h.state('ferrets').raw(FerretHistoryFiles, id) as string)
    .split('\n')
    .filter(line => line !== '')
    .map(line => (JSON.parse(line) as { type: string }).type);

describe('restarting ferrets', () => {
  test('R-0323 a ferret on a declared wait is restarted now: stopped and resumed on the same harness', async () => {
    const { h, runner, start } = await running();
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
    expect(history(h, id)).toEqual(['session.waiting', 'session.stopped', 'session.resumed', 'session.restarted']);
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
      expect(history(h, old)).toEqual(['session.waiting', 'session.stopped', 'session.resumed', 'session.restarted']);
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

describe('who may restart', () => {
  test('G43 R-0323 a ferret restarts itself, which waits for its own turn to end, and not the whole fleet', async () => {
    const { h, runner, start } = await running();
    const id = await start('aniya');
    const other = await start('bryn');
    const self = await ask(h, { scope: 'ids', ids: [id], caller: other }, id);
    // Its credential, not the body, says who is asking: a ferret cannot restart itself mid-turn by claiming another.
    expect(self.json<RestartResult>().queued).toEqual([{ id, name: 'aniya', reason: 'own-session' }]);
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
