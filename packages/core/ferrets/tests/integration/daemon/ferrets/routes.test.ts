import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';

import { FakeGate, ferretStanding, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import type { ApiRequest, CallStanding } from '@ferretry/kernel/contract';
import { definePlugin } from '@ferretry/kernel/manifest';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { type TestHost, testHost } from '@ferretry/kernel/testing';
import {
  FerretFiles,
  FerretHistoryFiles,
  type FerretId,
  type FerretRecord,
  FerretsPort,
  FerretTokensFile,
  Harnesses,
  Runners,
} from '../../../../contract/index.ts';
import { FakeHarness, FakeRunner, ferretId, T0 } from '../../../../contract/testing/index.ts';
import ferrets from '../../../../daemon/index.ts';
import { FerretDetailsFiles } from '../../../../daemon/lib/state.ts';

/** Who calls: the `x-test-caller` header names a ferret (`ferret:<id>`), else the owner at the machine. */
const callerHeader = 'x-test-caller';
const standingFor = (request: ApiRequest): CallStanding => {
  const raw = request.headers.get(callerHeader);
  return raw?.startsWith('ferret:') === true ? ferretStanding(raw.slice(7) as FerretId) : ownerStanding();
};
const as = (ferret: string) => ({ headers: { [callerHeader]: `ferret:${ferret}` } });

const record = (id: string, parent?: string, folder = `/work/${id}`): FerretRecord => ({
  format: 1,
  id: ferretId(id),
  name: id,
  ...(parent === undefined ? {} : { parent: ferretId(parent) }),
  role: parent === undefined ? 'lead' : 'helper',
  harness: 'claude-code',
  runner: 'tmux',
  folder,
  state: 'working',
  createdAt: T0,
  stateAt: T0,
});

/** The two plugins on the security path that take Ferrets' provide hooks, as fakes with their real ids. */
const harnessPlugin = (harness: FakeHarness) =>
  implementDaemon(
    definePlugin({
      id: 'claude-code',
      title: 'Claude Code (fake)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: Harnesses, key: 'claude-code' }] },
    }),
    { build: () => ({ hooks: { 'harnesses:claude-code': harness } }) },
  );
const runnerPlugin = (runner: FakeRunner) =>
  implementDaemon(
    definePlugin({
      id: 'terminals',
      title: 'Terminals (fake)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: Runners, key: 'tmux' }] },
    }),
    { build: () => ({ hooks: { 'runners:tmux': runner } }) },
  );

async function host(
  records: readonly FerretRecord[] = [],
  extra: {
    readonly harness?: FakeHarness;
    readonly runner?: FakeRunner;
    readonly config?: Readonly<Record<string, unknown>>;
  } = {},
): Promise<TestHost> {
  const plugins = [
    ferrets,
    ...(extra.harness === undefined ? [] : [harnessPlugin(extra.harness)]),
    ...(extra.runner === undefined ? [] : [runnerPlugin(extra.runner)]),
  ];
  const first = await testHost({
    plugins,
    gate: new StandInAdmission(standingFor),
    fakes: { gate: new FakeGate(), vault: new FakeVault(), asks: new FakeAsks() },
    ...(extra.config === undefined ? {} : { config: extra.config }),
  });
  if (records.length === 0) return first;
  for (const each of records) first.state('ferrets').plant(FerretFiles, JSON.stringify(each), each.id);
  return await first.restart();
}

describe('the fleet read', () => {
  test('R501 GET /v1/ferrets is conditional: its etag is a digest of the exact JSON served', async () => {
    const h = await host([record('lead'), record('helper', 'lead')]);
    const first = await h.request('GET', '/v1/ferrets');
    expect(first.status).toBe(200);
    expect(first.headers.get('etag')).toBe(`"${createHash('sha256').update(first.body).digest('base64url')}"`);
    // Same creation time: by id.
    expect(first.json<readonly { id: string }[]>().map(ferret => ferret.id)).toEqual(['helper', 'lead']);
  });

  test('R501 the tag moves when any field of any ferret moves', async () => {
    const h = await host([record('lead'), record('helper', 'lead')]);
    const before = (await h.request('GET', '/v1/ferrets')).headers.get('etag');
    const renamed = await h.request('POST', '/v1/ferrets/helper/rename', { body: { name: 'piper' } });
    expect(renamed.status).toBe(200);
    const after = await h.request('GET', '/v1/ferrets', { headers: { 'if-none-match': before as string } });
    expect(after.status).toBe(200);
    expect(after.headers.get('etag')).not.toBe(before);
    expect(after.body).toContain('"name":"piper"');
  });

  test('R503 two reads with nothing changed give a 304 on the second, and the tag ignores read time', async () => {
    const h = await host([record('lead')]);
    const first = await h.request('GET', '/v1/ferrets');
    const etag = first.headers.get('etag') as string;
    h.clock.advance?.(60_000);
    const second = await h.request('GET', '/v1/ferrets', { headers: { 'if-none-match': etag } });
    expect(second.status).toBe(304);
    expect(second.body).toBe('');
    expect(second.headers.get('etag')).toBe(etag);
  });

  test('R503 the tag is deterministic, not a version counter: a restarted daemon serves the same tag', async () => {
    const h = await host([record('lead'), record('other')]);
    const before = (await h.request('GET', '/v1/ferrets')).headers.get('etag');
    const again = await h.restart();
    const after = await again.request('GET', '/v1/ferrets', { headers: { 'if-none-match': before as string } });
    expect(after.status).toBe(304);
  });
});

describe('reading a ferret’s files', () => {
  test('S47 an agent is refused another ferret’s files', async () => {
    const h = await host([record('lead'), record('stranger')]);
    h.putRoot('work', 'notes.md', 'hello');
    const refused = await h.request('GET', '/v1/ferrets/stranger/fs/file', {
      ...as('lead'),
      query: { path: 'notes.md' },
    });
    expect(refused.status).toBe(403);
    expect(refused.json<{ code: string }>().code).toBe('not_own_session');
  });

  test('S47 an agent reads its own ferret’s and its helpers’ files', async () => {
    const h = await host([record('lead'), record('helper', 'lead'), record('grand', 'helper')]);
    h.putRoot('work', 'notes.md', 'hello');
    for (const target of ['lead', 'helper', 'grand']) {
      const read = await h.request('GET', `/v1/ferrets/${target}/fs/file`, {
        ...as('lead'),
        query: { path: 'notes.md' },
      });
      expect(read.status).toBe(200);
      expect(read.json<{ content: string }>().content).toBe('hello');
    }
    const up = await h.request('GET', '/v1/ferrets/lead/fs/file', { ...as('helper'), query: { path: 'notes.md' } });
    expect(up.status).toBe(403);
  });

  test('S47 a path out of the folder and a secret file are refused; a person is unaffected by the lineage rule', async () => {
    const h = await host([record('lead'), record('other')]);
    h.putRoot('work', 'notes.md', 'hello');
    const climb = await h.request('GET', '/v1/ferrets/lead/fs/file', { ...as('lead'), query: { path: '../x' } });
    expect(climb.status).toBeGreaterThanOrEqual(400);
    const secret = await h.request('GET', '/v1/ferrets/lead/fs/file', { ...as('lead'), query: { path: '.env' } });
    expect(secret.status).toBe(403);
    const person = await h.request('GET', '/v1/ferrets/other/fs/file', { query: { path: 'notes.md' } });
    expect(person.status).toBe(200);
  });
});

describe('lineage', () => {
  test('G43 a ferret may touch only its own; a lead also its helpers’ (Ferrets’ side of the fixture)', async () => {
    const h = await host([
      record('lead'),
      record('helper', 'lead'),
      record('grand', 'helper'),
      record('sibling', 'lead'),
      record('stranger'),
    ]);
    const api = h.provided(FerretsPort);
    await api.list();
    expect(api.mayTouch(ferretId('lead'), ferretId('grand'))).toBe(true);
    expect(api.mayTouch(ferretId('helper'), ferretId('lead'))).toBe(false);
    expect(api.mayTouch(ferretId('helper'), ferretId('sibling'))).toBe(false);
    expect(api.mayTouch(ferretId('stranger'), ferretId('helper'))).toBe(false);
    expect(api.children(ferretId('lead'))).toEqual([ferretId('helper'), ferretId('sibling')]);
  });

  test('a ferret may stop only itself and its helpers', async () => {
    const h = await host([record('lead'), record('helper', 'lead')]);
    const refused = await h.request('POST', '/v1/ferrets/lead/stop', as('helper'));
    expect(refused.status).toBe(403);
    const stopped = await h.request('POST', '/v1/ferrets/helper/stop', as('lead'));
    expect(stopped.json<{ state: string }>().state).toBe('stopped');
  });
});

describe('starting, tokens and attach', () => {
  test('a start issues a fys_ token, stores only its digest, and Gate finds the ferret by that digest', async () => {
    const harness = new FakeHarness();
    const runner = new FakeRunner();
    const h = await host([], { harness, runner });
    const started = await h.request('POST', '/v1/ferrets', { body: { name: 'aniya', folder: '/work/a' } });
    expect(started.status).toBe(201);
    const id = started.json<{ id: FerretId }>().id;
    const stored = h.state('ferrets').raw(FerretTokensFile) as string;
    expect(stored).not.toContain('fys_');
    const digest = (JSON.parse(stored) as { tokens: { digest: string; ferret: string }[] }).tokens[0];
    expect(digest?.ferret).toBe(id);
    const view = (await h.request('GET', `/v1/ferrets/${id}`)).json<{ state: string; name: string }>();
    expect(view).toMatchObject({ state: 'working', name: 'aniya' });
    expect(runner.starts).toBe(1);
  });

  test('G12 a ferret’s start is its own helper: an absent parent is filled from its token', async () => {
    const h = await host([record('lead')], { harness: new FakeHarness(), runner: new FakeRunner() });
    const started = await h.request('POST', '/v1/ferrets', { ...as('lead'), body: { folder: '/work/b' } });
    expect(started.status).toBe(201);
    const id = started.json<{ id: string }>().id;
    expect((await h.request('GET', `/v1/ferrets/${id}`)).json<{ parent: string; role: string }>()).toMatchObject({
      parent: 'lead',
      role: 'helper',
    });
    const named = await h.request('POST', '/v1/ferrets', { ...as('lead'), body: { folder: '/work/c', parent: 'lead' } });
    expect(named.status).toBe(201);
  });

  test('G12 a ferret naming another parent is refused parent_mismatch; the owner may name any parent', async () => {
    const h = await host([record('lead'), record('other')], { harness: new FakeHarness(), runner: new FakeRunner() });
    const mismatch = await h.request('POST', '/v1/ferrets', { ...as('lead'), body: { folder: '/work/c', parent: 'other' } });
    expect(mismatch.status).toBe(403);
    expect(mismatch.json<{ code: string }>().code).toBe('parent_mismatch');
    const owners = await h.request('POST', '/v1/ferrets', { body: { folder: '/work/d', parent: 'other' } });
    expect(owners.status).toBe(201);
    const id = owners.json<{ id: string }>().id;
    expect((await h.request('GET', `/v1/ferrets/${id}`)).json<{ parent: string }>().parent).toBe('other');
    const missing = await h.request('POST', '/v1/ferrets', { body: { folder: '/work/e', parent: 'ghost' } });
    expect(missing.status).toBe(404);
    expect(missing.json<{ code: string }>().code).toBe('unknown_parent');
  });

  test('revoke-credential is a person’s act and the bearer stops naming the ferret', async () => {
    const h = await host([], { harness: new FakeHarness(), runner: new FakeRunner() });
    const id = (await h.request('POST', '/v1/ferrets', { body: { folder: '/work/a' } })).json<{ id: string }>().id;
    const byFerret = await h.request('POST', `/v1/ferrets/${id}/revoke-credential`, as(id));
    expect(byFerret.status).toBe(403);
    const revoked = await h.request('POST', `/v1/ferrets/${id}/revoke-credential`);
    expect(revoked.json<{ revoked: boolean }>().revoked).toBe(true);
    const tokens = JSON.parse(h.state('ferrets').raw(FerretTokensFile) as string) as {
      tokens: { revoked?: true }[];
    };
    expect(tokens.tokens.every(entry => entry.revoked === true)).toBe(true);
  });

  test('D15 attach adopts a live pane by its handle without starting anything', async () => {
    const runner = new FakeRunner();
    const h = await host([{ ...record('lead'), state: 'stopped' }], { harness: new FakeHarness(), runner });
    const handle = runner.adoptable(ferretId('lead'));
    const attached = await h.provided(FerretsPort).attach(ferretId('lead'), handle);
    expect(attached.ok).toBe(true);
    expect(runner.starts).toBe(0);
    expect((await h.provided(FerretsPort).get(ferretId('lead')))?.state).toBe('working');
    const gone = await h.provided(FerretsPort).attach(ferretId('lead'), '%99' as never);
    expect(gone.ok).toBe(false);
  });

  test('the port names a running ferret’s handle from ferret.json, after a restart too, and none once stopped', async () => {
    const runner = new FakeRunner();
    const h = await host([], { harness: new FakeHarness(), runner });
    const id = (await h.request('POST', '/v1/ferrets', { body: { folder: '/work/a' } })).json<{ id: FerretId }>().id;
    const handle = await h.provided(FerretsPort).handle(id);
    expect(handle).toBeDefined();
    // A fresh daemon reads only what ferret.json kept.
    const restarted = await host([{ ...record(id), handle: handle as string, state: 'working' }], {
      harness: new FakeHarness(),
      runner,
    });
    expect(await restarted.provided(FerretsPort).handle(id)).toBe(handle);
    await restarted.request('POST', `/v1/ferrets/${id}/stop`);
    expect(await restarted.provided(FerretsPort).handle(id)).toBeUndefined();
    expect(await restarted.provided(FerretsPort).handle(ferretId('nobody'))).toBeUndefined();
  });
});


describe('managed worktrees and the file browser before the kernel host IO is bound', () => {
  test('the worktree list answers with no managed root, and a create or removal says why it cannot', async () => {
    const h = await host();
    const list = await h.request('GET', '/v1/worktrees');
    expect(list.status).toBe(200);
    expect(list.json<{ worktrees: unknown[]; managedRoot?: string }>()).toEqual({ worktrees: [] });
    const created = await h.request('POST', '/v1/worktrees', {
      body: { cwd: '/work/project', branch: 'feat/one' },
    });
    expect([400, 409]).toContain(created.status);
  });

  test('S47 the file browser refuses an agent another ferret’s folder before it answers anything', async () => {
    const h = await host([record('lead'), record('stranger')]);
    const refused = await h.request('GET', '/v1/ferrets/stranger/fs', as('lead'));
    expect(refused.status).toBe(403);
    expect(refused.json<{ code: string }>().code).toBe('not_own_session');
  });

  test('the file browser answers 503 not built yet until the kernel root walk lands', async () => {
    const h = await host([record('lead')]);
    for (const path of ['fs', 'fs/index', 'fs/changes', 'fs/diff']) {
      const answer = await h.request('GET', `/v1/ferrets/lead/${path}`, { query: { path: 'a.txt' } });
      expect(answer.status).toBe(503);
      expect(answer.json<{ code: string }>().code).toBe('plugin_unavailable');
    }
  });
});

describe('a start retried under its request id, and recovered when both answers were lost', () => {
  const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
  const startBody = { name: 'aniya', folder: '/work/a' };
  const withId = (id: string) => ({ 'x-fy-request-id': id });

  test('the same id and body answer the ferret already started; another body under that id is refused', async () => {
    const h = await host([], { harness: new FakeHarness(), runner: new FakeRunner() });
    const first = await h.request('POST', '/v1/ferrets', { body: startBody, headers: withId('req-1') });
    expect(first.status).toBe(201);
    const id = first.json<{ id: string }>().id;
    const again = await h.request('POST', '/v1/ferrets', { body: startBody, headers: withId('req-1') });
    expect(again.status).toBe(200);
    expect(again.json<{ id: string }>().id).toBe(id);
    expect((await h.request('GET', '/v1/ferrets')).json<readonly unknown[]>()).toHaveLength(1);
    const reused = await h.request('POST', '/v1/ferrets', {
      body: { ...startBody, folder: '/work/b' },
      headers: withId('req-1'),
    });
    expect(reused.status).toBe(409);
    expect(reused.json<{ code: string }>().code).toBe('request_id_reused');
  });

  test('the recovery read answers only a caller that proves the exact body it sent', async () => {
    const h = await host([], { harness: new FakeHarness(), runner: new FakeRunner() });
    const id = (
      await h.request('POST', '/v1/ferrets', { body: startBody, headers: withId('req-2') })
    ).json<{ id: string }>().id;
    const proved = await h.request('GET', '/v1/ferrets/by-request/req-2', {
      query: { payload: sha(JSON.stringify(startBody)) },
    });
    expect(proved.status).toBe(200);
    expect(proved.json<{ id: string }>().id).toBe(id);
    const unproved = await h.request('GET', '/v1/ferrets/by-request/req-2');
    expect(unproved.status).toBe(400);
    expect(unproved.json<{ code: string }>().code).toBe('missing_payload_digest');
    const wrong = await h.request('GET', '/v1/ferrets/by-request/req-2', { query: { payload: sha('{}') } });
    expect(wrong.status).toBe(409);
    const unknown = await h.request('GET', '/v1/ferrets/by-request/never', { query: { payload: sha('{}') } });
    expect(unknown.status).toBe(404);
  });
});

describe('pins', () => {
  test('the owner pins a ferret by name and the answer carries the instant; an agent may not pin the sidebar', async () => {
    const h = await host([record('lead'), record('helper', 'lead')]);
    const pinned = await h.request('POST', '/v1/ferrets/lead/pin');
    expect(pinned.status).toBe(200);
    expect(pinned.json<{ id: string; pinnedAt?: string }>()).toMatchObject({ id: 'lead' });
    expect(pinned.json<{ pinnedAt?: string }>().pinnedAt).toBeString();
    const unpinned = await h.request('POST', '/v1/ferrets/lead/unpin');
    expect(unpinned.status).toBe(200);
    expect(unpinned.json<{ pinnedAt?: string }>().pinnedAt).toBeUndefined();
    const byAgent = await h.request('POST', '/v1/ferrets/lead/pin', as('helper'));
    expect(byAgent.status).toBe(403);
    expect((await h.request('POST', '/v1/ferrets/nobody/pin')).status).toBe(404);
  });

  test('a note pinned on a ferret’s board is read back from its own pins.json', async () => {
    const h = await host([record('lead')]);
    const added = await h.request('POST', '/v1/ferrets/lead/pins', { body: { action: 'add', kind: 'note', text: 'ship it' } });
    expect(added.status).toBe(200);
    const board = await h.request('GET', '/v1/ferrets/lead/pins');
    expect(board.status).toBe(200);
    expect(board.json<{ pins: { text?: string }[] }>().pins.map(pin => pin.text)).toEqual(['ship it']);
  });
});

describe('today’s start fields, the title, and the stop and resume words', () => {
  const started = async (h: TestHost, body: Record<string, unknown>): Promise<FerretId> => {
    const answer = await h.request('POST', '/v1/ferrets', { body: { folder: '/work/a', ...body } });
    expect(answer.status).toBe(201);
    return answer.json<{ id: FerretId }>().id;
  };
  const history = (h: TestHost, id: string) =>
    (h.state('ferrets').raw(FerretHistoryFiles, id) ?? '')
      .split('\n')
      .filter(line => line !== '')
      .map(line => JSON.parse(line) as { sequence: number; type: string; data: Record<string, unknown> });

  test('a start carries today’s flat fields: the summary shows model and card, details.json keeps every option', async () => {
    const h = await host([], { harness: new FakeHarness(), runner: new FakeRunner() });
    const id = await started(h, {
      prompt: 'fix it',
      mode: 'auto',
      title: 'Fix the login',
      label: 'mine',
      model: 'opus',
      card: 'F21',
      intervalSeconds: 30,
      timeoutSeconds: 3600,
      nudgeAfterSeconds: 120,
      killAfterSeconds: 900,
      harnessFlags: ['--verbose'],
    });
    const view = (await h.request('GET', `/v1/ferrets/${id}`)).json<Record<string, unknown>>();
    expect(view).toMatchObject({ model: 'opus', card: 'F21', title: 'Fix the login' });
    expect(view.label).toBeUndefined();
    const details = JSON.parse(h.state('ferrets').raw(FerretDetailsFiles, id) as string);
    expect(details).toEqual({
      format: 1,
      options: {
        mode: 'auto',
        label: 'mine',
        model: 'opus',
        card: 'F21',
        intervalSeconds: 30,
        timeoutSeconds: 3600,
        nudgeAfterSeconds: 120,
        killAfterSeconds: 900,
        harnessFlags: ['--verbose'],
      },
      title: 'Fix the login',
    });
    // ferret.json is unchanged: who a ferret is, nothing more.
    expect(JSON.parse(h.state('ferrets').raw(FerretFiles, id) as string).model).toBeUndefined();
    // A restarted daemon reads the details back with the record.
    const again = await h.restart();
    const list = (await again.request('GET', '/v1/ferrets')).json<{ id: string; model?: string }[]>();
    expect(list.find(ferret => ferret.id === id)?.model).toBe('opus');
  });

  test('a start with no options writes no details.json', async () => {
    const h = await host([], { harness: new FakeHarness(), runner: new FakeRunner() });
    const id = await started(h, {});
    expect(h.state('ferrets').raw(FerretDetailsFiles, id)).toBeUndefined();
  });

  test('a title rename shows in the summary and the fleet list, keeping the start options', async () => {
    const h = await host([], { harness: new FakeHarness(), runner: new FakeRunner() });
    const id = await started(h, { model: 'opus' });
    const renamed = await h.request('POST', `/v1/ferrets/${id}/rename`, { body: { title: 'Ship it' } });
    expect(renamed.status).toBe(200);
    expect(renamed.json<{ title?: string; model?: string }>()).toMatchObject({ title: 'Ship it', model: 'opus' });
    expect((await h.request('GET', '/v1/ferrets')).body).toContain('"title":"Ship it"');
    const both = await h.request('POST', `/v1/ferrets/${id}/rename`, { body: { name: 'piper', title: 'Again' } });
    expect(both.json<{ name: string; title?: string }>()).toMatchObject({ name: 'piper', title: 'Again' });
    expect((await h.request('POST', `/v1/ferrets/${id}/rename`, { body: {} })).status).toBe(400);
  });

  test('the owner’s pin instant rides the summary and the fleet list', async () => {
    const h = await host([record('lead')]);
    await h.request('POST', '/v1/ferrets/lead/pin');
    expect((await h.request('GET', '/v1/ferrets/lead')).json<{ pinnedAt?: string }>().pinnedAt).toBeString();
    expect((await h.request('GET', '/v1/ferrets')).json<{ pinnedAt?: string }[]>()[0]?.pinnedAt).toBeString();
  });

  test('a stop with a reason and a resume with a message are accepted and recorded in the ferret history', async () => {
    const h = await host([], { harness: new FakeHarness(), runner: new FakeRunner() });
    const id = await started(h, {});
    const stopped = await h.request('POST', `/v1/ferrets/${id}/stop`, { body: { reason: 'shift over' } });
    expect(stopped.json<{ state: string }>().state).toBe('stopped');
    const resumed = await h.request('POST', `/v1/ferrets/${id}/resume`, { body: { message: 'carry on' } });
    expect(resumed.status).toBe(200);
    await h.request('POST', `/v1/ferrets/${id}/stop`);
    expect(history(h, id).map(event => [event.sequence, event.type, event.data])).toEqual([
      [1, 'session.stopped', { reason: 'shift over' }],
      [2, 'session.resumed', { message: 'carry on' }],
      [3, 'session.stopped', { reason: 'stopped by client' }],
    ]);
    expect((await h.request('POST', `/v1/ferrets/${id}/stop`, { body: { reason: '' } })).status).toBe(400);
    expect((await h.request('POST', `/v1/ferrets/${id}/resume`, { body: { note: 'x' } })).status).toBe(400);
  });

  test('bad timers, an over-long or control-character harness flag, and today’s mode rules are refused 400', async () => {
    const runner = new FakeRunner();
    const h = await host([], { harness: new FakeHarness(), runner });
    for (const body of [
      { intervalSeconds: 0 },
      { timeoutSeconds: -1 },
      { nudgeAfterSeconds: 1.5 },
      { maxSnapshots: '5' },
      { harnessFlags: ['x'.repeat(16_385)] },
      { harnessFlags: ['--a\nb'] },
      { card: 'F0' },
      { mode: 'auto' },
      { auto: true, runtime: 'claude-alpha' },
      { agent: 'claude-alpha' },
    ]) {
      const refused = await h.request('POST', '/v1/ferrets', { body: { folder: '/work/a', ...body } });
      expect(refused.status).toBe(400);
      expect(refused.json<{ code: string }>().code).toBe('invalid_request');
    }
    expect(runner.starts).toBe(0);
  });

  test('the port’s work folder answers nothing while no real-path seam is bound (kernel item N)', async () => {
    const h = await host([record('lead')]);
    expect(await h.provided(FerretsPort).workFolder(ferretId('lead'))).toBeUndefined();
  });
});

describe('what a ferret may control (limits.yaml agentControl)', () => {
  test('with no limits.yaml a ferret gets today’s defaults, and an unknown ferret controls nothing', async () => {
    const h = await host([record('lead')]);
    const api = h.provided(FerretsPort);
    expect(await api.agentControl(ferretId('lead'))).toEqual({
      terminals: true,
      browsers: true,
      files: true,
      ferretrySettings: false,
      pageScripts: false,
    });
    expect(Object.values(await api.agentControl(ferretId('nobody'))).some(Boolean)).toBe(false);
  });

  test('limits.yaml’s switches win over the defaults, and a change applies to the very next answer', async () => {
    const h = await host([record('lead')], { config: { 'limits.yaml': { agentControl: { files: false, pageScripts: true } } } });
    const api = h.provided(FerretsPort);
    expect(await api.agentControl(ferretId('lead'))).toMatchObject({ files: false, pageScripts: true, browsers: true });
    h.setConfig('limits.yaml', { agentControl: { browsers: false } });
    expect(await api.agentControl(ferretId('lead'))).toMatchObject({ files: true, pageScripts: false, browsers: false });
  });
});

describe('session routes whose services are not bound in this build', () => {
  test('signal, restarts and the archive list answer 503 not built yet rather than a missing route', async () => {
    const h = await host([record('lead')]);
    const answers = [
      await h.request('POST', '/v1/ferrets/lead/signal', { body: { kind: 'done' } }),
      await h.request('POST', '/v1/restarts', { body: { scope: 'outdated' } }),
      await h.request('GET', '/v1/restarts'),
      await h.request('DELETE', '/v1/restarts'),
      await h.request('GET', '/v1/archived-sessions'),
    ];
    for (const answer of answers) {
      expect(answer.status).toBe(503);
      expect(answer.json<{ code: string }>().code).toBe('plugin_unavailable');
    }
  });
});

describe('a start’s options reach the launch spec', () => {
  test('model, effort and the rest of today’s start fields are handed to the harness, on start and on resume', async () => {
    const harness = new FakeHarness();
    const h = await host([], { harness, runner: new FakeRunner() });
    const started = await h.request('POST', '/v1/ferrets', {
      body: {
        folder: '/work/a',
        model: 'claude-opus-5-5',
        effort: 'high',
        harnessFlags: ['--verbose'],
        intervalSeconds: 30,
        timeoutSeconds: 3_600,
      },
    });
    expect(started.status).toBe(201);
    const id = started.json<{ id: string }>().id;
    const first = harness.launched.at(-1);
    expect(first?.model).toBe('claude-opus-5-5');
    expect(first?.effort).toBe('high');
    expect(first?.options).toMatchObject({ harnessFlags: ['--verbose'], intervalSeconds: 30, timeoutSeconds: 3_600 });
    await h.request('POST', `/v1/ferrets/${id}/stop`, { query: { how: 'now' } });
    expect((await h.request('POST', `/v1/ferrets/${id}/resume`)).status).toBeLessThan(300);
    expect(harness.launched.at(-1)?.options).toMatchObject({ harnessFlags: ['--verbose'], intervalSeconds: 30 });
  });
});
