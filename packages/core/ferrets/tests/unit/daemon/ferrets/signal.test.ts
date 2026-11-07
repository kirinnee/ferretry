import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { TestHost } from '@ferretry/kernel/testing';
import { FerretHistoryFiles, FerretsChanged, FerretsPort, type FerretSummary } from '../../../../contract/index.ts';
import { FakeHarness, FakeRunner, ferretId } from '../../../../contract/testing/index.ts';
import { FerretSummaryFiles, FerretWaitFiles } from '../../../../daemon/lib/state.ts';
import { as, host, record } from './route-fixture.ts';

/**
 * R-0371 (today's `mounts/session-signal.ts`): a ferret says what it is doing, and the daemon records it. The
 * decisions are today's `SessionSignalService`; these tests drive it through the route over Ferrets' own records.
 */

const SIGNAL = (id: string) => `/v1/ferrets/${id}/signal`;
const say = async (h: TestHost, id: string, body: unknown, who?: string) =>
  await h.request('POST', SIGNAL(id), { body, ...(who === undefined ? {} : as(who)) });

async function started(h: TestHost, body: Record<string, unknown> = {}): Promise<string> {
  const answer = await h.request('POST', '/v1/ferrets', {
    body: { folder: '/work/a', ...body },
    headers: { 'x-fy-request-id': randomUUID() },
  });
  expect(answer.status).toBe(201);
  return answer.json<{ id: string }>().id;
}
const running = async (records = [] as ReturnType<typeof record>[]) =>
  await host(records, { harness: new FakeHarness(), runner: new FakeRunner() });
const history = (h: TestHost, id: string): { type: string; data: Record<string, unknown> }[] =>
  (h.state('ferrets').raw(FerretHistoryFiles, id) as string)
    .split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line) as { type: string; data: Record<string, unknown> });
const summary = async (h: TestHost, id: string) => (await h.request('GET', `/v1/ferrets/${id}`)).json<FerretSummary>();

describe('signal done', () => {
  test('R-0371 a ferret that says done hands back its summary and is stopped, in that order', async () => {
    const h = await running();
    const id = await started(h);
    const answer = await say(h, id, { kind: 'done', message: 'shipped the thing' }, id);
    expect(answer.status).toBe(200);
    expect(answer.json<FerretSummary>()).toMatchObject({ id, state: 'stopped' });
    expect(await h.provided(FerretsPort).summary(ferretId(id))).toBe('shipped the thing\n');
    expect(history(h, id).map(event => event.type)).toEqual(['session.stopped', 'session.completed']);
    expect(history(h, id)[0]?.data).toEqual({ reason: 'completion' });
    const states = h.published
      .filter(event => event.event === FerretsChanged.name)
      .map(event => event.payload as { ferret: string; state: string })
      .filter(change => change.ferret === id)
      .map(change => change.state);
    expect(states.at(-1)).toBe('stopped');
    await h.stop();
  });

  test('R-0371 a ferret that said done is finished; one the owner stopped, or that resumed, is not', async () => {
    const h = await running();
    const finished = await started(h, { name: 'aniya' });
    const stopped = await started(h, { name: 'bryn', folder: '/work/b' });
    await say(h, finished, { kind: 'done', message: 'shipped' });
    await h.request('POST', `/v1/ferrets/${stopped}/stop`, { body: {} });
    expect((await summary(h, finished)).finishedAt).toBeString();
    expect((await summary(h, stopped)).finishedAt).toBeUndefined();
    // It survives the daemon's restart, and a resume ends it.
    const again = await h.restart();
    expect((await summary(again, finished)).finishedAt).toBeString();
    await again.clock.advance(1_000);
    await again.request('POST', `/v1/ferrets/${finished}/resume`, { body: {} });
    expect((await summary(again, finished)).finishedAt).toBeUndefined();
    // Stopped by the owner after that, it did not finish.
    await again.clock.advance(1_000);
    await again.request('POST', `/v1/ferrets/${finished}/stop`, { body: {} });
    expect((await summary(again, finished)).finishedAt).toBeUndefined();
    await again.stop();
  });

  test('R-0371 a done with no message still leaves a summary file, never an absence', async () => {
    const h = await running();
    const id = await started(h);
    await say(h, id, { kind: 'done' });
    expect(await h.provided(FerretsPort).summary(ferretId(id))).toBe('Task completed; inspect chat and repository diff.\n');
    await h.stop();
  });

  test('R-0371 the summary is written before the process is touched, so a stop that cannot reach its harness leaves the evidence', async () => {
    // No harness or runner plugin: the stop of a ferret holding a pane answers 503 and keeps it live.
    const h = await host([{ ...record('lead'), handle: 'pane-lead' }]);
    const answer = await say(h, 'lead', { kind: 'done', message: 'evidence' });
    expect(answer.status).toBe(503);
    expect(new TextDecoder().decode(h.state('ferrets').rawBytes(FerretSummaryFiles, 'lead'))).toBe('evidence\n');
    expect((await summary(h, 'lead')).state).toBe('working');
    // The ferret did not finish, so what it wrote is not yet its report.
    expect(await h.provided(FerretsPort).summary(ferretId('lead'))).toBeUndefined();
    await h.stop();
  });
});

describe('signal waiting and working', () => {
  test('R-0371 a declared wait shows on the ferret, keeps it running, and survives a restart of the daemon', async () => {
    const h = await running();
    const id = await started(h);
    const answer = await say(h, id, { kind: 'waiting', until: '45m', condition: 'CI run' }, id);
    expect(answer.status).toBe(200);
    const view = answer.json<FerretSummary>();
    expect(view.state).toBe('working');
    expect(view.waiting).toMatchObject({ condition: 'CI run' });
    expect(Date.parse(view.waiting?.until ?? '') - Date.parse(view.waiting?.since ?? '')).toBe(45 * 60_000);
    expect((await summary(h, id)).waiting?.condition).toBe('CI run');
    const again = await h.restart();
    expect((await summary(again, id)).waiting?.condition).toBe('CI run');
    await again.stop();
  });

  test('R-0371 a deadline further out than the backstop is clamped to it, and a number alone is refused', async () => {
    const h = await running();
    const id = await started(h);
    const clamped = (await say(h, id, { kind: 'waiting', until: '48h' })).json<FerretSummary>().waiting;
    expect(Date.parse(clamped?.until ?? '') - Date.parse(clamped?.since ?? '')).toBe(4 * 60 * 60_000);
    const typo = await say(h, id, { kind: 'waiting', until: '45' });
    expect(typo.status).toBe(400);
    expect(typo.json<{ code: string }>().code).toBe('invalid_request');
    await h.stop();
  });

  test('R-0371 working ends the wait and credits the parked time back', async () => {
    const h = await running();
    const id = await started(h);
    await say(h, id, { kind: 'waiting', condition: 'build' });
    const cleared = await say(h, id, { kind: 'working' });
    expect(cleared.status).toBe(200);
    expect(cleared.json<FerretSummary>().waiting).toBeUndefined();
    const stored = JSON.parse(h.state('ferrets').raw(FerretWaitFiles, id) as string) as { creditSeconds?: number };
    expect(stored.creditSeconds).toBeGreaterThanOrEqual(0);
    expect(history(h, id).map(event => event.type)).toEqual(['session.waiting', 'session.waiting_cleared']);
    // Working with no wait writes nothing more.
    await say(h, id, { kind: 'working' });
    expect(history(h, id).length).toBe(2);
    await h.stop();
  });

  test('R-0371 a wait on a peer resolves the peer’s name to its id and refuses a peer that is nobody or itself', async () => {
    const h = await running();
    const id = await started(h, { name: 'aniya' });
    const other = await started(h, { name: 'bryn', folder: '/work/b' });
    const parked = (await say(h, id, { kind: 'waiting', peer: 'bryn' })).json<FerretSummary>();
    expect(parked.waiting).toMatchObject({ peer: other, peerName: 'bryn' });
    const nobody = await say(h, id, { kind: 'waiting', peer: 'haydn' });
    expect([nobody.status, nobody.json<{ code: string }>().code]).toEqual([404, 'unknown_peer']);
    const itself = await say(h, id, { kind: 'waiting', peer: 'aniya' });
    expect([itself.status, itself.json<{ code: string }>().code]).toEqual([409, 'signal_refused']);
    await h.stop();
  });

  test('R-0371 a stopped ferret may not declare a wait', async () => {
    const h = await running();
    const id = await started(h);
    await h.request('POST', `/v1/ferrets/${id}/stop`, { body: {} });
    const answer = await say(h, id, { kind: 'waiting' });
    expect([answer.status, answer.json<{ code: string }>().code]).toEqual([409, 'signal_refused']);
    await h.stop();
  });

  test('R-0371 every change of a wait is published, so a watcher sees it without polling', async () => {
    const h = await running();
    const id = await started(h);
    const before = h.published.filter(event => event.event === FerretsChanged.name).length;
    await say(h, id, { kind: 'waiting' });
    await say(h, id, { kind: 'working' });
    expect(h.published.filter(event => event.event === FerretsChanged.name).length).toBe(before + 2);
    await h.stop();
  });
});

describe('signal help', () => {
  test('R-0371 an interactive ferret that asks leaves a question on its history and carries on', async () => {
    const h = await running();
    const id = await started(h, { mode: 'interactive' });
    const answer = await say(h, id, { kind: 'help', message: 'which database?' });
    expect(answer.status).toBe(200);
    expect(answer.json<FerretSummary>().state).toBe('working');
    expect(history(h, id).map(event => [event.type, event.data.message ?? event.data.reason])).toEqual([
      ['interaction.question', 'which database?'],
      ['interaction.help', 'which database?'],
    ]);
    await h.stop();
  });

  test('R-0371 an automode ferret that asks a human has nobody to answer, so it fails loudly and is stopped', async () => {
    const h = await running();
    const id = await started(h, { mode: 'auto', prompt: 'do the work' });
    const answer = await say(h, id, { kind: 'help', message: 'which database?' });
    expect(answer.json<FerretSummary>().state).toBe('stopped');
    expect(history(h, id).map(event => event.type)).toEqual([
      'interaction.question',
      'session.stopped',
      'session.protocol_violation',
    ]);
    await h.stop();
  });
});

describe('who may signal', () => {
  test('G43 R-0371 a ferret signals for itself and its helpers and for no other ferret', async () => {
    const h = await running([record('lead'), record('helper', 'lead'), record('stranger')]);
    expect((await say(h, 'lead', { kind: 'waiting' }, 'lead')).status).toBe(200);
    expect((await say(h, 'helper', { kind: 'done' }, 'lead')).status).toBe(200);
    expect((await say(h, 'stranger', { kind: 'done' }, 'lead')).status).toBe(403);
    expect((await say(h, 'lead', { kind: 'done' }, 'helper')).status).toBe(403);
    // The owner at the machine signals for any ferret.
    expect((await say(h, 'stranger', { kind: 'working' })).status).toBe(200);
    await h.stop();
  });

  test('R-0371 an unknown ferret is 404 and a body with no kind is 400', async () => {
    const h = await running([record('lead')]);
    expect((await say(h, 'nobody', { kind: 'done' })).status).toBe(404);
    expect((await say(h, 'lead', {})).status).toBe(400);
    await h.stop();
  });
});
