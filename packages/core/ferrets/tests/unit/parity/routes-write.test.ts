import { describe, expect, test } from 'bun:test';
import type { TestHost } from '@ferretry/kernel/testing';
import {
  AgentPinsFile,
  FerretFiles,
  FerretHistoryFiles,
  type FerretId,
  FerretPinsFile,
  FerretsPort,
  type FerretSummary,
  FerretTokensFile,
  FerretWaitFiles,
} from '../../../contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../contract/testing/index.ts';
import { FY_REQUEST_ID_HEADER } from '../../../daemon/lib/protocol/headers.ts';
import { as, host, record } from '../daemon/ferrets/route-fixture.ts';

/**
 * The POST routes of Ferrets (R rows), each driven through the real handler on the host (`h.request`): the success
 * shape the descriptor promises, the refusals its minimum and caller imply, and the state the call leaves behind.
 *
 * Not here, and why (the lead has the list): send, sends/*, interrupt, composer, answer belong to Conversation,
 * permission and dialog to Claude Code; fork, handover, handover/cancel, conversion-preview, move, move/ask-to-stop-jobs
 * and the two worktree writes answer a refusal or a "not built yet" for every request this plugin can receive in 5.0.
 */

const startId = (n: string) => ({ [FY_REQUEST_ID_HEADER]: `parity-${n}` });
const world = async (records: ReturnType<typeof record>[] = []) => {
  const runner = new FakeRunner();
  const h = await host(records, { harness: new FakeHarness(), runner });
  return { h, runner };
};
const started = async (h: TestHost, name: string): Promise<FerretId> => {
  const answer = await h.request('POST', '/v1/ferrets', {
    headers: startId(name),
    body: { folder: `/work/${name}`, name },
  });
  expect(answer.status).toBe(201);
  return answer.json<{ id: FerretId }>().id;
};
const view = async (h: TestHost, id: string) => (await h.request('GET', `/v1/ferrets/${id}`)).json<FerretSummary>();
const events = (h: TestHost, id: string) =>
  (h.state('ferrets').raw(FerretHistoryFiles, id) ?? '')
    .split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line) as { type: string; data: Record<string, unknown> });
const codeOf = (answer: { json<T>(): T }) => answer.json<{ code: string }>().code;

describe('R-0332 POST /v1/ferrets starts a ferret', () => {
  test('R-0332 answers 201 { id } and leaves the record, one token digest and one running pane behind', async () => {
    const { h, runner } = await world();
    const answer = await h.request('POST', '/v1/ferrets', {
      headers: startId('a'),
      body: { folder: '/work/a', name: 'wren' },
    });
    expect(answer.status).toBe(201);
    const { id } = answer.json<{ id: FerretId }>();
    expect(Object.keys(answer.json<object>())).toEqual(['id']);
    expect(JSON.parse(h.state('ferrets').raw(FerretFiles, id) as string)).toMatchObject({
      format: 1,
      id,
      name: 'wren',
      folder: '/work/a',
    });
    const tokens = h.state('ferrets').raw(FerretTokensFile) as string;
    expect(tokens).not.toContain('fys_');
    expect((JSON.parse(tokens) as { tokens: { ferret: string }[] }).tokens.map(token => token.ferret)).toEqual([id]);
    expect(runner.starts).toBe(1);
    expect(await view(h, id)).toMatchObject({ id, name: 'wren', state: 'working' });
    await h.stop();
  });

  test('R-0332 refuses a start with no request id (400 missing_request_id), no folder (400) or a name a running ferret holds (409)', async () => {
    const { h, runner } = await world();
    await started(h, 'wren');
    const noId = await h.request('POST', '/v1/ferrets', { body: { folder: '/work/b', name: 'bryn' } });
    expect([noId.status, codeOf(noId)]).toEqual([400, 'missing_request_id']);
    const noFolder = await h.request('POST', '/v1/ferrets', { headers: startId('n'), body: { name: 'bryn' } });
    expect([noFolder.status, codeOf(noFolder)]).toEqual([400, 'invalid_request']);
    const taken = await h.request('POST', '/v1/ferrets', {
      headers: startId('t'),
      body: { folder: '/work/z', name: 'wren' },
    });
    expect([taken.status, codeOf(taken)]).toEqual([409, 'refused']);
    expect(runner.starts).toBe(1);
    expect((await h.request('GET', '/v1/ferrets')).json<unknown[]>()).toHaveLength(1);
    await h.stop();
  });

  test('R-0332 a retry under the same request id answers the ferret already started, and another body under it is a 409', async () => {
    const { h, runner } = await world();
    const id = await started(h, 'wren');
    const body = { folder: '/work/wren', name: 'wren' };
    const again = await h.request('POST', '/v1/ferrets', { headers: startId('wren'), body });
    expect([again.status, again.json<{ id: string }>().id]).toEqual([200, id]);
    const other = await h.request('POST', '/v1/ferrets', {
      headers: startId('wren'),
      body: { folder: '/work/other', name: 'wren' },
    });
    expect([other.status, codeOf(other)]).toEqual([409, 'request_id_reused']);
    expect(runner.starts).toBe(1);
    await h.stop();
  });

  test('R-0332 a ferret starts only its own helpers, and a helper under a parent that does not exist is a 404', async () => {
    const { h } = await world([record('lead'), record('other')]);
    const mismatch = await h.request('POST', '/v1/ferrets', {
      ...as('lead'),
      headers: { ...as('lead').headers, ...startId('m') },
      body: { folder: '/work/c', parent: 'other' },
    });
    expect([mismatch.status, codeOf(mismatch)]).toEqual([403, 'parent_mismatch']);
    const ghost = await h.request('POST', '/v1/ferrets', {
      headers: startId('g'),
      body: { folder: '/work/e', parent: 'ghost' },
    });
    expect([ghost.status, codeOf(ghost)]).toEqual([404, 'unknown_parent']);
    await h.stop();
  });
});

describe('R-0372 R-0363 POST /v1/ferrets/:ferretId/stop and /resume', () => {
  test('R-0372 a stop answers { id, state: stopped }, retires the pane and writes session.stopped with the reason', async () => {
    const { h, runner } = await world();
    const id = await started(h, 'wren');
    const handle = await h.provided(FerretsPort).handle(id);
    expect(handle).toBeDefined();
    expect(await runner.alive(handle as never)).toBe(true);
    const stopped = await h.request('POST', `/v1/ferrets/${id}/stop`, { body: { reason: 'shift over' } });
    expect(stopped.status).toBe(200);
    expect(stopped.json<object>()).toEqual({ id, state: 'stopped' });
    expect(await runner.alive(handle as never)).toBe(false);
    expect((await view(h, id)).state).toBe('stopped');
    expect(events(h, id).map(event => [event.type, event.data])).toEqual([
      ['session.stopped', { reason: 'shift over' }],
    ]);
    // A second stop changes nothing.
    const again = await h.request('POST', `/v1/ferrets/${id}/stop`, { body: {} });
    expect(again.json<object>()).toEqual({ id, state: 'stopped' });
    expect(events(h, id)).toHaveLength(1);
    await h.stop();
  });

  test('R-0372 a stop is refused for an empty reason (400), an unknown ferret (404) and a ferret that is neither the caller nor its helper (403)', async () => {
    const { h } = await world([record('lead'), record('helper', 'lead'), record('stranger')]);
    expect((await h.request('POST', '/v1/ferrets/lead/stop', { body: { reason: '' } })).status).toBe(400);
    const ghost = await h.request('POST', '/v1/ferrets/ghost/stop', { body: {} });
    expect([ghost.status, codeOf(ghost)]).toEqual([404, 'not-found']);
    const refused = await h.request('POST', '/v1/ferrets/lead/stop', as('helper'));
    expect([refused.status, codeOf(refused)]).toEqual([403, 'forbidden']);
    expect((await view(h, 'lead')).state).toBe('working');
    const own = await h.request('POST', '/v1/ferrets/helper/stop', as('lead'));
    expect(own.json<{ state: string }>().state).toBe('stopped');
    expect((await h.request('POST', '/v1/ferrets/stranger/stop', as('lead'))).status).toBe(403);
    await h.stop();
  });

  test('R-0363 a resume answers { id }, starts a pane again, writes session.resumed with the message and brings the ferret back to working', async () => {
    const { h, runner } = await world();
    const id = await started(h, 'wren');
    await h.request('POST', `/v1/ferrets/${id}/stop`, { body: {} });
    const resumed = await h.request('POST', `/v1/ferrets/${id}/resume`, { body: { message: 'carry on' } });
    expect(resumed.status).toBe(200);
    expect(resumed.json<object>()).toEqual({ id });
    expect(runner.starts).toBe(2);
    expect((await view(h, id)).state).toBe('working');
    expect(events(h, id).map(event => [event.type, event.data])).toEqual([
      ['session.stopped', { reason: 'stopped by client' }],
      ['session.resumed', { message: 'carry on' }],
    ]);
    await h.stop();
  });

  test('R-0363 a resume is refused for an unknown field (400), an unknown ferret (404) and a ferret that is not the caller or its helper (403)', async () => {
    const { h } = await world([record('lead'), record('stranger')]);
    expect((await h.request('POST', '/v1/ferrets/lead/resume', { body: { note: 'x' } })).status).toBe(400);
    const ghost = await h.request('POST', '/v1/ferrets/ghost/resume', { body: {} });
    expect([ghost.status, codeOf(ghost)]).toEqual([404, 'not-found']);
    const refused = await h.request('POST', '/v1/ferrets/lead/resume', as('stranger'));
    expect([refused.status, codeOf(refused)]).toEqual([403, 'forbidden']);
    await h.stop();
  });
});

describe('R-0362 POST /v1/ferrets/:ferretId/rename', () => {
  test('R-0362 a rename answers the ferret under its new name, and the list and the ledger show it', async () => {
    const { h } = await world();
    const id = await started(h, 'wren');
    const renamed = await h.request('POST', `/v1/ferrets/${id}/rename`, { body: { name: 'piper' } });
    expect(renamed.status).toBe(200);
    expect(renamed.json<FerretSummary>()).toMatchObject({ id, name: 'piper', state: 'working' });
    expect((await h.request('GET', '/v1/ferrets')).json<FerretSummary[]>().map(each => each.name)).toEqual(['piper']);
    expect(JSON.parse(h.state('ferrets').files.get('names.json') as string)).toMatchObject({
      claims: [{ callsign: 'piper', ownerId: id }],
    });
    const titled = await h.request('POST', `/v1/ferrets/${id}/rename`, { body: { title: 'Ship it' } });
    expect(titled.json<FerretSummary>()).toMatchObject({ name: 'piper', title: 'Ship it' });
    await h.stop();
  });

  test('R-0362 a rename is refused for a name a running ferret holds (409 name_taken), an empty body (400), an unknown ferret (404) and a ferret not the caller or its helper (403)', async () => {
    const { h } = await world();
    const wren = await started(h, 'wren');
    const bryn = await started(h, 'bryn');
    const taken = await h.request('POST', `/v1/ferrets/${wren}/rename`, { body: { name: 'bryn' } });
    expect([taken.status, codeOf(taken)]).toEqual([409, 'name_taken']);
    expect((await h.request('POST', `/v1/ferrets/${wren}/rename`, { body: { name: '' } })).status).toBe(400);
    const ghost = await h.request('POST', '/v1/ferrets/ghost/rename', { body: { name: 'q' } });
    expect([ghost.status, codeOf(ghost)]).toEqual([404, 'not-found']);
    const refused = await h.request('POST', `/v1/ferrets/${bryn}/rename`, { ...as(wren), body: { name: 'piper' } });
    expect([refused.status, codeOf(refused)]).toEqual([403, 'forbidden']);
    expect((await view(h, wren)).name).toBe('wren');
    expect((await view(h, bryn)).name).toBe('bryn');
    await h.stop();
  });
});

describe('R-0364 POST /v1/ferrets/:ferretId/revoke-credential', () => {
  test('R-0364 answers { id, revoked } and marks the token revoked; a second call finds none live; it never answers a token or digest', async () => {
    const { h } = await world();
    const id = await started(h, 'wren');
    const revoked = await h.request('POST', `/v1/ferrets/${id}/revoke-credential`);
    expect(revoked.status).toBe(200);
    expect(revoked.json<object>()).toEqual({ id, revoked: true });
    expect(revoked.body).not.toContain('fys_');
    const stored = JSON.parse(h.state('ferrets').raw(FerretTokensFile) as string) as { tokens: { revoked?: true }[] };
    expect(stored.tokens.length).toBeGreaterThan(0);
    expect(stored.tokens.every(token => token.revoked === true)).toBe(true);
    const again = await h.request('POST', `/v1/ferrets/${id}/revoke-credential`);
    expect(again.json<object>()).toEqual({ id, revoked: false });
    await h.stop();
  });

  test('R-0364 is a person’s act (a ferret is 403, even for itself) and an unknown ferret is a 404', async () => {
    const { h } = await world();
    const id = await started(h, 'wren');
    const byFerret = await h.request('POST', `/v1/ferrets/${id}/revoke-credential`, as(id));
    expect(byFerret.status).toBe(403);
    const live = JSON.parse(h.state('ferrets').raw(FerretTokensFile) as string) as { tokens: { revoked?: true }[] };
    expect(live.tokens.some(token => token.revoked !== true)).toBe(true);
    const ghost = await h.request('POST', '/v1/ferrets/ghost/revoke-credential');
    expect([ghost.status, codeOf(ghost)]).toEqual([404, 'not-found']);
    await h.stop();
  });
});

describe('R-0359 R-0382 POST /v1/ferrets/:ferretId/pin and /unpin', () => {
  const pinnedIds = (h: TestHost) =>
    (JSON.parse(h.state('ferrets').raw(AgentPinsFile) ?? '{"pins":[]}') as { pins: { sessionId: string }[] }).pins.map(
      pin => pin.sessionId,
    );

  test('R-0359 a pin answers the ferret with its pinnedAt, by id or by name, writes the owner pin list and is idempotent', async () => {
    const { h } = await world();
    const id = await started(h, 'wren');
    const pinned = await h.request('POST', `/v1/ferrets/${id}/pin`);
    expect(pinned.status).toBe(200);
    expect(pinned.json<FerretSummary>()).toMatchObject({ id, name: 'wren', pinnedAt: h.clock.now() });
    expect(pinnedIds(h)).toEqual([id]);
    expect((await view(h, id)).pinnedAt).toBe(h.clock.now());
    await h.clock.advance(1_000);
    const byName = await h.request('POST', '/v1/ferrets/wren/pin');
    expect(byName.json<FerretSummary>()).toMatchObject({ id, pinnedAt: pinned.json<FerretSummary>().pinnedAt });
    expect(pinnedIds(h)).toEqual([id]);
    await h.stop();
  });

  test('R-0359 a pin is a person’s act (a ferret is 403) and an unknown ferret is a 404 that pins nothing', async () => {
    const { h } = await world([record('lead'), record('helper', 'lead')]);
    expect((await h.request('POST', '/v1/ferrets/lead/pin', as('helper'))).status).toBe(403);
    expect((await h.request('POST', '/v1/ferrets/helper/pin', as('helper'))).status).toBe(403);
    const ghost = await h.request('POST', '/v1/ferrets/nobody/pin');
    expect([ghost.status, codeOf(ghost)]).toEqual([404, 'not-found']);
    expect(pinnedIds(h)).toEqual([]);
    await h.stop();
  });

  test('R-0382 an unpin answers the ferret without a pinnedAt, empties the owner pin list and is idempotent', async () => {
    const { h } = await world();
    const id = await started(h, 'wren');
    await h.request('POST', `/v1/ferrets/${id}/pin`);
    const unpinned = await h.request('POST', `/v1/ferrets/${id}/unpin`);
    expect(unpinned.status).toBe(200);
    expect(unpinned.json<FerretSummary>()).toMatchObject({ id, name: 'wren' });
    expect(unpinned.json<FerretSummary>().pinnedAt).toBeUndefined();
    expect(pinnedIds(h)).toEqual([]);
    expect((await view(h, id)).pinnedAt).toBeUndefined();
    const again = await h.request('POST', '/v1/ferrets/wren/unpin');
    expect([again.status, again.json<FerretSummary>().pinnedAt]).toEqual([200, undefined]);
    await h.stop();
  });

  test('R-0382 an unpin is a person’s act (a ferret is 403 and the pin stays) and an unknown ferret is a 404', async () => {
    const { h } = await world([record('lead'), record('helper', 'lead')]);
    await h.request('POST', '/v1/ferrets/lead/pin');
    expect((await h.request('POST', '/v1/ferrets/lead/unpin', as('helper'))).status).toBe(403);
    expect(pinnedIds(h)).toEqual(['lead']);
    const ghost = await h.request('POST', '/v1/ferrets/nobody/unpin');
    expect([ghost.status, codeOf(ghost)]).toEqual([404, 'not-found']);
    await h.stop();
  });
});

describe('R-0360 POST /v1/ferrets/:ferretId/pins', () => {
  type Board = {
    sessionId: string;
    pins: { id: string; kind: string; text?: string; by: string; createdBy: string | null }[];
  };
  const stored = (h: TestHost, id: string) => JSON.parse(h.state('ferrets').raw(FerretPinsFile, id) as string) as Board;

  test('R-0360 a person adds, edits and removes a note, each answer is the board, and pins.json follows it', async () => {
    const { h } = await world();
    const id = await started(h, 'wren');
    const added = await h.request('POST', `/v1/ferrets/${id}/pins`, {
      body: { action: 'add', kind: 'note', text: 'remember the plan' },
    });
    expect(added.status).toBe(200);
    const board = added.json<Board>();
    expect(board.sessionId).toBe(id);
    expect(board.pins).toHaveLength(1);
    expect(board.pins[0]).toMatchObject({ kind: 'note', text: 'remember the plan', by: 'human', createdBy: null });
    const pinId = board.pins[0]?.id as string;
    const edited = await h.request('POST', `/v1/ferrets/${id}/pins`, {
      body: { action: 'edit', id: pinId, text: 'remember the better plan' },
    });
    expect(edited.json<Board>().pins[0]?.text).toBe('remember the better plan');
    expect(stored(h, id).pins[0]?.text).toBe('remember the better plan');
    const removed = await h.request('POST', `/v1/ferrets/${id}/pins`, { body: { action: 'remove', id: pinId } });
    expect(removed.json<Board>().pins).toEqual([]);
    expect(stored(h, id).pins).toEqual([]);
    const read = await h.request('GET', `/v1/ferrets/${id}/pins`);
    expect(read.json<Board>().pins).toEqual([]);
    await h.stop();
  });

  test('R-0360 a ferret pins on its own board only, as an agent that names itself; another ferret’s board is a 403 that changes nothing', async () => {
    const { h } = await world();
    const wren = await started(h, 'wren');
    const bryn = await started(h, 'bryn');
    const own = await h.request('POST', `/v1/ferrets/${wren}/pins`, {
      ...as(wren),
      body: { action: 'add', kind: 'note', text: 'mine' },
    });
    expect(own.status).toBe(200);
    expect(own.json<Board>().pins[0]).toMatchObject({ by: 'agent', createdBy: wren });
    const other = await h.request('POST', `/v1/ferrets/${bryn}/pins`, {
      ...as(wren),
      body: { action: 'add', kind: 'note', text: 'not yours' },
    });
    expect([other.status, codeOf(other)]).toEqual([403, 'forbidden']);
    expect(h.state('ferrets').raw(FerretPinsFile, bryn)).toBeUndefined();
    await h.stop();
  });

  test('R-0360 refuses an action the schema does not know (400) and a ferret that does not exist (404)', async () => {
    const { h } = await world();
    const id = await started(h, 'wren');
    const bogus = await h.request('POST', `/v1/ferrets/${id}/pins`, { body: { action: 'bogus' } });
    expect([bogus.status, codeOf(bogus)]).toEqual([400, 'invalid_request']);
    const notJson = await h.request('POST', `/v1/ferrets/${id}/pins`, { body: '{ not json' });
    expect([notJson.status, codeOf(notJson)]).toEqual([400, 'invalid_json']);
    const ghost = await h.request('POST', '/v1/ferrets/ghost/pins', {
      body: { action: 'add', kind: 'note', text: 'x' },
    });
    expect([ghost.status, codeOf(ghost)]).toEqual([404, 'not-found']);
    expect(h.state('ferrets').raw(FerretPinsFile, id)).toBeUndefined();
    await h.stop();
  });
});

describe('R-0371 POST /v1/ferrets/:ferretId/signal', () => {
  const say = async (h: TestHost, id: string, body: unknown, who?: string) =>
    await h.request('POST', `/v1/ferrets/${id}/signal`, { body, ...(who === undefined ? {} : as(who)) });

  test('R-0371 done answers the stopped ferret, keeps its summary and writes session.stopped then session.completed', async () => {
    const { h } = await world();
    const id = await started(h, 'wren');
    const done = await say(h, id, { kind: 'done', message: 'shipped the thing' }, id);
    expect(done.status).toBe(200);
    expect(done.json<FerretSummary>()).toMatchObject({ id, state: 'stopped' });
    expect(await h.provided(FerretsPort).summary(id)).toBe('shipped the thing\n');
    expect(events(h, id).map(event => event.type)).toEqual(['session.stopped', 'session.completed']);
    await h.stop();
  });

  test('R-0371 waiting declares a wait that rides the ferret and working clears it', async () => {
    const { h } = await world();
    const id = await started(h, 'wren');
    const waiting = await say(h, id, { kind: 'waiting', until: '45m', condition: 'CI run' }, id);
    expect(waiting.status).toBe(200);
    expect(waiting.json<FerretSummary>()).toMatchObject({ state: 'working', waiting: { condition: 'CI run' } });
    expect(JSON.parse(h.state('ferrets').raw(FerretWaitFiles, id) as string)).toBeDefined();
    const working = await say(h, id, { kind: 'working' }, id);
    expect(working.json<FerretSummary>().waiting).toBeUndefined();
    expect(events(h, id).map(event => event.type)).toEqual(['session.waiting', 'session.waiting_cleared']);
    await h.stop();
  });

  test('R-0371 refuses an unknown kind (400), a ferret that is nobody’s (404), a stopped ferret’s wait (409) and a stranger (403)', async () => {
    const { h } = await world();
    const id = await started(h, 'wren');
    const lead = await started(h, 'lead');
    const stranger = await started(h, 'stranger');
    const kind = await say(h, id, { kind: 'blocked', message: 'stuck' });
    expect([kind.status, codeOf(kind)]).toEqual([400, 'invalid_request']);
    const ghost = await say(h, 'ghost', { kind: 'working' });
    expect([ghost.status, codeOf(ghost)]).toEqual([404, 'not-found']);
    const refused = await say(h, lead, { kind: 'done' }, stranger);
    expect(refused.status).toBe(403);
    expect((await view(h, lead)).state).toBe('working');
    await h.request('POST', `/v1/ferrets/${id}/stop`, { body: {} });
    const stopped = await say(h, id, { kind: 'waiting' });
    expect([stopped.status, codeOf(stopped)]).toEqual([409, 'signal_refused']);
    await h.stop();
  });
});
