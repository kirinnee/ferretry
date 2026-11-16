/**
 * Shells' service (§4.9): resolve a shell item, pin it, build it once, and say what a launch gets. Everything it
 * remembers is a file: the item in `config/shells/`, what it was locked to in `state/shells/locks/`, and the built
 * environment in `state/shells/cache/`. In memory it keeps only the builds in flight (so two asks for one build run
 * it once) and the last failure of each shell.
 */
import type {
  Clock,
  ConfigCollectionDef,
  ConfigPort,
  ConfigWriteOutcome,
  EventsPort,
  Log,
  StatePort,
} from '@ferretry/kernel/contract';
import type { LaunchPart } from '@ferretry/core-ferrets/contract';
import type { Instant, Result } from '@ferretry/std';
import type { NixTool } from './nix-tool.ts';
import {
  type NarHash,
  type NixFacts,
  SHELL_CODES,
  SHELLS_CACHE,
  SHELLS_CONFIG as SHELLS_CONFIG_DEF,
  SHELLS_LOCKS,
  type PinnedNixpkgs,
  type ShellAddRequest,
  type ShellBuildResult,
  type ShellBuildState,
  type ShellDetail,
  type ShellItem,
  type ShellLock,
  type ShellName,
  type ShellPreview,
  type ShellRelockRequest,
  type ShellSummary,
  ShellBuilt,
  ShellsChanged,
} from '../../contract/index.ts';
import {
  buildKey,
  cacheName,
  devEnvArguments,
  type FlakeFacts,
  isLockedFlakeRef,
  lockOf,
  narHashOf,
  pinnedItem,
  splitFlakeRef,
} from './source.ts';

/** The contract widens its defs for the manifest; the service reads them back with their shape. */
const SHELLS_CONFIG = SHELLS_CONFIG_DEF as ConfigCollectionDef<ShellItem>;

type Refusal = {
  readonly status: 404 | 409 | 422 | 500;
  readonly code: string;
  readonly sentence: string;
};
export type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly refusal: Refusal };
const done = <T>(value: T): Outcome<T> => ({ ok: true, value });
const refuse = (status: Refusal['status'], code: string, sentence: string): Outcome<never> => ({
  ok: false,
  refusal: { status, code, sentence },
});

export interface ShellsDeps {
  readonly config: ConfigPort;
  readonly state: StatePort;
  readonly nix: NixTool;
  readonly clock: Pick<Clock, 'now'>;
  readonly events: EventsPort;
  readonly log: Log;
}

type Added = { readonly lock: ShellLock; readonly held: readonly string[] | undefined };

export interface ShellsService {
  list(): Promise<readonly ShellSummary[]>;
  get(name: ShellName): Promise<ShellDetail | undefined>;
  nix(): Promise<NixFacts>;
  preview(request: ShellAddRequest): Promise<Outcome<ShellPreview>>;
  add(request: ShellAddRequest): Promise<Outcome<Added>>;
  /**
   * Resolves the shell again and, when the lock moved (or there is none) and the owner has not approved that hash,
   * writes `approvedHash` into the shell's own config item (`shells/<name>`) as a WHOLE text. That whole text replaces
   * any edit already held for the owner on that same item: the dropped edit is the one held on `<name>`'s own config
   * file, never another shell's. A held edit never took effect, so dropping it loosens nothing, and the answer does not
   * list it; `held` lists only the edit this relock itself leaves held.
   */
  relock(name: ShellName, request: ShellRelockRequest): Promise<Outcome<ShellPreview>>;
  build(name: ShellName): Promise<Outcome<ShellBuildResult>>;
  remove(name: ShellName): Promise<Outcome<ShellName>>;
  /** What a launch on this runtime gets: its shell, or why it has none. Never throws. */
  launchParts(runtime: string | undefined): Promise<readonly LaunchPart[]>;
}

/**
 * The shell a runtime names. A runtime file has no `shell` field yet, so a shell is named by its runtime: the shell
 * called `claude-default` is the one runtime `claude-default` enters (Q18, option b: only when a runtime names one).
 * This is the one place that changes when Runtimes' contract gains the field.
 */
const shellNamedBy = (runtime: string | undefined, names: ReadonlySet<string>): string | undefined =>
  runtime !== undefined && names.has(runtime) ? runtime : undefined;

export function createShellsService(deps: ShellsDeps): ShellsService {
  const { config, state, nix, clock, events, log } = deps;
  const building = new Map<string, Promise<Result<Readonly<Record<string, string>>, string>>>();
  const failed = new Map<string, string>();

  const items = (): ReadonlyMap<string, ShellItem> => config.collection(SHELLS_CONFIG);

  const lockOfName = async (name: string): Promise<ShellLock | undefined> => {
    const read = await state.read(SHELLS_LOCKS, name);
    if (!read.ok) {
      log.warn('a shell lock could not be read', { shell: name, reason: read.error.reason });
      return undefined;
    }
    return read.value;
  };

  const cached = async (key: NarHash): Promise<ReadonlyMap<string, string> | undefined> => {
    const read = await state.read(SHELLS_CACHE, cacheName(key));
    if (!read.ok || read.value === undefined) return undefined;
    try {
      const text = read.value instanceof Uint8Array ? new TextDecoder().decode(read.value) : String(read.value);
      const parsed = JSON.parse(text) as Record<string, unknown>;
      return new Map(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    } catch {
      return undefined; // content-addressed: a damaged entry is simply rebuilt
    }
  };

  const summaryOf = (
    name: string,
    item: ShellItem,
    lock: ShellLock | undefined,
    built: ReadonlySet<string>,
  ): ShellSummary => {
    let build: ShellBuildState = 'not-built';
    if (lock !== undefined) {
      if (building.has(buildKey(lock))) build = 'building';
      else if (built.has(cacheName(buildKey(lock)))) build = 'built';
    }
    if (build === 'not-built' && failed.has(name)) build = 'failed';
    return {
      name,
      kind: item.flake === undefined ? 'packages' : 'flake',
      locked: lock !== undefined,
      floating: item.floating,
      build,
      usedBy: [],
      ...(item.description === undefined ? {} : { description: item.description }),
      ...(lock === undefined ? {} : { narHash: narHashOf(lock) }),
    };
  };

  const needNix = async (): Promise<Outcome<true>> => {
    const facts = await nix.facts();
    return facts.present ? done(true) : refuse(409, SHELL_CODES.noNix, `${facts.consequence}; ${facts.remedy}`);
  };

  /** Resolves an item to its pinned form and its lock. Reads the network only through `nix`. */
  const resolve = async (
    name: string,
    item: ShellItem,
  ): Promise<Outcome<{ readonly pinned: ShellItem; readonly lock: ShellLock }>> => {
    let facts: FlakeFacts | undefined;
    let nixpkgs: PinnedNixpkgs | undefined;
    if (item.flake !== undefined) {
      const { base } = splitFlakeRef(item.flake);
      if (!item.floating && !isLockedFlakeRef(item.flake))
        return refuse(
          422,
          SHELL_CODES.unlocked,
          `${base} names no revision, so it could change under you. Add the revision to the address, or say floating: true to be asked again whenever it changes.`,
        );
      const metadata = await nix.flakeMetadata(base);
      if (!metadata.ok) return refuse(422, SHELL_CODES.invalid, `${base}: ${metadata.error}`);
      facts = metadata.value;
    } else {
      nixpkgs = item.nixpkgs;
      if (nixpkgs === undefined) {
        const metadata = await nix.flakeMetadata('nixpkgs');
        if (!metadata.ok) return refuse(422, SHELL_CODES.invalid, `nixpkgs: ${metadata.error}`);
        nixpkgs = { rev: metadata.value.rev, narHash: metadata.value.narHash };
      }
    }
    const lock = lockOf(name, item, facts, nixpkgs, clock.now());
    if (!lock.ok) return refuse(422, SHELL_CODES.invalid, lock.error);
    return done({ pinned: pinnedItem(item, facts, nixpkgs), lock: lock.value });
  };

  const changedFrom = (before: ShellLock | undefined, after: ShellLock): NarHash | undefined =>
    before !== undefined && narHashOf(before) !== narHashOf(after) ? narHashOf(before) : undefined;

  /**
   * What the kernel's writer said when the change did not go in: a refusal names its own issues (never a value), and a
   * file that moved since it was read asks the caller to start again. `written` and `held` are the caller's to answer.
   */
  const notWritten = (name: string, written: ConfigWriteOutcome): Outcome<never> | undefined => {
    if (written.kind === 'refused')
      return refuse(422, SHELL_CODES.invalid, written.issues.map(issue => issue.message).join('; ') || written.reason);
    if (written.kind === 'conflict')
      return refuse(
        409,
        SHELL_CODES.hashChanged,
        `the configuration of ${name} changed while it was being saved; preview it again. Nothing was changed.`,
      );
    return undefined;
  };

  const runBuild = (lock: ShellLock): Promise<Result<Readonly<Record<string, string>>, string>> => {
    const key = buildKey(lock);
    const running = building.get(key);
    if (running !== undefined) return running;
    const started = nix.devEnv(devEnvArguments(lock)).finally(() => building.delete(key));
    building.set(key, started);
    return started;
  };

  /** Builds (or finds) a locked shell's environment; a failure is remembered for the list and said in words. */
  const environment = async (
    name: string,
    lock: ShellLock,
  ): Promise<
    Result<{ readonly env: Readonly<Record<string, string>>; readonly outcome: 'built' | 'cached' }, string>
  > => {
    const key = buildKey(lock);
    const hit = await cached(key);
    if (hit !== undefined) return { ok: true, value: { env: Object.fromEntries(hit), outcome: 'cached' } };
    const built = await runBuild(lock);
    if (!built.ok) {
      failed.set(name, built.error);
      return { ok: false, error: built.error };
    }
    failed.delete(name);
    await state.write(SHELLS_CACHE, JSON.stringify(built.value) as never, cacheName(key));
    return { ok: true, value: { env: built.value, outcome: 'built' } };
  };

  return {
    async list() {
      const built = new Set(await state.list(SHELLS_CACHE));
      const out: ShellSummary[] = [];
      for (const [name, item] of items()) out.push(summaryOf(name, item, await lockOfName(name), built));
      return out.toSorted((a, b) => a.name.localeCompare(b.name));
    },

    async get(name) {
      const item = items().get(name);
      if (item === undefined) return undefined;
      const lock = await lockOfName(name);
      const built = new Set(await state.list(SHELLS_CACHE));
      return { name, item, ...(lock === undefined ? {} : { lock }), summary: summaryOf(name, item, lock, built) };
    },

    nix: () => nix.facts(),

    async preview(request) {
      const nixReady = await needNix();
      if (!nixReady.ok) return nixReady;
      const resolved = await resolve(request.name, request.item);
      if (!resolved.ok) return resolved;
      const before = await lockOfName(request.name);
      const moved = changedFrom(before, resolved.value.lock);
      return done({
        name: request.name,
        lock: resolved.value.lock,
        ...(moved === undefined ? {} : { changedFrom: moved }),
      });
    },

    async add(request) {
      if (items().has(request.name))
        return refuse(
          409,
          SHELL_CODES.exists,
          `there is already a shell called ${request.name}; use relock to resolve it again`,
        );
      const nixReady = await needNix();
      if (!nixReady.ok) return nixReady;
      const resolved = await resolve(request.name, request.item);
      if (!resolved.ok) return resolved;
      const written = await config.write(
        SHELLS_CONFIG,
        request.name,
        Bun.YAML.stringify(
          {
            ...resolved.value.pinned,
            approvedHash: narHashOf(resolved.value.lock),
          },
          null,
          2,
        ),
      );
      const notAdded = notWritten(request.name, written);
      if (notAdded !== undefined) return notAdded;
      if (written.kind === 'written') await state.write(SHELLS_LOCKS, resolved.value.lock, request.name);
      events.publish(ShellsChanged, { name: request.name });
      return done({ lock: resolved.value.lock, held: written.kind === 'held' ? written.sentences : undefined });
    },

    async relock(name, request) {
      const item = items().get(name);
      if (item === undefined) return refuse(404, SHELL_CODES.unknown, `there is no shell called ${name}`);
      const nixReady = await needNix();
      if (!nixReady.ok) return nixReady;
      const resolved = await resolve(name, item);
      if (!resolved.ok) return resolved;
      const hash = narHashOf(resolved.value.lock);
      if (hash !== request.expectedHash)
        return refuse(
          409,
          SHELL_CODES.hashChanged,
          `${name} changed since preview. Preview it again; nothing was changed.`,
        );
      const before = await lockOfName(name);
      const moved = changedFrom(before, resolved.value.lock);
      // A pinned source cannot move: a different hash means the address now names other bytes, so nothing is written.
      if (moved !== undefined && !item.floating)
        return refuse(
          409,
          SHELL_CODES.hashChanged,
          `${name} is pinned to ${moved} but its address now resolves to ${narHashOf(resolved.value.lock)}. Nothing was changed.`,
        );
      // Only effective config authorizes a different payload. A CLI --yes cannot bypass the owner door.
      if ((before === undefined || moved !== undefined) && item.approvedHash !== hash) {
        const written = await config.write(
          SHELLS_CONFIG,
          name,
          Bun.YAML.stringify({ ...item, approvedHash: hash }, null, 2),
        );
        const notChanged = notWritten(name, written);
        if (notChanged !== undefined) return notChanged;
        if (written.kind === 'held')
          return done({
            name,
            lock: resolved.value.lock,
            ...(moved === undefined ? {} : { changedFrom: moved }),
            held: written.sentences,
          });
        if (items().get(name)?.approvedHash !== hash)
          return refuse(409, SHELL_CODES.hashChanged, 'the approved configuration changed; preview and relock again');
      }
      await state.write(SHELLS_LOCKS, resolved.value.lock, name);
      events.publish(ShellsChanged, { name });
      return done({ name, lock: resolved.value.lock, ...(moved === undefined ? {} : { changedFrom: moved }) });
    },

    async build(name) {
      if (!items().has(name)) return refuse(404, SHELL_CODES.unknown, `there is no shell called ${name}`);
      const lock = await lockOfName(name);
      if (lock === undefined)
        return refuse(409, SHELL_CODES.unlocked, `${name} has not been locked yet; run relock first`);
      const nixReady = await needNix();
      if (!nixReady.ok) return nixReady;
      const built = await environment(name, lock);
      if (!built.ok) return refuse(500, SHELL_CODES.buildFailed, `building ${name} failed: ${built.error}`);
      const builtAt: Instant = clock.now();
      if (built.value.outcome === 'built') events.publish(ShellBuilt, { name, narHash: narHashOf(lock), builtAt });
      return done({ name, narHash: narHashOf(lock), outcome: built.value.outcome, builtAt });
    },

    async remove(name) {
      const had = items().has(name) || (await lockOfName(name)) !== undefined;
      if (!had) return refuse(404, SHELL_CODES.unknown, `there is no shell called ${name}`);
      if (items().has(name)) {
        const removed = await config.remove(SHELLS_CONFIG, name);
        const notRemoved = notWritten(name, removed);
        if (notRemoved !== undefined) return notRemoved;
        // A removal the kernel holds for the owner has not happened yet: the lock stays with the shell that stays.
        if (removed.kind === 'held')
          return refuse(409, SHELL_CODES.hashChanged, `held for the owner: ${removed.sentences.join('; ')}`);
      }
      await state.remove(SHELLS_LOCKS, name);
      failed.delete(name);
      events.publish(ShellsChanged, { name });
      return done(name);
    },

    async launchParts(runtime) {
      const name = shellNamedBy(runtime, new Set(items().keys()));
      if (name === undefined) return [];
      const without = (why: string): readonly LaunchPart[] => [
        {
          kind: 'instruction',
          id: `shell-${name}`,
          text: `The shell "${name}" was meant for this ferret but ${why}, so you are using the tools already on this machine.`,
        },
      ];
      try {
        const facts = await nix.facts();
        if (!facts.present) return without('nix is not installed');
        const lock = await lockOfName(name);
        if (lock === undefined) return without('it has not been locked');
        const built = await environment(name, lock);
        if (!built.ok) return without('it could not be built');
        return [{ kind: 'shell', name, env: built.value.env }];
      } catch (error) {
        log.warn('a shell could not be prepared for a launch', {
          shell: name,
          error: error instanceof Error ? error.message : 'unknown',
        });
        return without('it could not be prepared');
      }
    },
  };
}
