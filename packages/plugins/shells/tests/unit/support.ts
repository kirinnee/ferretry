/** In-memory stand-ins for what the shells service is given: config, state, nix, events. */
import type {
  ConfigCollectionDef,
  ConfigFileDef,
  ConfigPort,
  ConfigWriteOutcome,
  EventsPort,
  Log,
  StatePort,
} from '@ferretry/kernel/contract';
import { err, ok, type Instant, type Result } from '@ferretry/std';
import type { NixTool } from '../../daemon/lib/nix-tool.ts';
import type { FlakeFacts } from '../../daemon/lib/source.ts';
import { createShellsService, type ShellsService } from '../../daemon/lib/service.ts';
import type { NixFacts } from '../../contract/index.ts';

type Def = ConfigFileDef<any> | ConfigCollectionDef<any>;

export const HASH_A = `sha256-${'A'.repeat(43)}=`;
export const HASH_B = `sha256-${'B'.repeat(43)}=`;
export const REV_A = 'a'.repeat(40);
export const REV_B = 'b'.repeat(40);

/**
 * An in-memory config tree: a `ConfigPort` writing with the kernel's real `ConfigWriteOutcome`s. `hold`: every write is
 * held for the owner with these sentences (written, not in effect, nothing stored here). `forced`: every write and
 * remove answers with exactly this outcome and stores nothing. Neither: a write is stored and answers `written`.
 */
export function configTree(
  initial: Record<string, unknown> = {},
  hold?: readonly string[],
  forced?: ConfigWriteOutcome,
) {
  const documents = new Map<string, unknown>(Object.entries(initial));
  const calls: { op: 'write' | 'remove'; where: string; text?: string }[] = [];
  const keyOf = (def: Def, name: string | undefined): string =>
    def.shape === 'file' ? def.file : `${def.collection}/${name}`;
  const port: ConfigPort = {
    file: () => undefined,
    collection: def => {
      const out = new Map<string, any>();
      const prefix = def.shape === 'collection' ? `${def.collection}/` : '';
      for (const [key, raw] of documents)
        if (key.startsWith(prefix)) out.set(key.slice(prefix.length), def.schema.parse(raw));
      return out;
    },
    watch: () => () => {},
    fileState: () => ({ state: 'absent', inEffect: false, sentences: [] }),
    async write(def, name, edit): Promise<ConfigWriteOutcome> {
      const where = keyOf(def, name);
      calls.push({ op: 'write', where, text: typeof edit === 'string' ? edit : JSON.stringify(edit) });
      if (forced !== undefined) return forced;
      if (hold !== undefined)
        return { kind: 'held', etag: `held-${calls.length}`, id: `${where}@held`, sentences: hold };
      if (typeof edit === 'string') documents.set(where, Bun.YAML.parse(edit));
      return { kind: 'written', etag: `etag-${calls.length}`, loosened: [] };
    },
    async writeAsOwner(def, name, edit, options): Promise<ConfigWriteOutcome> {
      return await this.write(def, name, edit, options);
    },
    async remove(def, name): Promise<ConfigWriteOutcome> {
      calls.push({ op: 'remove', where: keyOf(def, name) });
      if (forced !== undefined) return forced;
      documents.delete(keyOf(def, name));
      return { kind: 'written', etag: `etag-${calls.length}`, loosened: [] };
    },
  };
  return { port, documents, calls };
}

export function memoryState() {
  const files = new Map<string, unknown>();
  const at = (def: { path: string }, name?: string): string => def.path.replace('*', name ?? '');
  const port = {
    read: async (def: { path: string }, name?: string) => ({ ok: true as const, value: files.get(at(def, name)) }),
    write: async (def: { path: string }, value: unknown, name?: string) => {
      files.set(at(def, name), value);
    },
    list: async (def: { path: string }) => {
      const [prefix, suffix] = def.path.split('*') as [string, string];
      return [...files.keys()]
        .filter(key => key.startsWith(prefix) && key.endsWith(suffix))
        .map(key => key.slice(prefix.length, key.length - suffix.length));
    },
    remove: async (def: { path: string }, name?: string) => {
      files.delete(at(def, name));
    },
  } as unknown as StatePort;
  return { port, files };
}

export interface FakeNix extends NixTool {
  facts_: NixFacts;
  /** What `nix flake metadata` answers, by reference. */
  metadata: Map<string, FlakeFacts>;
  env: Result<Readonly<Record<string, string>>, string>;
  builds: number;
  asked: string[];
}

export function fakeNix(): FakeNix {
  const fake: FakeNix = {
    facts_: { present: true, version: '2.24.1', path: 'nix' },
    metadata: new Map(),
    env: ok({ PATH: '/nix/store/x/bin:/usr/bin', GIT_SSL: 'x' }),
    builds: 0,
    asked: [],
    async facts() {
      return fake.facts_;
    },
    async flakeMetadata(reference) {
      fake.asked.push(reference);
      const found = fake.metadata.get(reference);
      return found === undefined ? err('nix could not read it') : ok(found);
    },
    async devEnv() {
      fake.builds += 1;
      return fake.env;
    },
  };
  return fake;
}

export const flakeFacts = (rev = REV_A, narHash = HASH_A, base = 'github:me/shells'): FlakeFacts => ({
  url: `${base}/${rev}?narHash=${encodeURIComponent(narHash)}`,
  rev,
  narHash: narHash as FlakeFacts['narHash'],
});

const silent: Log = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

export function shellsHarness(
  options: { initial?: Record<string, unknown>; hold?: readonly string[]; forced?: ConfigWriteOutcome } = {},
) {
  const tree = configTree(options.initial, options.hold, options.forced);
  const state = memoryState();
  const nix = fakeNix();
  const published: { event: string; payload: unknown }[] = [];
  const events = {
    publish: (event: { name: string }, payload: unknown) => void published.push({ event: event.name, payload }),
  } as unknown as EventsPort;
  const service: ShellsService = createShellsService({
    config: tree.port,
    state: state.port,
    nix,
    clock: { now: () => '2026-11-07T10:00:00.000Z' as Instant },
    events,
    log: silent,
  });
  return { service, tree, state, nix, published };
}
