import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import type { Admission, ConfigAccessJudgement, ConfigAccessVerdict } from '../../../contract/bound.ts';
import { ApiError, type ApiRequest, errorResponse, headersFrom, queryFrom } from '../../../contract/http.ts';
import { localArrival } from '../../../host/listener.ts';
import { configRoutes } from '../../../host/config/routes.ts';
import { createConfigFiles } from '../../../host/config/service.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import kernelManifest from '../../../plugin.ts';
import { captureLog, HOME, loginsDef, manualClock, updatesDef } from './support.ts';

const UPDATES = `${HOME}/config/updates.yaml`;
const RAW_SECRET =
  'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

/** Counts one proof claimed: what a verdict's `claimLoosening` does in these tests. */
function claim(claims: { count: number }, taken: boolean): boolean {
  claims.count += 1;
  return taken;
}

interface World {
  readonly asked: ConfigAccessJudgement[];
  readonly spent: { count: number };
  readonly files: ReturnType<typeof createConfigFiles>;
  readonly fs: ReturnType<typeof createMemoryHostFs>;
  readonly handlers: ReturnType<typeof configRoutes>;
}

/** The three routes over the real config writer, with Gate's answer a function of the question. */
function world(
  answer: (input: ConfigAccessJudgement, spent: { count: number }) => ConfigAccessVerdict = (input, spent) =>
    input.act === 'write'
      ? { allowed: true, mayLoosen: false, claimLoosening: () => claim(spent, false) }
      : { allowed: true },
  admission: 'given' | 'absent' | 'throws' = 'given',
): World {
  const fs = createMemoryHostFs();
  const files = createConfigFiles({
    home: HOME,
    fs,
    clock: manualClock(),
    log: captureLog(),
    binary: 'fy',
    defs: [
      { plugin: 'updates', def: updatesDef },
      { plugin: 'logins', def: loginsDef },
    ],
  });
  const asked: ConfigAccessJudgement[] = [];
  const spent = { count: 0 };
  const gate = {
    judgeConfigAccess: (input: ConfigAccessJudgement) => {
      asked.push(input);
      if (admission === 'throws') throw new Error('gate is down');
      return answer(input, spent);
    },
  } as unknown as Admission;
  const handlers = configRoutes({
    writer: () => files.writer(),
    admission: () => (admission === 'absent' ? undefined : gate),
    home: HOME,
    binary: 'fy',
  });
  return { asked, spent, files, fs, handlers };
}

const request = (
  method: string,
  query: readonly [string, string][] = [],
  body?: unknown,
  headers = {},
): ApiRequest => ({
  method,
  path: '/v1/config/file',
  query: queryFrom(query),
  headers: headersFrom(headers),
  arrival: localArrival(true),
  text: async () => (body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)),
});

const call = (r: ApiRequest) => ({ request: r, params: new Map<string, string>() }) as never;

async function refusal(act: () => Promise<unknown>): Promise<ApiError> {
  try {
    await act();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

const json = (response: { body: string }) => JSON.parse(response.body) as Record<string, unknown>;

describe('the kernel declares today’s three config routes, descriptor for descriptor', () => {
  const declared = (key: string) => kernelManifest.actions?.routes.find(route => route.key === key);

  test('R-0072 GET /v1/config/file: operator, any caller, fleet.use, noStore', () => {
    expect(declared('GET /v1/config/file')).toMatchObject({
      minimum: 'operator',
      caller: 'any',
      capability: { capability: 'fleet', axis: 'use' },
      noStore: true,
    });
  });

  test('R-0419 PUT /v1/config/file: operator, person only, fleet.use, noStore, with the ferret’s door named', () => {
    expect(declared('PUT /v1/config/file')).toMatchObject({
      minimum: 'operator',
      caller: 'person',
      capability: { capability: 'fleet', axis: 'use' },
      noStore: true,
      ferretDoor: expect.stringContaining('config_write'),
    });
  });

  test('R-0274 POST /v1/config/confirm: operator, person only, fleet.use, noStore', () => {
    expect(declared('POST /v1/config/confirm')).toMatchObject({
      minimum: 'operator',
      caller: 'person',
      capability: { capability: 'fleet', axis: 'use' },
      noStore: true,
    });
  });
});

describe('GET /v1/config/file', () => {
  test('R-0072 answers today’s view: path, absolute path, kind, schema, existence, text, etag, state and issues', async () => {
    const w = world();
    w.fs.seed(UPDATES, '# mine\nlimit: 5\n');
    await w.files.reload();
    const response = await w.handlers['GET /v1/config/file'](call(request('GET', [['path', 'updates.yaml']])));
    expect(response.status).toBe(200);
    expect(json(response)).toEqual({
      path: 'updates.yaml',
      absolutePath: `${HOME}/config/updates.yaml`,
      kind: 'updates',
      schema: 'updates.json',
      exists: true,
      text: '# mine\nlimit: 5\n',
      etag: expect.stringMatching(/^[0-9a-f]{64}$/),
      state: 'ok',
      issues: [],
    });
  });

  test('R-0072 a file that is not there begins as its schema’s modeline, with the absent etag', async () => {
    const w = world();
    await w.files.reload();
    const view = json(await w.handlers['GET /v1/config/file'](call(request('GET', [['path', 'logins/work.yaml']]))));
    expect(view).toMatchObject({ exists: false, etag: 'absent', state: 'ok', kind: 'logins' });
    expect(String(view.text)).toStartWith('# yaml-language-server: $schema=../.schema/');
  });

  test('R-0072 a broken file is `invalid` with located issues, and a held edit reads `pending`', async () => {
    const w = world();
    await w.files.reload();
    await w.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    w.fs.seed(UPDATES, 'limit: many\n');
    await w.files.reload();
    const broken = json(await w.handlers['GET /v1/config/file'](call(request('GET', [['path', 'updates.yaml']]))));
    expect(broken.state).toBe('invalid');
    expect((broken.issues as { severity: string; fix: string }[])[0]).toMatchObject({ severity: 'error' });
    w.fs.seed(UPDATES, 'limit: 50\n');
    await w.files.reload();
    expect(json(await w.handlers['GET /v1/config/file'](call(request('GET', [['path', 'updates.yaml']])))).state).toBe(
      'pending',
    );
  });

  test('R-0072 Gate is asked for THIS file on `read`; a refusal is its answer and no text leaves', async () => {
    const w = world(input => ({
      allowed: false,
      response: errorResponse(403, `this device may not read ${input.path}`, 'grant_not_granted'),
    }));
    w.fs.seed(UPDATES, 'limit: 5\n');
    await w.files.reload();
    const response = await w.handlers['GET /v1/config/file'](call(request('GET', [['path', 'updates.yaml']])));
    expect(response.status).toBe(403);
    expect(response.body).not.toContain('limit');
    expect(w.asked).toMatchObject([{ plugin: 'updates', path: 'updates.yaml', act: 'read' }]);
  });

  test('R-0072 a path no plugin reads, or none, is 400 and Gate is not asked', async () => {
    const w = world();
    const unknown = await refusal(() =>
      w.handlers['GET /v1/config/file'](call(request('GET', [['path', 'nope.yaml']]))),
    );
    expect([unknown.status, unknown.code]).toEqual([400, 'bad_request']);
    const none = await refusal(() => w.handlers['GET /v1/config/file'](call(request('GET'))));
    expect(none.status).toBe(400);
    expect(w.asked).toEqual([]);
  });
});

describe('PUT /v1/config/file', () => {
  test('R-0419 G131 an edit that only takes away (a tightening) is applied at once and asks and spends no proof', async () => {
    const w = world();
    await w.files.reload();
    const response = await w.handlers['PUT /v1/config/file'](
      call(request('PUT', [], { path: 'updates.yaml', text: 'limit: 5\n' })),
    );
    expect(json(response)).toEqual({ path: 'updates.yaml', etag: expect.any(String), outcome: 'applied' });
    expect(w.files.port('updates').file(updatesDef)).toMatchObject({ limit: 5 });
    expect(w.asked).toMatchObject([{ plugin: 'updates', path: 'updates.yaml', act: 'write' }]);
    expect(w.spent.count).toBe(0);
  });

  test('R-0419 G131 a loosening from a caller Gate says may not loosen is written and HELD, the tighter version in effect', async () => {
    const w = world();
    await w.files.reload();
    await w.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    const response = await w.handlers['PUT /v1/config/file'](
      call(request('PUT', [], { path: 'updates.yaml', text: 'limit: 50\n' })),
    );
    const body = json(response);
    expect(body.outcome).toBe('pending');
    expect(body.pending).toEqual({
      path: 'updates.yaml',
      etag: body.etag,
      changes: ['raises the limit from 5 to 50'],
    });
    expect(w.files.port('updates').file(updatesDef)).toMatchObject({ limit: 5 });
    expect(String(w.fs.snapshot().get(UPDATES))).toBe('limit: 50\n');
    // Gate was asked to claim a proof exactly once, because this text really loosens; it said no
    expect(w.spent.count).toBe(1);
  });

  test('R-0419 G126 a loosening Gate lets this call claim a proof for is applied, and the proof is taken once', async () => {
    const w = world((_input, spent) => ({
      allowed: true,
      mayLoosen: false,
      claimLoosening: () => claim(spent, true),
    }));
    await w.files.reload();
    await w.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    const response = await w.handlers['PUT /v1/config/file'](
      call(request('PUT', [], { path: 'updates.yaml', text: 'limit: 50\n' })),
    );
    expect(json(response).outcome).toBe('applied');
    expect(w.files.port('updates').file(updatesDef)).toMatchObject({ limit: 50 });
    expect(w.spent.count).toBe(1);
  });

  test('R-0419 Gate’s refusal is its answer: nothing is written and nothing is spent', async () => {
    const w = world(() => ({
      allowed: false,
      response: errorResponse(
        403,
        'changing updates.yaml from this device needs a passkey confirmation',
        'grant_step_up_required',
      ),
    }));
    await w.files.reload();
    const response = await w.handlers['PUT /v1/config/file'](
      call(request('PUT', [], { path: 'updates.yaml', text: 'limit: 1\n' })),
    );
    expect(response.status).toBe(403);
    expect(w.fs.snapshot().has(UPDATES)).toBe(false);
    expect(w.spent.count).toBe(0);
  });

  test('R-0419 no judge, or a judge that throws, refuses the call and writes nothing', async () => {
    for (const admission of ['absent', 'throws'] as const) {
      const w = world(undefined, admission);
      await w.files.reload();
      const response = await w.handlers['PUT /v1/config/file'](
        call(request('PUT', [], { path: 'updates.yaml', text: 'limit: 1\n' })),
      );
      expect(response.status).toBe(403);
      expect(w.fs.snapshot().has(UPDATES)).toBe(false);
    }
  });

  test('R-0419 a raw secret is refused 422 config_invalid, never echoed, and nothing is written', async () => {
    const w = world();
    await w.files.reload();
    const response = await w.handlers['PUT /v1/config/file'](
      call(request('PUT', [], { path: 'updates.yaml', text: `apiKey: ${RAW_SECRET}\n` })),
    );
    expect(response.status).toBe(422);
    expect(json(response).code).toBe('config_invalid');
    expect(response.body).not.toContain(RAW_SECRET);
    expect(w.fs.snapshot().has(UPDATES)).toBe(false);
  });

  test('R-0419 a file that does not check is 422 with located issues; the disk is untouched', async () => {
    const w = world();
    await w.files.reload();
    const response = await w.handlers['PUT /v1/config/file'](
      call(request('PUT', [], { path: 'updates.yaml', text: 'limit: many\n' })),
    );
    expect(response.status).toBe(422);
    const body = json(response) as { error: string; issues: { path: string; severity: string; fix: string }[] };
    expect(body.error).toContain('nothing was written');
    expect(body.issues[0]).toMatchObject({ path: expect.any(String), severity: 'error', fix: expect.any(String) });
    expect(w.fs.snapshot().has(UPDATES)).toBe(false);
  });

  test('R-0419 a file with more problems than an answer lists: 50 located, one sentence counts the rest, the count is all', async () => {
    const w = world();
    await w.files.reload();
    // `limit` written 301 times: 300 duplicate keys, each a problem.
    const text = 'limit: 1\n'.repeat(301);
    const response = await w.handlers['PUT /v1/config/file'](call(request('PUT', [], { path: 'updates.yaml', text })));
    expect(response.status).toBe(422);
    const body = json(response) as { error: string; issues: { message: string; line?: number }[] };
    expect(body.issues).toHaveLength(51);
    expect(body.issues[0]?.line).toBe(2);
    expect(body.issues.at(-1)).toMatchObject({ message: 'and 250 more problems not listed here' });
    expect(body.issues.at(-1)?.line).toBeUndefined();
    expect(body.error).toBe('the file does not check (300 problems); nothing was written');
  });

  test('R-0419 a stale etag, from If-Match or from the body, is 409 config_conflict; the right one writes', async () => {
    const w = world();
    await w.files.reload();
    await w.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    const etag = json(await w.handlers['GET /v1/config/file'](call(request('GET', [['path', 'updates.yaml']])))).etag;
    const viaHeader = await refusal(() =>
      w.handlers['PUT /v1/config/file'](
        call(request('PUT', [], { path: 'updates.yaml', text: 'limit: 4\n' }, { 'if-match': 'stale' })),
      ),
    );
    expect([viaHeader.status, viaHeader.code]).toEqual([409, 'config_conflict']);
    const viaBody = await refusal(() =>
      w.handlers['PUT /v1/config/file'](
        call(request('PUT', [], { path: 'updates.yaml', text: 'limit: 4\n', etag: 'stale' })),
      ),
    );
    expect(viaBody.status).toBe(409);
    expect(String(w.fs.snapshot().get(UPDATES))).toBe('limit: 5\n');
    const ok = await w.handlers['PUT /v1/config/file'](
      call(request('PUT', [], { path: 'updates.yaml', text: 'limit: 4\n', etag })),
    );
    expect(json(ok).outcome).toBe('applied');
  });

  test('R-0419 a hand edit the watcher has not reloaded yet is 409 too (never apply an edit nobody saw)', async () => {
    const w = world();
    await w.files.reload();
    await w.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    w.fs.seed(UPDATES, 'limit: 3\n');
    const stale = await refusal(() =>
      w.handlers['PUT /v1/config/file'](call(request('PUT', [], { path: 'updates.yaml', text: 'limit: 4\n' }))),
    );
    expect(stale.status).toBe(409);
    expect(String(w.fs.snapshot().get(UPDATES))).toBe('limit: 3\n');
  });

  test('R-0419 an unknown path is 400, an unknown body key is 400, and Gate is not asked', async () => {
    const w = world();
    const unknown = await refusal(() =>
      w.handlers['PUT /v1/config/file'](call(request('PUT', [], { path: 'nope.yaml', text: '' }))),
    );
    expect(unknown.status).toBe(400);
    const extra = await refusal(() =>
      w.handlers['PUT /v1/config/file'](call(request('PUT', [], { path: 'updates.yaml', text: '', extra: 1 }))),
    );
    expect(extra.status).toBe(400);
    expect(w.asked).toEqual([]);
  });
});

describe('POST /v1/config/confirm', () => {
  async function heldRaise(w: World): Promise<{ etag: string }> {
    await w.files.reload();
    await w.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    w.fs.seed(UPDATES, 'limit: 50\n');
    await w.files.reload();
    const held = w.files.held()[0];
    if (held === undefined) throw new Error('expected a held edit');
    return { etag: held.etag };
  }

  test('R-0274 confirming the reviewed edit puts it into effect (Gate took the proof when it judged the act)', async () => {
    const w = world();
    const { etag } = await heldRaise(w);
    const response = await w.handlers['POST /v1/config/confirm'](
      call(request('POST', [], { path: 'updates.yaml', etag })),
    );
    expect(json(response)).toEqual({ path: 'updates.yaml', confirmed: true });
    expect(w.files.port('updates').file(updatesDef)).toMatchObject({ limit: 50 });
    expect(w.asked.at(-1)).toMatchObject({ plugin: 'updates', path: 'updates.yaml', act: 'confirm' });
  });

  test('R-0274 an edit that moved on disk after the review, with the SAME 12-character etag prefix, is never confirmed', async () => {
    // Two texts whose sha256 agree on the first 12 hex characters (found by a birthday search on 48 bits).
    const reviewed = 'limit: 6\nnote: a2641039\n';
    const unseen = 'limit: 999999\nnote: b896126\n';
    const etagOf = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
    expect(etagOf(unseen).slice(0, 12)).toBe(etagOf(reviewed).slice(0, 12));
    expect(etagOf(unseen)).not.toBe(etagOf(reviewed));
    const w = world();
    await w.files.reload();
    await w.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    w.fs.seed(UPDATES, reviewed);
    await w.files.reload();
    expect(w.files.held()).toHaveLength(1);
    // the file is swapped and NOT reloaded: the held list still shows the reviewed edit
    w.fs.seed(UPDATES, unseen);
    const response = await w.handlers['POST /v1/config/confirm'](
      call(request('POST', [], { path: 'updates.yaml', etag: etagOf(reviewed) })),
    );
    expect(json(response)).toEqual({ path: 'updates.yaml', confirmed: false });
    expect(w.files.port('updates').file(updatesDef)).toMatchObject({ limit: 5 });
    // the edit nobody saw waits, held, for its own review
    expect(w.files.held().map(item => item.etag)).toEqual([etagOf(unseen)]);
  });

  test('R-0274 an etag nobody reviewed confirms nothing: `confirmed: false`, still held, no proof spent', async () => {
    const w = world();
    await heldRaise(w);
    const response = await w.handlers['POST /v1/config/confirm'](
      call(request('POST', [], { path: 'updates.yaml', etag: 'not-the-edit-that-waits' })),
    );
    expect(json(response)).toEqual({ path: 'updates.yaml', confirmed: false });
    expect(w.files.port('updates').file(updatesDef)).toMatchObject({ limit: 5 });
    expect(w.files.held()).toHaveLength(1);
  });

  test('R-0274 Gate’s refusal (a passkey for this act, or an agent) is its answer and the edit stays held', async () => {
    const w = world(input => ({
      allowed: false,
      response: errorResponse(
        403,
        `putting this change to ${input.path} into effect needs a passkey confirmation for it`,
        'grant_step_up_required',
      ),
    }));
    const { etag } = await heldRaise(w);
    const response = await w.handlers['POST /v1/config/confirm'](
      call(request('POST', [], { path: 'updates.yaml', etag })),
    );
    expect(response.status).toBe(403);
    expect(w.files.port('updates').file(updatesDef)).toMatchObject({ limit: 5 });
    expect(w.files.held()).toHaveLength(1);
  });

  test('R-0274 a path no plugin reads is 400; the body names a path and an etag and nothing else', async () => {
    const w = world();
    const unknown = await refusal(() =>
      w.handlers['POST /v1/config/confirm'](call(request('POST', [], { path: 'nope.yaml', etag: 'x' }))),
    );
    expect(unknown.status).toBe(400);
    const bare = await refusal(() =>
      w.handlers['POST /v1/config/confirm'](call(request('POST', [], { path: 'updates.yaml' }))),
    );
    expect(bare.status).toBe(400);
    expect(w.asked).toEqual([]);
  });
});
