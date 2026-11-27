import { describe, expect, test } from 'bun:test';
import {
  type ApiRequest,
  type ConfigFilesWriter,
  type ConfigWriteOutcome,
  defineConfig,
  headersFrom,
  queryFrom,
} from '@ferretry/kernel/contract';
import { config, runInCall, scopedLog, state } from '@ferretry/kernel/host';
import { fixedClock } from '@ferretry/kernel/testing';
import { z } from 'zod';
import { FULL_DEVICE_GRANTS } from '../../../../contract/index.ts';
import { CLIENT_HEADER } from '../../../../daemon/lib/api/admission.ts';
import { ADMIN, admit, descriptor, FERRET_TOKEN, local, type World, world } from '../support.ts';

/**
 * R-0419 R-0072 R-0274: the kernel's REAL config route handlers, asked through Gate's REAL `GateAdmission` — the seam
 * the other tests fake from each side (kernel route tests use a fake Gate; Gate tests call the policy function). If
 * `judgeConfigAccess` were dropped from the admission, or the call's actor and standing did not reach it from
 * `runInCall`, the routes would answer 403 to everyone and nobody would notice until the feature was needed.
 */
const updatesDef = defineConfig({
  file: 'machine.yaml',
  schema: z.strictObject({ limit: z.number().default(10) }),
  axis: 'configure',
  loosens: () => [],
});

interface Recorder {
  readonly writes: { readonly confirmedLoosening: boolean | undefined }[];
  readonly writer: ConfigFilesWriter;
}

function recordingWriter(): Recorder {
  const writes: { confirmedLoosening: boolean | undefined }[] = [];
  const applied: ConfigWriteOutcome = { kind: 'written', etag: 'e1', loosened: [] };
  const writer = {
    declarations: () => [{ plugin: 'runtimes', def: updatesDef }],
    read: async () => ({
      path: 'machine.yaml',
      exists: false,
      text: undefined,
      etag: 'absent',
      status: { state: 'ok' },
    }),
    write: async (_target: unknown, _edit: unknown, options?: { confirmedLoosening?: boolean }) => {
      writes.push({ confirmedLoosening: options?.confirmedLoosening });
      return applied;
    },
    held: () => [],
    confirm: async () => false,
    discard: async () => false,
  } as unknown as ConfigFilesWriter;
  return { writes, writer };
}

const put = (body: unknown): ApiRequest => ({
  method: 'PUT',
  path: '/v1/config/file',
  query: queryFrom([]),
  headers: headersFrom({}),
  arrival: local(true),
  text: async () => JSON.stringify(body),
});

function routesOver(w: World, recorder: Recorder) {
  return config.configRoutes({
    writer: () => recorder.writer,
    admission: () => w.gate,
    home: '/home/fy',
    binary: 'fy',
  });
}

/** The route as the kernel declares it asks of admission: the fleet's `use`. */
const route = descriptor({ capability: { capability: 'fleet', axis: 'use' } as never });

const standingFor = (w: World, options: Parameters<typeof admit>[2]) => {
  const { decision } = admit(w, route, options);
  if (decision.outcome !== 'admitted') throw new Error('expected admitted');
  return decision;
};

describe('R-0419 the kernel’s config route is judged by GateAdmission.judgeConfigAccess, with the call’s own actor and standing', () => {
  test('browsers.yaml: a carried device needs Browser configure; an allowed proxy proposal stays pending', async () => {
    const browsers = defineConfig({
      file: 'browsers.yaml',
      schema: z.strictObject({
        identities: z.record(z.string(), z.strictObject({ proxy: z.strictObject({ url: z.string() }) })).default({}),
      }),
      axis: 'configure',
      loosens: () => ['new identity proxy'],
    });
    const w = world();
    w.enrol('denied', { ...FULL_DEVICE_GRANTS, browser: { use: false, configure: false } });
    w.enrol('allowed');
    const files = config.createConfigFiles({
      home: '/home/fy',
      defs: [{ plugin: 'browsers', def: browsers }],
      fs: state.createMemoryHostFs(),
      clock: fixedClock('2026-11-27T09:00:00Z'),
      log: scopedLog(() => {}, 'test'),
      binary: 'fy',
    });
    await files.reload();
    const handlers = config.configRoutes({
      writer: () => files.writer(),
      admission: () => w.gate,
      home: '/home/fy',
      binary: 'fy',
    });
    const body = {
      path: 'browsers.yaml',
      text: 'identities:\n  work:\n    proxy:\n      url: http://proxy.example.test:8080\n',
    };
    const write = async (device: string) => {
      const decision = standingFor(w, { device });
      return await runInCall({ actor: decision.actor, standing: decision.standing }, () =>
        handlers['PUT /v1/config/file']({ request: put(body), params: new Map() } as never),
      );
    };
    expect((await write('denied')).status).toBe(403);
    expect(files.writer().held()).toEqual([]);
    const allowed = await write('allowed');
    expect(allowed.status).toBe(200);
    expect(JSON.parse(allowed.body).outcome).toBe('pending');
    expect(files.writer().held()).toHaveLength(1);
  });
  test('the owner at the machine: Gate lets the real PUT handler write, and may loosen in the same act', async () => {
    const w = world();
    const recorder = recordingWriter();
    const decision = standingFor(w, { bearer: ADMIN, arrival: local(), headers: { [CLIENT_HEADER]: 'cli' } });
    const handlers = routesOver(w, recorder);
    const response = await runInCall({ actor: decision.actor, standing: decision.standing }, () =>
      handlers['PUT /v1/config/file']({
        request: put({ path: 'machine.yaml', text: 'limit: 3\n' }),
        params: new Map(),
      } as never),
    );
    expect(response.status).toBe(200);
    expect(recorder.writes).toEqual([{ confirmedLoosening: true }]);
  });

  test('a ferret’s standing reaches Gate through the call scope: owner_only, and nothing is written', async () => {
    const w = world();
    const recorder = recordingWriter();
    const decision = standingFor(w, { bearer: FERRET_TOKEN, arrival: local(true) });
    const handlers = routesOver(w, recorder);
    const response = await runInCall({ actor: decision.actor, standing: decision.standing }, () =>
      handlers['PUT /v1/config/file']({
        request: put({ path: 'machine.yaml', text: 'limit: 3\n' }),
        params: new Map(),
      } as never),
    );
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body).code).toBe('owner_only');
    expect(recorder.writes).toEqual([]);
  });

  test('a call run outside any call scope (a job) has no standing, so Gate refuses: fail closed, nothing written', async () => {
    const w = world();
    const recorder = recordingWriter();
    const handlers = routesOver(w, recorder);
    const response = await handlers['PUT /v1/config/file']({
      request: put({ path: 'machine.yaml', text: 'limit: 3\n' }),
      params: new Map(),
    } as never);
    expect(response.status).toBe(403);
    expect(recorder.writes).toEqual([]);
  });

  test('R-0072 a read goes through the same seam: the owner reads, the call without standing does not', async () => {
    const w = world();
    const recorder = recordingWriter();
    const decision = standingFor(w, { bearer: ADMIN, arrival: local(), headers: { [CLIENT_HEADER]: 'cli' } });
    const handlers = routesOver(w, recorder);
    const read = (): ApiRequest => ({
      method: 'GET',
      path: '/v1/config/file',
      query: queryFrom([['path', 'machine.yaml']]),
      headers: headersFrom({}),
      arrival: local(true),
      text: async () => '',
    });
    const owner = await runInCall({ actor: decision.actor, standing: decision.standing }, () =>
      handlers['GET /v1/config/file']({ request: read(), params: new Map() } as never),
    );
    expect(owner.status).toBe(200);
    const none = await handlers['GET /v1/config/file']({ request: read(), params: new Map() } as never);
    expect(none.status).toBe(403);
  });
});
