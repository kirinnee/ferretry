import { describe, expect, test } from 'bun:test';
import type { Admission } from '../../../contract/bound.ts';
import { errorResponse, jsonResponse } from '../../../contract/http.ts';
import type { ApiRequest } from '../../../contract/http.ts';
import type { PluginId, HolderId, SessionId } from '../../../contract/ids.ts';
import type { Log, LogFields } from '../../../contract/ports.ts';
import type { RouteDescriptor } from '../../../contract/route.ts';
import { Dispatcher, type MountedRoute, type Owner } from '../../../host/dispatch.ts';
import { dedupedWarnings, describeRefusal, REFUSAL_WINDOW_MS, type RefusalNote } from '../../../host/refusal-log.ts';
import { fileLogSink } from '../../../host/wiring.ts';
import { scopedLog } from '../../../host/log.ts';
import { request } from './fixtures.ts';

/** A log that keeps what was said at each level. */
function recording(): {
  readonly log: Log;
  readonly said: Array<{ level: string; message: string; fields?: LogFields }>;
} {
  const said: Array<{ level: string; message: string; fields?: LogFields }> = [];
  const make = (): Log => ({
    debug: (message, fields) =>
      void said.push({ level: 'debug', message, ...(fields === undefined ? {} : { fields }) }),
    info: (message, fields) => void said.push({ level: 'info', message, ...(fields === undefined ? {} : { fields }) }),
    warn: (message, fields) => void said.push({ level: 'warn', message, ...(fields === undefined ? {} : { fields }) }),
    error: (message, fields) =>
      void said.push({ level: 'error', message, ...(fields === undefined ? {} : { fields }) }),
    child: () => make(),
  });
  return { log: make(), said };
}

const owner: Owner = { plugin: 'kernel' as PluginId, title: 'Kernel', serving: () => ({ kind: 'serving' }) };
const descriptor: RouteDescriptor = {
  method: 'GET',
  path: '/v1/plugins',
  minimum: 'authenticated',
  caller: 'any',
  audit: { skip: 'test' },
  guard: { none: 'test' },
};
const route: MountedRoute = { ...descriptor, owner, handle: async () => jsonResponse({ ok: true }) };

/** An admission that refuses everything with the sentence and code a real device refusal carries. */
const refusing = (status: number, sentence: string, code: string): Admission => ({
  admit: () => ({ outcome: 'refused', response: errorResponse(status, sentence, code) }),
  admitMember: () => ({ outcome: 'refused', response: errorResponse(status, sentence, code) }),
  readmit: () => false,
  inventory: (_request, entries) => entries,
});

const device = (): ApiRequest => ({
  ...request('GET', '/v1/plugins', { local: false }),
  principal: {
    kind: 'device',
    holder: 'fy_device_id_abc' as HolderId,
    session: 'session-1' as SessionId,
    leaseUntil: 0 as never,
  },
  // A bearer-looking header must never reach a log line.
  headers: new Map([['authorization', 'Bearer SECRET-TOKEN-VALUE']]),
});

describe('a refused call is said at warn, with its reason', () => {
  test('public door refusals name their remote arrival instead of local', () => {
    for (const arrival of [
      { kind: 'door', door: 'own', plugin: 'connector' },
      { kind: 'door', door: 'tunnel' },
    ] as const) {
      const line = describeRefusal({
        table: 'route',
        method: 'GET',
        route: '/oauth/authorize',
        request: { ...request('GET', '/oauth/authorize'), arrival: arrival as never },
        response: errorResponse(403, 'no', 'forbidden'),
      });
      expect(line.fields.arrival).toBe(`door:${arrival.door}`);
    }
  });
  test('a refused device read says the route, the status, the code, the sentence and which device', async () => {
    const { log, said } = recording();
    const dispatcher = new Dispatcher(
      {
        admission: () =>
          refusing(403, 'this daemon cannot say what this device may do, so it is refusing', 'grant_undetermined'),
        outputGuard: () => undefined,
        version: '5.0.0',
        refused: note => {
          const line = describeRefusal(note);
          log.warn(line.message, line.fields);
        },
      },
      { routes: [route], sockets: [], memberRoutes: [] },
    );
    const response = await dispatcher.dispatch(device());
    expect(response.status).toBe(403);
    expect(said).toHaveLength(1);
    const line = said[0];
    expect(line?.level).toBe('warn');
    expect(line?.message).toBe(
      'refused GET /v1/plugins (403 grant_undetermined): this daemon cannot say what this device may do, so it is refusing',
    );
    expect(line?.fields).toMatchObject({
      who: 'device fy_device_id_abc',
      arrival: 'carried:relay',
      status: 403,
      code: 'grant_undetermined',
    });
  });

  test('no credential, bearer value or session id is ever in the line', () => {
    const note: RefusalNote = {
      table: 'route',
      method: 'GET',
      route: '/v1/plugins',
      request: device(),
      response: errorResponse(401, 'sign in', 'unauthorized'),
    };
    const { message, fields } = describeRefusal(note);
    const everything = JSON.stringify({ message, fields });
    expect(everything).not.toContain('SECRET-TOKEN-VALUE');
    expect(everything).not.toContain('session-1');
  });

  test('a bearer that matched nothing is named as such, never by its value', () => {
    const bearer: ApiRequest = {
      ...request('GET', '/v1/plugins'),
      headers: new Map([['authorization', 'Bearer SECRET']]),
    };
    const { fields, message } = describeRefusal({
      table: 'route',
      method: 'GET',
      route: '/v1/plugins',
      request: bearer,
      response: errorResponse(401, 'no', 'unauthorized'),
    });
    expect(fields?.who).toBe('a bearer that matched no credential');
    expect(JSON.stringify({ message, fields })).not.toContain('SECRET');
  });

  test("a path no route claims is logged as no route, not as the caller's own text", async () => {
    const { log, said } = recording();
    const dispatcher = new Dispatcher(
      {
        admission: () => refusing(401, 'who are you', 'unauthorized'),
        outputGuard: () => undefined,
        version: '5.0.0',
        refused: note => {
          const line = describeRefusal(note);
          log.warn(line.message, line.fields);
        },
      },
      { routes: [route], sockets: [], memberRoutes: [] },
    );
    await dispatcher.dispatch(request('GET', '/v1/some-secret-looking-path-abc123'));
    expect(said[0]?.message).toContain('(no route)');
    expect(said[0]?.message).not.toContain('abc123');
  });

  test('a missing admission (the daemon cannot check who is calling) is a refusal too', async () => {
    const seen: RefusalNote[] = [];
    const dispatcher = new Dispatcher(
      {
        admission: () => undefined,
        outputGuard: () => undefined,
        version: '5.0.0',
        refused: note => void seen.push(note),
      },
      { routes: [route], sockets: [], memberRoutes: [] },
    );
    const response = await dispatcher.dispatch(request('GET', '/v1/plugins'));
    expect(response.status).toBe(503);
    expect(seen.map(note => `${note.method} ${note.route} ${note.response.status}`)).toEqual(['GET /v1/plugins 503']);
  });

  test('an admitted call says nothing, and a throwing listener never changes the answer', async () => {
    const admitted: Admission = {
      admit: () => ({ outcome: 'admitted', standing: {} as never, actor: 'owner-tools' }),
      admitMember: () => ({ outcome: 'refused', response: errorResponse(403, 'x', 'x') }),
      readmit: () => true,
      inventory: (_request, entries) => entries,
    };
    const seen: RefusalNote[] = [];
    const quiet = new Dispatcher(
      {
        admission: () => admitted,
        outputGuard: () => undefined,
        version: '5.0.0',
        refused: note => void seen.push(note),
      },
      { routes: [route], sockets: [], memberRoutes: [] },
    );
    expect((await quiet.dispatch(request('GET', '/v1/plugins'))).status).toBe(200);
    expect(seen).toEqual([]);
    const throwing = new Dispatcher(
      {
        admission: () => refusing(403, 'no', 'grant_not_granted'),
        outputGuard: () => undefined,
        version: '5.0.0',
        refused: () => {
          throw new Error('the log is broken');
        },
      },
      { routes: [route], sockets: [], memberRoutes: [] },
    );
    expect((await throwing.dispatch(request('GET', '/v1/plugins'))).status).toBe(403);
  });
});

describe('the same refusal is said once a minute', () => {
  test('the first is said at once, the repeats are held, and the next window says how many were held', () => {
    const { log, said } = recording();
    let now = 1_000;
    const warnings = dedupedWarnings(log, () => now);
    const line = (): void => warnings.warn('refused GET /v1/plugins (403)', { who: 'device a' });
    line();
    line();
    line();
    expect(said).toHaveLength(1);
    now += REFUSAL_WINDOW_MS;
    line();
    expect(said).toHaveLength(2);
    expect(said[1]?.fields).toMatchObject({ who: 'device a', suppressed: 2 });
  });

  test('another device, or another reason, is its own line; other levels are never held', () => {
    const { log, said } = recording();
    const warnings = dedupedWarnings(log, () => 0);
    warnings.warn('refused GET /v1/plugins (403)', { who: 'device a' });
    warnings.warn('refused GET /v1/plugins (403)', { who: 'device b' });
    warnings.warn('refused GET /v1/plugins (401)', { who: 'device a' });
    warnings.info('hello');
    warnings.info('hello');
    expect(said.map(entry => entry.level)).toEqual(['warn', 'warn', 'warn', 'info', 'info']);
  });
});

describe('the log names the route, never the caller path', () => {
  test('an admission sentence that embeds METHOD /raw/path is said with the route template, so the dedupe key is stable', () => {
    const note = (path: string): RefusalNote => ({
      table: 'route',
      method: 'GET',
      route: '/v1/pair/devices/:deviceId',
      request: { ...request('GET', path), principal: device().principal as never },
      response: errorResponse(403, `the request may not use GET ${path}`, 'forbidden'),
    });
    const first = describeRefusal(note('/v1/pair/devices/abc-123'));
    const second = describeRefusal(note('/v1/pair/devices/zzz-999'));
    expect(first.message).toBe(
      'refused GET /v1/pair/devices/:deviceId (403 forbidden): the request may not use GET /v1/pair/devices/:deviceId',
    );
    expect(first.message).not.toContain('abc-123');
    expect(second.message).toBe(first.message);
  });

  test('a path no route claims is said as (no route), not as what the caller typed', () => {
    const line = describeRefusal({
      table: 'route',
      method: 'GET',
      route: undefined,
      request: request('GET', '/v1/secret-looking/path'),
      response: errorResponse(403, 'the request may not use GET /v1/secret-looking/path', 'forbidden'),
    });
    expect(line.message).not.toContain('secret-looking');
    expect(line.message).toContain('GET (no route)');
  });
});

describe('no refusal goes uncounted', () => {
  test('every held repeat is counted on the next line, across several windows', () => {
    const { log, said } = recording();
    let now = 0;
    const warnings = dedupedWarnings(log, () => now);
    const line = (): void => warnings.warn('refused GET /v1/plugins (403)', { who: 'device a' });
    line();
    line();
    now += REFUSAL_WINDOW_MS;
    line();
    line();
    line();
    line();
    now += REFUSAL_WINDOW_MS;
    line();
    const counted = said.map(entry => (entry.fields?.['suppressed'] as number | undefined) ?? 0);
    expect(counted).toEqual([0, 1, 3]);
    expect(counted.reduce((a, b) => a + b, 0) + said.length).toBe(7);
  });

  test('a flood of distinct strangers that resets the memory still says how many repeats it held', () => {
    const { log, said } = recording();
    const warnings = dedupedWarnings(log, () => 0);
    warnings.warn('refused', { who: 'device a' });
    warnings.warn('refused', { who: 'device a' });
    warnings.warn('refused', { who: 'device a' });
    for (let index = 0; index < 600; index += 1) warnings.warn('refused', { who: `stranger ${index}` });
    const reset = said.find(entry => entry.message === 'refusal memory was reset');
    expect(reset?.fields).toMatchObject({ suppressed: 2 });
  });
});

describe('every line in fyd.log carries its time', () => {
  test('a warn line, deduped or not, is written with an ISO `at` so a refusal can be matched to a reload', () => {
    const lines: string[] = [];
    const warnings = dedupedWarnings(
      scopedLog(
        fileLogSink(line => void lines.push(line)),
        'refusals',
      ),
      () => 0,
    );
    warnings.warn('refused GET /v1/plugins (403)', { who: 'device a' });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? '{}') as { at?: string; level?: string };
    expect(parsed.level).toBe('warn');
    expect(Number.isNaN(Date.parse(parsed.at ?? ''))).toBe(false);
  });
});
