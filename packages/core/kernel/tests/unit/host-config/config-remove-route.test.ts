/**
 * `DELETE /v1/config/file` (kernel batch #11): the one route the CLI's settings/hooks `rm` verbs need. It is bounded
 * exactly as `PUT /v1/config/file`: a declared file only, Gate's admission per file (act `write`), the etag it was read
 * at required, and the writer's own `remove`, which holds a removal that loosens unless Gate says this call may loosen.
 */
import { describe, expect, test } from 'bun:test';
import type { Admission, ConfigAccessJudgement, ConfigAccessVerdict } from '../../../contract/bound.ts';
import { ApiError, type ApiRequest, errorResponse, headersFrom, queryFrom } from '../../../contract/http.ts';
import { configRoutes } from '../../../host/config/routes.ts';
import { createConfigFiles } from '../../../host/config/service.ts';
import { localArrival } from '../../../host/listener.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import kernelManifest from '../../../plugin.ts';
import { captureLog, HOME, loginsDef, manualClock, updatesDef } from './support.ts';

const UPDATES = `${HOME}/config/updates.yaml`;

function world(answer: (input: ConfigAccessJudgement) => ConfigAccessVerdict = () => ({ allowed: true })) {
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
  const gate = {
    judgeConfigAccess: (input: ConfigAccessJudgement) => {
      asked.push(input);
      return answer(input);
    },
  } as unknown as Admission;
  const handlers = configRoutes({ writer: () => files.writer(), admission: () => gate, home: HOME, binary: 'fy' });
  return { asked, files, fs, handlers };
}

const request = (method: string, query: readonly [string, string][] = [], headers = {}): ApiRequest => ({
  method,
  path: '/v1/config/file',
  query: queryFrom(query),
  headers: headersFrom(headers),
  arrival: localArrival(true),
  text: async () => '',
});
const call = (r: ApiRequest) => ({ request: r, params: new Map<string, string>() }) as never;
const json = (response: { body: string }) => JSON.parse(response.body) as Record<string, unknown>;

async function refusal(act: () => Promise<unknown>): Promise<ApiError> {
  try {
    await act();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

/** The etag a caller read the file at, through the GET route. */
async function etagOf(w: ReturnType<typeof world>, path: string): Promise<string> {
  return String(json(await w.handlers['GET /v1/config/file'](call(request('GET', [['path', path]])))).etag);
}

const remove = (w: ReturnType<typeof world>, path: string, etag?: string, via: 'header' | 'query' = 'header') =>
  w.handlers['DELETE /v1/config/file'](
    call(
      request(
        'DELETE',
        [['path', path], ...(etag !== undefined && via === 'query' ? [['etag', etag] as [string, string]] : [])],
        etag !== undefined && via === 'header' ? { 'if-match': etag } : {},
      ),
    ),
  );

describe('K-small #11 DELETE /v1/config/file is declared as PUT is', () => {
  test('operator, person only, fleet.use, noStore, audited as a fleet change, the same guard sentence', () => {
    const declared = (key: string) => kernelManifest.actions?.routes.find(route => route.key === key);
    const put = declared('PUT /v1/config/file');
    const del = declared('DELETE /v1/config/file');
    expect(del).toMatchObject({
      minimum: 'operator',
      caller: 'person',
      capability: { capability: 'fleet', axis: 'use' },
      noStore: true,
    });
    for (const field of ['minimum', 'caller', 'capability', 'noStore', 'audit', 'guard'] as const)
      expect(del?.[field as keyof typeof del]).toEqual(put?.[field as keyof typeof put]);
    // an agent's write door is POST /v1/agent/config: this route, like PUT, is a person's
    expect(del).not.toHaveProperty('ferretDoor');
  });
});

describe('K-small #11 DELETE /v1/config/file removes one declared file', () => {
  test('a removal that tightens is applied: the file is gone and the answer names no text', async () => {
    const w = world();
    await w.files.reload();
    await w.files.writer().write({ plugin: 'updates', def: updatesDef }, 'limit: 20\n', { confirmedLoosening: true });
    const etag = await etagOf(w, 'updates.yaml');
    const response = await remove(w, 'updates.yaml', etag);
    expect(json(response)).toEqual({ path: 'updates.yaml', etag: expect.any(String), outcome: 'removed' });
    expect(w.fs.snapshot().has(UPDATES)).toBe(false);
    expect(w.files.port('updates').file(updatesDef)).toBeUndefined();
    expect(w.asked).toMatchObject([
      { plugin: 'updates', path: 'updates.yaml', act: 'read' },
      { plugin: 'updates', path: 'updates.yaml', act: 'write' },
    ]);
  });

  test('G131 a removal that loosens, from a call Gate does not let loosen, is HELD: the file stays in effect', async () => {
    const w = world(input => (input.act === 'write' ? { allowed: true, mayLoosen: false } : { allowed: true }));
    await w.files.reload();
    await w.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    const etag = await etagOf(w, 'updates.yaml');
    const body = json(await remove(w, 'updates.yaml', etag));
    expect(body.outcome).toBe('pending');
    expect(body.pending).toEqual({ path: 'updates.yaml', etag: body.etag, changes: ['raises the limit from 5 to 10'] });
    expect(w.files.port('updates').file(updatesDef)).toMatchObject({ limit: 5 });
    expect(w.files.writer().held()).toMatchObject([{ path: 'updates.yaml', removal: true }]);
  });

  test('G131 a loosening removal Gate says this call may put into effect (somebody at this machine) is applied', async () => {
    const w = world(() => ({ allowed: true, mayLoosen: true }));
    await w.files.reload();
    await w.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    const etag = await etagOf(w, 'updates.yaml');
    expect(json(await remove(w, 'updates.yaml', etag)).outcome).toBe('removed');
    expect(w.files.port('updates').file(updatesDef)).toBeUndefined();
  });

  test('G131 a claim Gate offers is never spent on a removal: a proved device’s loosening removal is held', async () => {
    let claimed = 0;
    const w = world(() => ({
      allowed: true,
      mayLoosen: false,
      claimLoosening: () => {
        claimed += 1;
        return true;
      },
    }));
    await w.files.reload();
    await w.files.write('updates', updatesDef, undefined, 'limit: 5\n');
    const etag = await etagOf(w, 'updates.yaml');
    expect(json(await remove(w, 'updates.yaml', etag)).outcome).toBe('pending');
    expect(claimed).toBe(0);
  });

  test('a collection item is removed by its path', async () => {
    const w = world();
    await w.files.reload();
    await w.files.write('logins', loginsDef, 'a', 'model: m\n');
    const etag = await etagOf(w, 'logins/a.yaml');
    expect(json(await remove(w, 'logins/a.yaml', etag)).outcome).toBe('removed');
    expect(w.fs.snapshot().has(`${HOME}/config/logins/a.yaml`)).toBe(false);
  });

  test('the etag may come as ?etag= for a caller that sends no headers', async () => {
    const w = world();
    await w.files.reload();
    await w.files.write('logins', loginsDef, 'a', 'model: m\n');
    const etag = await etagOf(w, 'logins/a.yaml');
    expect(json(await remove(w, 'logins/a.yaml', etag, 'query')).outcome).toBe('removed');
  });
});

describe('K-small #11 DELETE /v1/config/file refuses before anything is removed', () => {
  test('an undeclared path is 400 and Gate is not asked', async () => {
    const w = world();
    await w.files.reload();
    for (const path of ['nobody.yaml', '../secrets.yaml', 'logins/Bad Name.yaml', '']) {
      const error = await refusal(() => remove(w, path, 'x'));
      expect(error.status).toBe(400);
    }
    expect(w.asked).toEqual([]);
  });

  test('no etag is 428: a file nobody looked at is never removed, and Gate is not asked', async () => {
    const w = world();
    await w.files.reload();
    await w.files.write('logins', loginsDef, 'a', 'model: m\n');
    const asked = w.asked.length;
    const error = await refusal(() => remove(w, 'logins/a.yaml'));
    expect(error.status).toBe(428);
    expect(error.code).toBe('precondition_required');
    expect(w.asked.length).toBe(asked);
    expect(w.fs.snapshot().has(`${HOME}/config/logins/a.yaml`)).toBe(true);
  });

  test('a stale etag is 409 config_conflict and the file stays', async () => {
    const w = world();
    await w.files.reload();
    await w.files.write('logins', loginsDef, 'a', 'model: m\n');
    const stale = await etagOf(w, 'logins/a.yaml');
    await w.files.write('logins', loginsDef, 'a', 'model: n\n');
    const error = await refusal(() => remove(w, 'logins/a.yaml', stale));
    expect(error.status).toBe(409);
    expect(error.code).toBe('config_conflict');
    expect(String(w.fs.snapshot().get(`${HOME}/config/logins/a.yaml`))).toBe('model: n\n');
  });

  test('a governed device without the grant: Gate’s refusal is the answer and nothing is removed', async () => {
    const w = world(input =>
      input.act === 'write'
        ? {
            allowed: false,
            response: errorResponse(403, 'this device may not change fleet files', 'grant_required'),
          }
        : { allowed: true },
    );
    await w.files.reload();
    await w.files.write('logins', loginsDef, 'a', 'model: m\n');
    const etag = await etagOf(w, 'logins/a.yaml');
    const response = await remove(w, 'logins/a.yaml', etag);
    expect(response.status).toBe(403);
    expect(w.fs.snapshot().has(`${HOME}/config/logins/a.yaml`)).toBe(true);
  });

  test('no judge, or a judge that throws, refuses and removes nothing', async () => {
    const fs = createMemoryHostFs();
    const files = createConfigFiles({
      home: HOME,
      fs,
      clock: manualClock(),
      log: captureLog(),
      binary: 'fy',
      defs: [{ plugin: 'logins', def: loginsDef }],
    });
    await files.reload();
    await files.write('logins', loginsDef, 'a', 'model: m\n');
    const throwing = {
      judgeConfigAccess: () => {
        throw new Error('gate is down');
      },
    } as unknown as Admission;
    for (const admission of [undefined, throwing]) {
      const handlers = configRoutes({
        writer: () => files.writer(),
        admission: () => admission,
        home: HOME,
        binary: 'fy',
      });
      const response = await handlers['DELETE /v1/config/file'](
        call(request('DELETE', [['path', 'logins/a.yaml']], { 'if-match': 'x' })),
      );
      expect(response.status).toBe(403);
    }
    expect(fs.snapshot().has(`${HOME}/config/logins/a.yaml`)).toBe(true);
  });
});
