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
  type FerretId,
  type FerretRecord,
  FerretsPort,
  FerretTokensFile,
  Harnesses,
  Runners,
} from '../../../../contract/index.ts';
import { FakeHarness, FakeRunner, ferretId, T0 } from '../../../../contract/testing/index.ts';
import ferrets from '../../../../daemon/index.ts';

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
  extra: { readonly harness?: FakeHarness; readonly runner?: FakeRunner } = {},
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

  test('a ferret’s start is its own helper: the parent comes from its token, never the body', async () => {
    const h = await host([record('lead')], { harness: new FakeHarness(), runner: new FakeRunner() });
    const started = await h.request('POST', '/v1/ferrets', { ...as('lead'), body: { folder: '/work/b' } });
    expect(started.status).toBe(201);
    const id = started.json<{ id: string }>().id;
    expect((await h.request('GET', `/v1/ferrets/${id}`)).json<{ parent: string; role: string }>()).toMatchObject({
      parent: 'lead',
      role: 'helper',
    });
    const forged = await h.request('POST', '/v1/ferrets', { body: { folder: '/work/c', parent: 'lead' } });
    expect(forged.status).toBe(400);
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
