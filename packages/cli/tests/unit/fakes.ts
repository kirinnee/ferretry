import { state } from '@ferretry/kernel/host';
import { CORE_IDS, PROTOCOL, type PluginInventory } from '@ferretry/kernel/contract';
import {
  definePlugin,
  implementCli,
  type Manifest,
  type PluginClient,
  route,
  skeletonCli,
  type TerminalIo,
  tool,
  verb,
  type VerbHandler,
} from '@ferretry/kernel/manifest';
import {
  type ClientDeps,
  type DaemonReply,
  type DaemonTransport,
  InventoryCache,
  type RawEvent,
  type SendOptions,
  surfacesOf,
} from '../../src/lib/client.ts';
import type { DaemonRequest } from '../../src/lib/request.ts';
import type { AnyCliImplementation, CommandRegistry, KernelEntry, RegistryEntry } from '../../src/lib/registry.ts';
import { createPluginHost } from '../../src/adapters/plugin-host.ts';
import type { CliWorld, Connection, LaunchResult, PluginHost, Probe } from '../../src/lib/world.ts';

export interface CapturedIo extends TerminalIo {
  readonly stdout: () => string;
  readonly stderr: () => string;
}

export function capturedIo(): CapturedIo {
  let out = '';
  let err = '';
  return {
    out: text => {
      out += text;
    },
    err: text => {
      err += text;
    },
    isTty: false,
    stdout: () => out,
    stderr: () => err,
  };
}

const SCOPE = { minimum: 'authenticated', audit: { skip: 'test' }, guard: { none: 'test' } } as const;

/** A board-like plugin: one person route, one open route, one tool, two verbs. */
export const boardManifest = definePlugin({
  id: 'board',
  title: 'Board',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['command'],
  words: [{ word: 'card', means: 'a unit of work on the board', insteadOf: ['task'] }],
  actions: {
    routes: [
      route('GET /v1/cards/:id', { ...SCOPE, caller: 'any' }),
      route('POST /v1/cards/:id/move', { ...SCOPE, caller: 'person' }),
    ],
    agentTools: [tool('card_show', { ...SCOPE, caller: 'any' }), tool('card_rules', { ...SCOPE, caller: 'person' })],
    cli: [verb('card show', { summary: 'show a card' }), verb('card move', { summary: 'move a card' }), verb('board')],
  },
});

export function entry(
  manifest: Manifest,
  contract: string,
  half: AnyCliImplementation | (() => Promise<AnyCliImplementation>),
): RegistryEntry {
  return { id: manifest.id, manifest, contract, load: typeof half === 'function' ? half : async () => half };
}

export const skeletonEntry = (manifest: Manifest, contract = 'h-skeleton'): RegistryEntry =>
  entry(manifest, contract, skeletonCli(manifest));

/** The Kernel as a test `fy` is built: its glossary route and a hash. */
const kernelEntry: KernelEntry = {
  manifest: definePlugin({
    id: 'kernel',
    title: 'Kernel',
    version: '5.0.0',
    api: 5,
    core: true,
    kinds: [],
    actions: { routes: [route('GET /v1/glossary', { ...SCOPE, caller: 'any' })] },
  }),
  contract: 'h-kernel',
};

/** The core packages beside the Kernel, as quiet skeletons: no verbs, a hash each (`h-gate`, …). */
const corePeers: readonly RegistryEntry[] = CORE_IDS.filter(id => id !== 'kernel').map(id =>
  skeletonEntry(
    definePlugin({
      id,
      title: `${id[0]?.toUpperCase() ?? ''}${id.slice(1)}`,
      version: '5.0.0',
      api: 5,
      core: true,
      kinds: [],
    }),
    `h-${id}`,
  ),
);

/** A test registry: the Kernel and the core packages (unless a test supplies its own), then `plugins`. */
export const registryOf = (...plugins: RegistryEntry[]): CommandRegistry => ({
  kernel: kernelEntry,
  plugins: [...corePeers.filter(core => !plugins.some(plugin => plugin.id === core.id)), ...plugins],
});

/** A board half whose verbs record how they were called. */
export function boardEntry(
  calls: { client?: PluginClient; args?: readonly string[] } = {},
  contract = 'h-board',
): RegistryEntry {
  const ok: VerbHandler = async invocation => {
    calls.args = invocation.args;
    return 0;
  };
  return entry(
    boardManifest,
    contract,
    implementCli(boardManifest, {
      build: ctx => {
        calls.client = ctx.client;
        return { verbs: { 'card show': ok, 'card move': ok, board: ok } };
      },
    }),
  );
}

/** The inventory a daemon built like {@link registryOf} answers for its core packages. */
const CORE_INVENTORY: readonly { id: string; contract: string }[] = CORE_IDS.map(id => ({ id, contract: `h-${id}` }));

/** An inventory with every core package matching {@link registryOf} (unless listed here), then `plugins`. */
export const inventoryOf = (...plugins: { id: string; on?: boolean; contract: string }[]): PluginInventory => ({
  protocol: PROTOCOL,
  plugins: [...CORE_INVENTORY.filter(core => !plugins.some(plugin => plugin.id === core.id)), ...plugins].map(
    plugin => ({ id: plugin.id, on: (plugin as { on?: boolean }).on ?? true, contract: plugin.contract }),
  ),
});

/** Records requests and answers from a script; an unscripted request is answered 200 `{}`. */
export class RecordingTransport implements DaemonTransport {
  readonly sent: DaemonRequest[] = [];
  readonly replies: (DaemonReply | Error)[] = [];

  async send(request: DaemonRequest, _options?: SendOptions): Promise<DaemonReply> {
    this.sent.push(request);
    const next = this.replies.shift() ?? { status: 200, body: {} };
    if (next instanceof Error) throw next;
    return next;
  }
}

/** A transport that also holds the event feed open: a test pushes events in, and closes the feed. */
export class FeedingTransport extends RecordingTransport {
  opened = 0;
  cancelled = 0;
  #listener: ((event: RawEvent) => void) | undefined;
  #closed: ((reason: string) => void) | undefined;

  events(listener: (event: RawEvent) => void, onClose: (reason: string) => void): () => void {
    this.opened += 1;
    this.#listener = listener;
    this.#closed = onClose;
    return () => {
      this.cancelled += 1;
    };
  }

  /** The daemon sends one event. */
  push(name: string, payload: unknown): void {
    this.#listener?.({ name, payload });
  }

  /** The feed ends, as when the daemon goes away. */
  close(reason: string): void {
    this.#closed?.(reason);
  }
}

export function depsOf(
  registry: CommandRegistry,
  inventory: PluginInventory | (() => PluginInventory),
  options: { inPane?: boolean; transport?: RecordingTransport; instance?: () => Promise<string | undefined> } = {},
): { deps: ClientDeps; transport: RecordingTransport; reads: { count: number } } {
  const transport = options.transport ?? new RecordingTransport();
  const reads = { count: 0 };
  const deps: ClientDeps = {
    transport,
    inventory: new InventoryCache(async () => {
      reads.count += 1;
      return typeof inventory === 'function' ? inventory() : inventory;
    }, options.instance),
    surfaces: surfacesOf(registry),
    inPane: options.inPane ?? false,
    binary: 'fy',
  };
  return { deps, transport, reads };
}

export interface FakeWorldOptions {
  readonly registry?: CommandRegistry;
  readonly probe?: Probe;
  readonly inventory?: PluginInventory;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly launch?: LaunchResult;
  /** What every half is handed beyond its client; by default the real adapter over a throwaway in-memory home. */
  readonly host?: PluginHost;
  readonly transport?: RecordingTransport;
  /** Reads the inventory through the connection, instead of answering `inventory`. */
  readonly readInventory?: () => Promise<PluginInventory>;
}

export function fakeWorld(options: FakeWorldOptions = {}): {
  world: CliWorld;
  io: CapturedIo;
  transport: RecordingTransport;
  connects: { asOwner: boolean }[];
} {
  const io = capturedIo();
  const transport = options.transport ?? new RecordingTransport();
  const connects: { asOwner: boolean }[] = [];
  const inventory = options.inventory ?? inventoryOf();
  const probe: Probe = options.probe ?? {
    state: 'up',
    baseUrl: 'http://127.0.0.1:7431',
    health: { protocol: PROTOCOL, version: '5.0.0' },
  };
  const world: CliWorld = {
    host: options.host ?? createPluginHost({ home: '/fake-home', fs: state.createMemoryHostFs() }),
    io,
    environment: options.environment ?? {},
    identity: { binary: 'fy', version: '5.0.0' },
    registry: options.registry ?? registryOf(),
    probe: async () => probe,
    launch: async () => options.launch ?? { started: true, baseUrl: probe.baseUrl },
    connect: async ({ asOwner }): Promise<Connection> => {
      connects.push({ asOwner });
      return {
        baseUrl: probe.baseUrl,
        transport,
        inventory: new InventoryCache(options.readInventory ?? (async () => inventory)),
      };
    },
  };
  return { world, io, transport, connects };
}

/** A verb that makes one daemon call and succeeds: what most test halves do. */
export const callsThenOk =
  (client: PluginClient, route: string, init?: Parameters<PluginClient['call']>[1]): VerbHandler =>
  async () => {
    await client.call(route, init);
    return 0;
  };
