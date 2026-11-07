import { describe, expect, test } from 'bun:test';
import { ApiError, errorResponse } from '@ferretry/kernel/contract';
import type {
  ApiRequest,
  ApiResponse,
  CallContext,
  ConfigEdit,
  ConfigFileStatus,
  ConfigTarget,
  ConfigWriteOutcome,
  RouteHandler,
  ScopedRoute,
  StateFileDef,
} from '@ferretry/kernel/contract';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import { ok } from '@ferretry/std';
import {
  AdminTokenFile,
  type Admission,
  cap,
  Credentials,
  type CredentialProvider,
  DEFAULT_GATE_CONFIG,
  type GateApi,
  type GateConfig,
  GatePolicyChanged,
  LIMITED_DEVICE_GRANTS,
  WardenTokenFile,
} from '../../../contract/index.ts';
import gateDaemon from '../../../daemon/index.ts';
import manifest, { GrantAuditFile } from '../../../manifest.ts';
import { FakeDeviceProvider, holder } from '../../../contract/testing/index.ts';
import { ADMIN, carried, descriptor, local, request, WARDEN } from './support.ts';

// ─── a minimal kernel: only the ports Gate's build touches, each observable ─────────────────────────────────────────

interface FakeKernelOptions {
  /** `gate.yaml` as the kernel's config port parses it; `undefined` is "no file in effect". */
  readonly config?: GateConfig | 'throws';
  /** The kernel's `ConfigPort.fileState`; left out, an absent file. */
  readonly fileState?: ConfigFileStatus;
  /** `gate.yaml`'s raw text as the kernel's writer reads it; left out, no file. */
  readonly rawConfig?: string;
  /** What the kernel's config writer answers a write; left out, `written`. */
  readonly writeOutcome?: ConfigWriteOutcome;
  /** Secret files present before boot (path → text). */
  readonly secrets?: Readonly<Record<string, string>>;
  /** JSONL files present before boot (path → raw text, one stamped record per line). */
  readonly jsonl?: Readonly<Record<string, string>>;
  /** Holds every state read until released: a slow disk, to race the eager load against the start job. */
  readonly slowReads?: boolean;
  /** The `credentials` providers the hooks answer, by kind; a kind left out is "that plugin is off". */
  readonly credentials?: Readonly<Partial<Record<'device' | 'member', CredentialProvider>>>;
}

function boot(options: FakeKernelOptions = {}) {
  const secrets = new Map(Object.entries(options.secrets ?? {}));
  // The kernel's own in-memory state port for the journals: each line checked on its own, the tail bounded.
  const folder = new MemoryStateFolder();
  const journals = folder.port(manifest.data?.state ?? []);
  for (const [path, text] of Object.entries(options.jsonl ?? {})) folder.files.set(path, text);
  const configWrites: { target: ConfigTarget; edit: ConfigEdit; options: unknown }[] = [];
  const reads: string[] = [];
  const writes: string[] = [];
  const jobs = new Map<string, () => Promise<void>>();
  const releases: (() => void)[] = [];
  const watchers: (() => void)[] = [];
  const stops: (() => void | Promise<void>)[] = [];
  const published: { event: string; payload: unknown }[] = [];
  const held = (): Promise<void> =>
    options.slowReads === true ? new Promise(resolve => releases.push(resolve)) : Promise.resolve();
  const state = {
    async read(file: StateFileDef) {
      reads.push(file.path);
      await held();
      return ok(secrets.get(file.path));
    },
    async write(file: StateFileDef, value: unknown) {
      writes.push(file.path);
      secrets.set(file.path, String(value));
    },
    async append(file: StateFileDef, entry: unknown) {
      writes.push(file.path);
      await journals.append(file, entry);
    },
    records: journals.records,
    tail: journals.tail,
    version: journals.version,
    async remove(file: StateFileDef) {
      writes.push(file.path);
      secrets.delete(file.path);
      if (file.store === 'jsonl') await journals.remove(file);
    },
    damaged: () => [],
  };
  const absent: ConfigFileStatus = { state: 'absent', inEffect: false, sentences: [] };
  const configFiles = {
    declarations: () => [{ plugin: 'gate', def: manifest.data?.config?.[0] }],
    read: async () => ({
      path: 'gate.yaml',
      exists: options.rawConfig !== undefined,
      text: options.rawConfig,
      etag: 'e1',
      status: options.fileState ?? absent,
    }),
    write: async (target: ConfigTarget, edit: ConfigEdit, writeOptions: unknown): Promise<ConfigWriteOutcome> => {
      configWrites.push({ target, edit, options: writeOptions });
      return options.writeOutcome ?? { kind: 'written', etag: 'e2', loosened: [] };
    },
  };
  const config = {
    file: () => {
      if (options.config === 'throws') throw new Error('gate.yaml cannot be read');
      return options.config;
    },
    collection: () => new Map(),
    watch: (_def: unknown, listener: () => void) => {
      watchers.push(listener);
      return () => undefined;
    },
    fileState: () =>
      options.fileState ?? (options.config === undefined ? absent : { state: 'valid', inEffect: true, sentences: [] }),
  };
  const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log };
  const kernel = {
    log,
    state,
    config,
    configFiles,
    jobs: { add: (job: { id: string; run: () => Promise<void> }) => jobs.set(job.id, job.run) },
    events: {
      publish: (event: { name: string }, payload: unknown) => published.push({ event: event.name, payload }),
      subscribe: () => () => undefined,
    },
    clock: { now: () => '2026-11-07T12:00:00.000Z', nowMs: () => Date.parse('2026-11-07T12:00:00.000Z') },
    lifecycle: { onStop: (fn: () => void | Promise<void>) => stops.push(fn), onStart() {} },
  };
  const credentials = { ...options.credentials };
  const hooks = {
    provider: (hook: { name: string }, key: string) =>
      (hook.name === Credentials.name ? credentials[key as 'device' | 'member'] : undefined) ?? 'unavailable',
    invoke: async () => [],
  };
  const build = gateDaemon.build;
  if (build === undefined) throw new Error('the daemon half is real');
  const half = build({ manifest, needs: {}, uses: {}, kernel, hooks } as never) as unknown as {
    readonly routes: Readonly<Record<string, RouteHandler>>;
    readonly provides: { readonly gate: GateApi; readonly admission: Admission };
  };
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  };
  return {
    half,
    reads,
    writes,
    secrets,
    folder,
    configWrites,
    jobs,
    watchers,
    stops,
    credentials,
    published,
    settle,
    release: () => {
      for (const release of releases.splice(0)) release();
    },
  };
}

/** A call with a body, as the kernel hands it over. */
function call(
  method: string,
  path: string,
  init: { bearer?: string; body?: unknown; arrival?: ApiRequest['arrival'] },
) {
  const headers = new Map<string, string>();
  if (init.bearer !== undefined) headers.set('authorization', `Bearer ${init.bearer}`);
  const request: ApiRequest = {
    method,
    path,
    query: new Map(),
    headers,
    arrival: init.arrival ?? local(),
    text: async () => (init.body === undefined ? '' : JSON.stringify(init.body)),
  } as ApiRequest;
  return request;
}

const routeOf = (key: string): ScopedRoute => {
  const found = manifest.actions.routes.find(route => route.key === key);
  if (found === undefined) throw new Error(`no route ${key}`);
  return found as ScopedRoute;
};

/** Admission, then the handler, as the dispatcher runs them. */
async function dispatch(
  built: ReturnType<typeof boot>,
  key: string,
  init: { bearer?: string; body?: unknown; arrival?: ApiRequest['arrival'] },
): Promise<ApiResponse> {
  const route = routeOf(key);
  const request = call(route.method, route.path, init);
  const decision = built.half.provides.admission.admit({
    table: 'route',
    descriptor: route,
    request,
    params: new Map(),
  });
  if (decision.outcome === 'refused') return decision.response;
  const handler = built.half.routes[key];
  if (handler === undefined) throw new Error(`no handler for ${key}`);
  try {
    return await handler({ request, params: new Map(), ...decision.standing } as CallContext);
  } catch (error) {
    // As the kernel's dispatcher answers a handler's `ApiError`.
    if (error instanceof ApiError) return errorResponse(error.status, error.message, error.code ?? 'error');
    throw error;
  }
}

const bodyOf = (response: ApiResponse): Record<string, unknown> =>
  JSON.parse(String(response.body)) as Record<string, unknown>;

/** One journal line as the kernel lands it: `format` first, then the record's own keys. */
const stamped = (record: object): string => JSON.stringify({ format: 1, ...record });

const seeded = { [AdminTokenFile.path]: `${ADMIN}\n`, [WardenTokenFile.path]: `${WARDEN}\n` };

describe('the daemon tokens in the built daemon', () => {
  test('F-0025 F-0041 the eager load and the start job share ONE load: one mint, and the persisted token is the accepted one', async () => {
    const built = boot({ slowReads: true });
    const job = built.jobs.get('gate.tokens');
    expect(job).toBeDefined();
    // The start job runs while the eager load is still waiting on the disk.
    const started = job?.();
    await built.settle();
    built.release();
    await built.settle();
    built.release();
    await started;
    await built.settle();
    expect(built.reads.filter(path => path === AdminTokenFile.path)).toHaveLength(1);
    expect(built.reads.filter(path => path === WardenTokenFile.path)).toHaveLength(1);
    expect(built.writes.filter(path => path === AdminTokenFile.path)).toHaveLength(1);
    const persisted = built.secrets.get(AdminTokenFile.path)?.trim() ?? '';
    expect(persisted).not.toBe('');
    const decision = built.half.provides.admission.admit({
      table: 'route',
      descriptor: descriptor(),
      request: call('GET', '/v1/test', { bearer: persisted }),
      params: new Map(),
    });
    expect(decision.outcome).toBe('admitted');
  });
});

describe('config writes in the built daemon', () => {
  test('R-0224 G111 PATCH /v1/security at the machine writes the security block through the kernel writer, member unlock kept', async () => {
    const built = boot({ secrets: seeded, config: DEFAULT_GATE_CONFIG });
    await built.jobs.get('gate.tokens')?.();
    const response = await dispatch(built, 'PATCH /v1/security', { bearer: ADMIN, body: { unlockValidityHours: 4 } });
    expect(response.status).toBe(200);
    expect(built.configWrites).toHaveLength(1);
    const [write] = built.configWrites;
    expect(write?.target.plugin).toBe('gate');
    expect(write?.edit).toEqual({
      patch: { security: { ...DEFAULT_GATE_CONFIG.security, unlockValidityHours: 4 } },
    });
    // The route already decided this caller may make the change: the writer is told so, never asked to hold it.
    expect(write?.options).toEqual({ confirmedLoosening: true });
  });

  test('R-0221 G123 PATCH /v1/grants writes the grants block, then records the change in the grant history', async () => {
    const built = boot({ secrets: seeded, config: DEFAULT_GATE_CONFIG });
    await built.jobs.get('gate.tokens')?.();
    const response = await dispatch(built, 'PATCH /v1/grants', { bearer: ADMIN, body: { fleet: { use: false } } });
    expect(response.status).toBe(200);
    expect(built.configWrites[0]?.edit).toEqual({
      patch: { grants: { ...DEFAULT_GATE_CONFIG.grants, fleet: { ...DEFAULT_GATE_CONFIG.grants.fleet, use: false } } },
    });
    expect(built.folder.raw(GrantAuditFile)).toContain('fleet.use=off');
  });

  test('R-0221 a save the kernel writer refuses answers 503 config_not_saved, and no history line claims a change', async () => {
    const built = boot({
      secrets: seeded,
      config: DEFAULT_GATE_CONFIG,
      writeOutcome: { kind: 'refused', reason: 'schema', issues: [{ path: 'grants', message: 'not a grant' }] },
    });
    await built.jobs.get('gate.tokens')?.();
    const response = await dispatch(built, 'PATCH /v1/grants', { bearer: ADMIN, body: { fleet: { use: false } } });
    expect(response.status).toBe(503);
    expect(bodyOf(response).code).toBe('config_not_saved');
    expect(built.folder.raw(GrantAuditFile)).toBeUndefined();
  });

  test('R-0224 a save the writer holds for the owner is not reported as made', async () => {
    const built = boot({
      secrets: seeded,
      config: DEFAULT_GATE_CONFIG,
      writeOutcome: { kind: 'held', etag: 'e3', id: 'h1', sentences: ['security unlockValidityHours loosened'] },
    });
    await built.jobs.get('gate.tokens')?.();
    const response = await dispatch(built, 'PATCH /v1/security', { bearer: ADMIN, body: { unlockValidityHours: 4 } });
    expect(response.status).toBe(503);
    expect(bodyOf(response).code).toBe('config_not_saved');
  });

  test('G131 a plugin’s own loosening config write with no call standing is held by the built admission', () => {
    const built = boot({ config: DEFAULT_GATE_CONFIG });
    for (const actor of ['ferret', 'warden', 'owner-viewer', 'owner-tools', 'owner-input'] as const)
      expect(
        built.half.provides.admission.judgeConfigWrite?.({
          plugin: 'warden',
          path: 'warden.yaml',
          removal: false,
          sentences: ['the budget rose'],
          actor,
        }),
      ).toBe('hold');
  });
});

describe('gate.yaml in the built daemon', () => {
  test('G152 G6 no gate.yaml is the product default', () => {
    const built = boot({ config: undefined, fileState: { state: 'absent', inEffect: false, sentences: [] } });
    expect(built.half.provides.gate.policy()).toEqual(DEFAULT_GATE_CONFIG);
    expect(boot({ config: undefined }).half.provides.gate.policy()).toEqual(DEFAULT_GATE_CONFIG);
  });

  test('G153 an invalid first gate.yaml is undetermined, never the permissive defaults (the kernel fileState)', () => {
    const built = boot({
      secrets: seeded,
      config: undefined,
      fileState: { state: 'invalid', inEffect: false, sentences: ['grants.fleet.use: expected a boolean'] },
    });
    expect(built.half.provides.gate.policy()).toBeUndefined();
    const decision = built.half.provides.admission.admit({
      table: 'route',
      descriptor: descriptor({ capability: cap('fleet', 'use') }),
      request: call('GET', '/v1/test', { bearer: ADMIN, arrival: carried() }),
      params: new Map(),
    });
    expect(decision.outcome).toBe('refused');
  });

  test('G153 an invalid edit keeps the last good gate.yaml in effect', () => {
    const narrowed = { ...DEFAULT_GATE_CONFIG, warden: { remote: true } };
    const built = boot({ config: narrowed, fileState: { state: 'invalid', inEffect: true, sentences: ['bad'] } });
    expect(built.half.provides.gate.policy()).toEqual(narrowed);
  });

  test('G154 a gate.yaml that cannot be read at runtime is undetermined', () => {
    expect(boot({ config: 'throws' }).half.provides.gate.policy()).toBeUndefined();
  });
});

describe('the grant history in the built daemon', () => {
  test('G160 F-0251 one damaged entry is counted; the valid entries around it are still served', async () => {
    const good = (n: number) => ({ at: `2026-11-07T12:00:0${n}.000Z`, actor: 'admin-cli', changes: ['fleet.use=off'] });
    const built = boot({
      secrets: seeded,
      config: DEFAULT_GATE_CONFIG,
      jsonl: {
        [GrantAuditFile.path]: [
          stamped(good(1)),
          stamped({ at: good(2).at, actor: 123, changes: [] }),
          stamped(good(3)),
          'not-a-record',
          '',
        ].join('\n'),
      },
    });
    await built.jobs.get('gate.tokens')?.();
    const response = await dispatch(built, 'GET /v1/grants/audit', { bearer: ADMIN });
    expect(response.status).toBe(200);
    const body = bodyOf(response) as { entries: { at: string }[]; unreadable: number; truncated: boolean };
    expect(body.entries.map(entry => entry.at)).toEqual([good(3).at, good(1).at]);
    expect(body.unreadable).toBe(2);
    expect(body.truncated).toBe(false);
  });

  test('G160 a read covers only the newest 64 KiB: older records are not read, and the history says so', async () => {
    const line = (n: number) =>
      stamped({
        at: `2026-11-07T12:00:00.${String(n % 1000).padStart(3, '0')}Z`,
        actor: 'admin-cli',
        changes: ['fleet.use=off'],
      });
    const lines = Array.from({ length: 1_000 }, (_, n) => line(n));
    const built = boot({
      secrets: seeded,
      config: DEFAULT_GATE_CONFIG,
      jsonl: { [GrantAuditFile.path]: `${lines.join('\n')}\n` },
    });
    await built.jobs.get('gate.tokens')?.();
    const body = bodyOf(await dispatch(built, 'GET /v1/grants/audit', { bearer: ADMIN })) as {
      entries: unknown[];
      unreadable: number;
      truncated: boolean;
    };
    expect(body.entries).toHaveLength(50);
    expect(body.unreadable).toBe(0);
    expect(body.truncated).toBe(true);
  });
});

describe('grant provenance in the built daemon', () => {
  test('G155 a gate.yaml with no grants key reports every capability as a default', async () => {
    const built = boot({
      secrets: seeded,
      config: DEFAULT_GATE_CONFIG,
      rawConfig: 'security:\n  unlockOnOpen: true\n',
    });
    await built.jobs.get('gate.tokens')?.();
    await built.settle();
    const response = await dispatch(built, 'GET /v1/grants', { bearer: ADMIN });
    const body = bodyOf(response) as { capabilities: { origin: string }[] };
    expect(body.capabilities.every(capability => capability.origin === 'default')).toBe(true);
  });

  test('G155 a capability the file names reads as the config file, per capability, from the raw text', async () => {
    const built = boot({
      secrets: seeded,
      config: DEFAULT_GATE_CONFIG,
      rawConfig: 'grants:\n  fleet:\n    use: true\n',
    });
    await built.jobs.get('gate.tokens')?.();
    await built.settle();
    const body = bodyOf(await dispatch(built, 'GET /v1/grants', { bearer: ADMIN })) as {
      capabilities: { capability: string; origin: string }[];
    };
    expect(body.capabilities.find(entry => entry.capability === 'fleet')?.origin).toBe('config file');
    expect(body.capabilities.find(entry => entry.capability === 'terminal')?.origin).toBe('default');
  });
});

describe('a policy change in the built daemon', () => {
  test('G149 a gate.yaml change publishes GatePolicyChanged with a new generation, so every open stream is re-asked', () => {
    const built = boot({ config: DEFAULT_GATE_CONFIG });
    expect(built.watchers).toHaveLength(1);
    built.watchers[0]?.();
    built.watchers[0]?.();
    expect(built.published).toEqual([
      { event: GatePolicyChanged.name, payload: { generation: 1 } },
      { event: GatePolicyChanged.name, payload: { generation: 2 } },
    ]);
  });

  test('G149 a gate.yaml change tells the admission’s watchers, so the kernel re-asks every open stream', () => {
    const built = boot({ config: DEFAULT_GATE_CONFIG });
    let told = 0;
    built.half.provides.admission.watch?.(() => {
      told += 1;
    });
    expect(told).toBe(0);
    built.watchers[0]?.();
    expect(told).toBe(1);
    built.watchers[0]?.();
    expect(told).toBe(2);
  });
});

describe('a device-grant change in the built daemon', () => {
  /** One admitted-or-refused ask for a device, which is when Gate binds the provider. */
  const ask = (built: ReturnType<typeof boot>, device: string): void => {
    built.half.provides.admission.admit({
      table: 'route',
      descriptor: descriptor(),
      request: request({ device }),
      params: new Map(),
    });
  };

  test('G149 a device’s grant change tells the admission’s watchers, with no gate.yaml change', () => {
    const devices = new FakeDeviceProvider();
    devices.enrol(holder('d1'));
    const built = boot({ config: DEFAULT_GATE_CONFIG, credentials: { device: devices } });
    let told = 0;
    built.half.provides.admission.watch?.(() => {
      told += 1;
    });
    ask(built, 'd1');
    expect(told).toBe(0);
    devices.narrow(holder('d1'), LIMITED_DEVICE_GRANTS);
    expect(told).toBe(1);
    devices.revoke(holder('d1'));
    expect(told).toBe(2);
    expect(built.published).toEqual([]);
  });

  test('G149 a provider is followed once, however many calls ask for it', () => {
    const devices = new FakeDeviceProvider();
    devices.enrol(holder('d1'));
    const built = boot({ config: DEFAULT_GATE_CONFIG, credentials: { device: devices } });
    let told = 0;
    built.half.provides.admission.watch?.(() => {
      told += 1;
    });
    for (let i = 0; i < 3; i += 1) ask(built, 'd1');
    devices.revoke(holder('d1'));
    expect(told).toBe(1);
  });

  test('G149 a replaced provider’s notices stop and the new one’s start', () => {
    const first = new FakeDeviceProvider();
    const second = new FakeDeviceProvider();
    first.enrol(holder('d1'));
    second.enrol(holder('d1'));
    const built = boot({ config: DEFAULT_GATE_CONFIG, credentials: { device: first } });
    let told = 0;
    built.half.provides.admission.watch?.(() => {
      told += 1;
    });
    ask(built, 'd1');
    built.credentials.device = second;
    ask(built, 'd1');
    first.revoke(holder('d1'));
    expect(told).toBe(0);
    second.revoke(holder('d1'));
    expect(told).toBe(1);
  });

  test('G149 a stopped provider and a daemon stop both drop the subscription', async () => {
    const devices = new FakeDeviceProvider();
    devices.enrol(holder('d1'));
    const built = boot({ config: DEFAULT_GATE_CONFIG, credentials: { device: devices } });
    let told = 0;
    built.half.provides.admission.watch?.(() => {
      told += 1;
    });
    ask(built, 'd1');
    delete built.credentials.device;
    ask(built, 'd1');
    devices.narrow(holder('d1'), LIMITED_DEVICE_GRANTS);
    expect(told).toBe(0);

    built.credentials.device = devices;
    ask(built, 'd1');
    for (const stop of built.stops) await stop();
    devices.revoke(holder('d1'));
    expect(told).toBe(0);
  });
});
