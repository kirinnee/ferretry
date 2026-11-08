import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { TestHost } from '@ferretry/kernel/testing';
import {
  FerretHistoryFiles,
  type FerretSummary,
  type RestartResult,
  type RestartStatus,
  NamesFile,
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

  test('R-0323 a restart that matched nothing out of date says it cannot look, rather than that nothing was', async () => {
    const { h } = await running();
    const answer = await ask(h, { scope: 'outdated' });
    expect(answer.status).toBe(503);
    expect(answer.json<{ code: string }>().code).toBe('plugin_unavailable');
    await h.stop();
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
    h.state('ferrets').plant(NamesFile, JSON.stringify({ format: 1, claims: [] }));
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
