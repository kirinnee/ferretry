import { describe, expect, test } from 'bun:test';
import type {
  ApiRequest,
  ApiResponse,
  CallContext,
  RouteHandler,
  ScopedRoute,
  StateFileDef,
} from '@ferretry/kernel/contract';
import { err, ok } from '@ferretry/std';
import {
  AdminTokenFile,
  type Admission,
  AuditLogFile,
  cap,
  DEFAULT_GATE_CONFIG,
  type GateApi,
  type GateConfig,
  GatePolicyChanged,
  WardenTokenFile,
} from '../../../contract/index.ts';
import gateDaemon from '../../../daemon/index.ts';
import type { ConfigFileStatus } from '../../../daemon/lib/policy/in-effect.ts';
import manifest, { GrantAuditFile } from '../../../manifest.ts';
import { ADMIN, carried, descriptor, local, WARDEN } from './support.ts';

// ─── a minimal kernel: only the ports Gate's build touches, each observable ─────────────────────────────────────────

interface FakeKernelOptions {
  /** `gate.yaml` as the kernel's config port parses it; `undefined` is "no file in effect". */
  readonly config?: GateConfig | 'throws';
  /** The kernel seam `ConfigPort.fileState`; left out, the port has none (this kernel). */
  readonly fileState?: ConfigFileStatus;
  /** Secret files present before boot (path → text). */
  readonly secrets?: Readonly<Record<string, string>>;
  /** JSONL files present before boot (path → records, already without their format stamp). */
  readonly jsonl?: Readonly<Record<string, readonly unknown[]>>;
  /** Holds every state read until released: a slow disk, to race the eager load against the start job. */
  readonly slowReads?: boolean;
}

function boot(options: FakeKernelOptions = {}) {
  const secrets = new Map(Object.entries(options.secrets ?? {}));
  const jsonl = new Map<string, unknown[]>(Object.entries(options.jsonl ?? {}).map(([k, v]) => [k, [...v]]));
  const reads: string[] = [];
  const writes: string[] = [];
  const jobs = new Map<string, () => Promise<void>>();
  const releases: (() => void)[] = [];
  const watchers: (() => void)[] = [];
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
      jsonl.set(file.path, [...(jsonl.get(file.path) ?? []), entry]);
    },
    async *lines(file: StateFileDef) {
      for (const entry of jsonl.get(file.path) ?? []) yield entry;
    },
    async remove(file: StateFileDef) {
      writes.push(file.path);
      jsonl.delete(file.path);
      secrets.delete(file.path);
    },
    update: async () => err({ file: 'x', reason: 'io' as const, sentence: 'not used' }),
    list: async () => [],
    sqlite: () => {
      throw new Error('not used');
    },
    damaged: () => [],
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
    ...(options.fileState === undefined ? {} : { fileState: () => options.fileState }),
  };
  const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log };
  const kernel = {
    log,
    state,
    config,
    jobs: { add: (job: { id: string; run: () => Promise<void> }) => jobs.set(job.id, job.run) },
    events: {
      publish: (event: { name: string }, payload: unknown) => published.push({ event: event.name, payload }),
      subscribe: () => () => undefined,
    },
    clock: { now: () => '2026-11-07T12:00:00.000Z', nowMs: () => Date.parse('2026-11-07T12:00:00.000Z') },
    lifecycle: { onStop() {}, onStart() {} },
  };
  const hooks = { provider: () => 'unavailable', invoke: async () => [] };
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
    jsonl,
    jobs,
    watchers,
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
  return await handler({ request, params: new Map(), ...decision.standing } as CallContext);
}

const bodyOf = (response: ApiResponse): Record<string, unknown> =>
  JSON.parse(String(response.body)) as Record<string, unknown>;

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

describe('the config write seam in the built daemon', () => {
  test('R-0224 PATCH /v1/security answers 503 config_write_unavailable after judging, and nothing is written', async () => {
    const built = boot({ secrets: seeded, config: DEFAULT_GATE_CONFIG });
    await built.jobs.get('gate.tokens')?.();
    const before = [...built.writes];
    const response = await dispatch(built, 'PATCH /v1/security', { bearer: ADMIN, body: { unlockValidityHours: 4 } });
    expect(response.status).toBe(503);
    expect(bodyOf(response).code).toBe('config_write_unavailable');
    await built.settle();
    expect(built.writes.filter(path => !before.includes(path) && path !== AuditLogFile.path)).toEqual([]);
    expect(JSON.stringify(built.jsonl.get(AuditLogFile.path) ?? [])).not.toContain('security.changed');
  });

  test('R-0221 PATCH /v1/grants answers 503 config_write_unavailable, and no history line claims a change', async () => {
    const built = boot({ secrets: seeded, config: DEFAULT_GATE_CONFIG });
    await built.jobs.get('gate.tokens')?.();
    const response = await dispatch(built, 'PATCH /v1/grants', { bearer: ADMIN, body: { fleet: { use: false } } });
    expect(response.status).toBe(503);
    expect(bodyOf(response).code).toBe('config_write_unavailable');
    expect(built.jsonl.get(GrantAuditFile.path) ?? []).toEqual([]);
  });
});

describe('gate.yaml in the built daemon', () => {
  test('G152 G6 no gate.yaml is the product default', () => {
    const built = boot({ config: undefined, fileState: { state: 'absent', inEffect: false, sentences: [] } });
    expect(built.half.provides.gate.policy()).toEqual(DEFAULT_GATE_CONFIG);
    expect(boot({ config: undefined }).half.provides.gate.policy()).toEqual(DEFAULT_GATE_CONFIG);
  });

  test('G153 an invalid first gate.yaml is undetermined, never the permissive defaults (kernel fileState seam)', () => {
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
      jsonl: { [GrantAuditFile.path]: [good(1), { at: good(2).at, actor: 123, changes: [] }, good(3), 'not-a-record'] },
    });
    await built.jobs.get('gate.tokens')?.();
    const response = await dispatch(built, 'GET /v1/grants/audit', { bearer: ADMIN });
    expect(response.status).toBe(200);
    const body = bodyOf(response) as { entries: { at: string }[]; unreadable: number; truncated: boolean };
    expect(body.entries.map(entry => entry.at)).toEqual([good(3).at, good(1).at]);
    expect(body.unreadable).toBe(2);
    expect(body.truncated).toBe(false);
  });
});

describe('grant provenance in the built daemon', () => {
  test('G155 a gate.yaml with no grants key reports every capability as a default', async () => {
    const built = boot({ secrets: seeded, config: DEFAULT_GATE_CONFIG });
    await built.jobs.get('gate.tokens')?.();
    const response = await dispatch(built, 'GET /v1/grants', { bearer: ADMIN });
    const body = bodyOf(response) as { capabilities: { origin: string }[] };
    expect(body.capabilities.every(capability => capability.origin === 'default')).toBe(true);
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
});
