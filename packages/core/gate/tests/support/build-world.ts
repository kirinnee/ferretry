import { ApiError, errorResponse } from '@ferretry/kernel/contract';
import type {
  ApiRequest,
  ApiResponse,
  CallContext,
  ConfigEdit,
  ConfigFileStatus,
  ConfigFilesWriter,
  ConfigTarget,
  ConfigWriteOutcome,
  RouteHandler,
  ScopedRoute,
  StateFileDef,
} from '@ferretry/kernel/contract';
import { config as kernelConfig, state as kernelState } from '@ferretry/kernel/host';
import { readConfigText } from '@ferretry/std/yaml';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import { ok } from '@ferretry/std';
import {
  AdminTokenFile,
  type Admission,
  Credentials,
  type CredentialProvider,
  type GateApi,
  type GateConfig,
  GateConfigFile,
  StepUp,
  type StepUpWitness,
  WardenTokenFile,
} from '../../contract/index.ts';
import gateDaemon from '../../daemon/index.ts';
import manifest from '../../manifest.ts';
import { ADMIN, local, WARDEN } from '../unit/daemon/support.ts';

// ─── a minimal kernel: only the ports Gate's build touches, each observable ─────────────────────────────────────────

export interface FakeKernelOptions {
  /** `gate.yaml` as the kernel's config port parses it; `undefined` is "no file in effect". */
  readonly config?: GateConfig | 'throws';
  /** The kernel's `ConfigPort.fileState`; left out, an absent file. */
  readonly fileState?: ConfigFileStatus;
  /**
   * `gate.yaml`'s raw text as the kernel's writer reads it, in effect (its `written` value is read by the kernel's own
   * reader); left out, no file.
   */
  readonly rawConfig?: string;
  /** The kernel's REAL config writer, over a real config service; replaces the `rawConfig` stand-in. */
  readonly writer?: ConfigFilesWriter;
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
  /** Access's `step-up:device` value; left out, "Access is off" (every device must unlock, fail closed). */
  readonly stepUp?: StepUpWitness;
  /**
   * The kernel's writer puts a written `patch` into effect at once, as the real config service does (it loads the file
   * before it answers) and tells the `gate.yaml` watchers; left out, a write changes nothing.
   */
  readonly applyWrites?: boolean;
}

export function boot(options: FakeKernelOptions = {}) {
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
  let live = options.config;
  const absent: ConfigFileStatus = { state: 'absent', inEffect: false, sentences: [] };
  const writtenOf = (text: string | undefined): unknown => {
    const read = text === undefined ? undefined : readConfigText(text);
    return read?.ok === true ? read.read.value : undefined;
  };
  const configFiles = options.writer ?? {
    declarations: () => [{ plugin: 'gate', def: manifest.data?.config?.[0] }],
    read: async () => ({
      path: 'gate.yaml',
      exists: options.rawConfig !== undefined,
      text: options.rawConfig,
      etag: 'e1',
      status: options.fileState ?? absent,
      ...(options.rawConfig === undefined ? {} : { written: writtenOf(options.rawConfig) }),
    }),
    write: async (target: ConfigTarget, edit: ConfigEdit, writeOptions: unknown): Promise<ConfigWriteOutcome> => {
      configWrites.push({ target, edit, options: writeOptions });
      if (options.applyWrites === true && typeof edit !== 'string' && live !== undefined && live !== 'throws') {
        live = { ...live, ...(edit.patch as Partial<GateConfig>) };
        for (const listener of watchers) listener();
      }
      return options.writeOutcome ?? { kind: 'written', etag: 'e2', loosened: [] };
    },
  };
  const config = {
    file: () => {
      if (live === 'throws') throw new Error('gate.yaml cannot be read');
      return live;
    },
    collection: () => new Map(),
    watch: (_def: unknown, listener: () => void) => {
      watchers.push(listener);
      return () => undefined;
    },
    fileState: () =>
      options.fileState ?? (live === undefined ? absent : { state: 'valid', inEffect: true, sentences: [] }),
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
      (hook.name === Credentials.name
        ? credentials[key as 'device' | 'member']
        : hook.name === StepUp.name
          ? options.stepUp
          : undefined) ?? 'unavailable',
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
export function call(
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
export async function dispatch(
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

export const bodyOf = (response: ApiResponse): Record<string, unknown> =>
  JSON.parse(String(response.body)) as Record<string, unknown>;

/** One journal line as the kernel lands it: `format` first, then the record's own keys. */
export const stamped = (record: object): string => JSON.stringify({ format: 1, ...record });

export const seeded = { [AdminTokenFile.path]: `${ADMIN}\n`, [WardenTokenFile.path]: `${WARDEN}\n` };
export const HOME = '/home/fy';
export const GATE_YAML = `${HOME}/config/gate.yaml`;
const GOOD = 'grants:\n  fleet:\n    use: true\n';
export const CAP = kernelConfig.CONFIG_FILE_MAX_BYTES;

/** One long string, then aliased until the text is just under the cap — and it also names `terminal`. */
export function aliasBomb(): string {
  const head = `grants:\n  terminal:\n    use: true\ns: &s ${'x'.repeat(100_000)}\nl: [`;
  const room = CAP - head.length - 2;
  return `${head}${'*s, '.repeat(Math.floor(room / 4)).slice(0, -2)}]\n`;
}

/** The real config service over memory, holding `gate.yaml` as GOOD, then (on disk only) `next`. */
export async function realConfig(next: string) {
  const fs = kernelState.createMemoryHostFs();
  const cancel = () => undefined;
  const files = kernelConfig.createConfigFiles({
    home: HOME,
    fs,
    clock: { nowMs: () => 0, after: () => cancel, every: () => cancel },
    log: { debug() {}, info() {}, warn() {}, error() {}, child: () => undefined } as never,
    binary: 'fy',
    defs: [{ plugin: 'gate', def: GateConfigFile }],
  });
  fs.seed(GATE_YAML, GOOD);
  await files.reload();
  fs.seed(GATE_YAML, next);
  await files.reload();
  return files;
}

/** Each capability's origin, once Gate has read its provenance (it reads it in the background at build). */
export async function origins(built: ReturnType<typeof boot>, until: (found: Map<string, string>) => boolean) {
  // A poll count, not a clock: 1,000 tries 5 ms apart.
  let tries = 0;
  for (;;) {
    tries += 1;
    const body = bodyOf(await dispatch(built, 'GET /v1/grants', { bearer: ADMIN })) as {
      capabilities: { capability: string; origin: string }[];
    };
    const found = new Map(body.capabilities.map(entry => [entry.capability, entry.origin]));
    if (until(found) || tries >= 1_000) return found;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
