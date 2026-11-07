import { PROTOCOL, type PluginInventory } from '@ferretry/kernel/contract';
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
  surfacesOf,
} from '../../src/lib/client.ts';
import type { DaemonRequest } from '../../src/lib/request.ts';
import type { AnyCliImplementation, CommandRegistry, RegistryEntry } from '../../src/lib/registry.ts';
import type { CliWorld, Connection, LaunchResult, Probe } from '../../src/lib/world.ts';

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

export const wiringManifest = definePlugin({
  id: 'wiring',
  title: 'Wiring',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['command'],
  needs: {},
  actions: { cli: [verb('wiring show')] },
});

export function entry(
  manifest: Manifest,
  contract: string,
  half: AnyCliImplementation | (() => Promise<AnyCliImplementation>),
): RegistryEntry {
  return { id: manifest.id, manifest, contract, load: typeof half === 'function' ? half : async () => half };
}

export const registryOf = (...plugins: RegistryEntry[]): CommandRegistry => ({ plugins });

export const skeletonEntry = (manifest: Manifest, contract = 'h-skeleton'): RegistryEntry =>
  entry(manifest, contract, skeletonCli(manifest));

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

export const inventoryOf = (...plugins: { id: string; on?: boolean; contract: string }[]): PluginInventory => ({
  protocol: PROTOCOL,
  plugins: plugins.map(plugin => ({ id: plugin.id, on: plugin.on ?? true, contract: plugin.contract })),
});

/** Records requests and answers from a script; an unscripted request is answered 200 `{}`. */
export class RecordingTransport implements DaemonTransport {
  readonly sent: DaemonRequest[] = [];
  readonly replies: (DaemonReply | Error)[] = [];

  async send(request: DaemonRequest): Promise<DaemonReply> {
    this.sent.push(request);
    const next = this.replies.shift() ?? { status: 200, body: {} };
    if (next instanceof Error) throw next;
    return next;
  }
}

export function depsOf(
  registry: CommandRegistry,
  inventory: PluginInventory | (() => PluginInventory),
  options: { inPane?: boolean; transport?: RecordingTransport } = {},
): { deps: ClientDeps; transport: RecordingTransport; reads: { count: number } } {
  const transport = options.transport ?? new RecordingTransport();
  const reads = { count: 0 };
  const deps: ClientDeps = {
    transport,
    inventory: new InventoryCache(async () => {
      reads.count += 1;
      return typeof inventory === 'function' ? inventory() : inventory;
    }),
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
  readonly transport?: RecordingTransport;
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
    io,
    environment: options.environment ?? {},
    identity: { binary: 'fy', version: '5.0.0' },
    registry: options.registry ?? registryOf(),
    probe: async () => probe,
    launch: async () => options.launch ?? { started: true, baseUrl: probe.baseUrl },
    connect: async ({ asOwner }): Promise<Connection> => {
      connects.push({ asOwner });
      return { baseUrl: probe.baseUrl, transport, inventory: new InventoryCache(async () => inventory) };
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
