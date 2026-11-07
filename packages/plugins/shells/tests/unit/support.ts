/** In-memory stand-ins for what the shells service is given: config + door, state, nix, events. */
import type {
  ConfigCollectionDef,
  ConfigFileDef,
  ConfigPort,
  EventsPort,
  Log,
  StatePort,
} from '@ferretry/kernel/contract';
import { err, ok, type Instant, type Result } from '@ferretry/std';
import type { NixTool } from '../../daemon/lib/nix-tool.ts';
import type { ConfigDoor, DoorResult } from '../../daemon/lib/config-door.ts';
import type { FlakeFacts } from '../../daemon/lib/source.ts';
import { createShellsService, type ShellsService } from '../../daemon/lib/service.ts';
import type { NixFacts } from '../../contract/index.ts';

type Def = ConfigFileDef<any> | ConfigCollectionDef<any>;

export const HASH_A = `sha256-${'A'.repeat(43)}=`;
export const HASH_B = `sha256-${'B'.repeat(43)}=`;
export const REV_A = 'a'.repeat(40);
export const REV_B = 'b'.repeat(40);

export function configTree(initial: Record<string, unknown> = {}, hold?: readonly string[]) {
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
    write: () => Promise.reject(new Error('the fixture writes through its config door')),
    remove: () => Promise.reject(new Error('the fixture removes through its config door')),
  };
  const door: ConfigDoor = {
    async write(def, name, edit): Promise<DoorResult> {
      const where = keyOf(def, name);
      calls.push({ op: 'write', where, text: typeof edit === 'string' ? edit : JSON.stringify(edit) });
      // A held edit is written to disk but not put into effect: the tighter version (here: none) stays.
      if (hold === undefined && typeof edit === 'string') documents.set(where, Bun.YAML.parse(edit));
      return hold === undefined ? { kind: 'applied' } : { kind: 'held', sentences: hold };
    },
    async remove(def, name): Promise<DoorResult> {
      calls.push({ op: 'remove', where: keyOf(def, name) });
      documents.delete(keyOf(def, name));
      return { kind: 'applied' };
    },
  };
  return { port, door, documents, calls };
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
  options: { initial?: Record<string, unknown>; hold?: readonly string[]; noDoor?: boolean } = {},
) {
  const tree = configTree(options.initial, options.hold);
  const state = memoryState();
  const nix = fakeNix();
  const published: { event: string; payload: unknown }[] = [];
  const events = {
    publish: (event: { name: string }, payload: unknown) => void published.push({ event: event.name, payload }),
  } as unknown as EventsPort;
  const service: ShellsService = createShellsService({
    config: tree.port,
    door: options.noDoor === true ? undefined : tree.door,
    state: state.port,
    nix,
    clock: { now: () => '2026-11-07T10:00:00.000Z' as Instant },
    events,
    log: silent,
  });
  return { service, tree, state, nix, published };
}
