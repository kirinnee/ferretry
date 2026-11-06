import { afterEach, describe, it } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import should from 'should';
import { buildWorld, type DaemonWorld, start } from '../../../bin/fyd.ts';
import { ApiRouter } from '../../../src/lib/api/router.ts';
import type { RoutePattern } from '../../../src/lib/api/route.ts';
import { releaseAcquired } from '../../../src/adapters/runtime/termination-gate.ts';
import {
  AgendaResurfacer,
  AgendaWaker,
  CatalogLinkService,
  CatalogMemberService,
  type ExecutableResolverPort,
  NO_RELAY_DIRECTORY,
  type RelayAdvertisement,
  WebRtcCarrier,
} from '../../../src/lib/index.ts';
import type { BuiltModule } from '../../../src/lib/runtime/modules.ts';
import { CLOUDFLARED_NOT_ON_PATH, NO_TUNNEL_SERVICE, TunnelCarrierSwitch } from '../../../src/lib/tunnel/index.ts';
import { OS_CHOSEN_PORT } from '../support/os-port.ts';
import {
  BOOT_THAT_THROWS_AFTER_STORAGE_OPENS,
  CLEAN_BOOT_THEN_STOP,
  CONSTRUCTION_WITH_THE_RESURFACER_ON,
  STOP_BEFORE_THE_WARDENS_LATE_ARM,
  STOP_DURING_BOOT,
} from './boot-trace.expected.ts';
import { ABSENT_USER_HOME, cleanupTempDirectories, tempDirectory } from '../support/repository.ts';
import { waitFor } from '../support/wait-for.ts';
import { request } from '../../unit/api/support.ts';

type Release = () => void | Promise<void>;

/**
 * The daemon's boot and shutdown, written down in the order they happen.
 *
 * WHAT THIS PINS. `start()` is the one place that decides when each boot step runs, when each job is
 * armed, which release is registered at which moment, and in what order the releases run. Moving a
 * feature out of `fyd.ts` into a module must not move any of that, and a green feature suite does not
 * notice if it does: the daemon still serves, it just arms the update check before the bind, or loses
 * a release, or runs it one place earlier. This file is the check that does notice. Every trace below
 * is a literal, so a change that shifts one entry fails with the entry that moved.
 *
 * HOW IT SEES. Only through seams that already exist, never a hook added for the test:
 *  - the boot notices port (`DaemonWorld.notices`) gives the boot steps;
 *  - the caller-owned `cleanups` list gives every registration (push or unshift) and, by running it
 *    here, every release in the order a real shutdown runs them;
 *  - the objects `createSubsystems` returns are patched IN PLACE, so `start()` reaches the very
 *    instances the routes were built over while each `arm`/`run` it calls is written down;
 *  - the timers, the agenda starts and the catalog sweeps a subsystem makes WHILE it is built are written
 *    down by wrapping the globals and the real service methods, for exactly the span of the one
 *    synchronous construction call. A sweep's immediate first run is the entry its real method writes
 *    (`first sweep: ...`) BEFORE the `setInterval` that repeats it, so dropping or deferring that run
 *    removes an entry rather than leaving the trace as it was;
 *  - every release writes the name of what it really released, from the port it calls: a disarm returned by
 *    an `arm`, a `close`/`stop`/`flush` on a mounted subsystem or a host adapter, a carrier or the
 *    bound server, and the timer a release clears (as `clear setInterval <ms>`). Each `release #n` is
 *    therefore followed by what it did, so two registrations swapped in `start()` swap those names and
 *    fail the trace even though the registration numbers do not move.
 *
 * WHAT IT DOES NOT SEE. One release has no port to name: the shutdown-begun flag (`releasing = true`) is a
 * plain assignment, so it is named only by standing between the two disarms registered around it. Two
 * timer clears of the SAME interval cannot be told apart either, which no release in the clean boot needs.
 */

/** Set in the trace so a rename of any of these is a visible edit, not a silent one. */
const TRACE = {
  constructBegin: 'createSubsystems: construction begins',
  constructEnd: 'createSubsystems: construction ends',
} as const;

function buildIntegrationWorld(): DaemonWorld {
  const world = buildWorld({}, { userHome: ABSENT_USER_HOME });
  const hidden = new Set(['claude', 'codex']);
  const executables: ExecutableResolverPort = {
    resolve: name => (hidden.has(name) ? undefined : world.harnesses.executables.resolve(name)),
    runnable: path => world.harnesses.executables.runnable(path),
  };
  return {
    ...world,
    harnesses: { ...world.harnesses, executables },
    relayDirectory: { read: async (): Promise<RelayAdvertisement> => NO_RELAY_DIRECTORY },
    tunnelService: { read: async () => NO_TUNNEL_SERVICE },
    cloudflared: { locate: () => CLOUDFLARED_NOT_ON_PATH },
  };
}

/** Minutes of silence after which the daemon surfaces an ask by itself; any value turns the resurfacer on. */
const RESURFACE_AFTER_MINUTES = 15;

async function seedHome(home: string, resurface: boolean): Promise<void> {
  process.env.FY_HOME = home;
  const opened = await buildIntegrationWorld().storage.open();
  await opened.storage.close();
  const document = {
    host: '127.0.0.1',
    port: OS_CHOSEN_PORT,
    ...(resurface ? { attention: { resurfaceAfterMinutes: RESURFACE_AFTER_MINUTES } } : {}),
  };
  await writeFile(join(home, 'config', 'daemon.json'), JSON.stringify(document), { mode: 0o600 });
}

/** Replaces `target[name]` on the instance itself, so identity is kept and only this call is observed. */
function patch<T extends object, K extends keyof T & string>(
  target: T,
  name: K,
  replace: (original: T[K]) => T[K],
): void {
  const original = target[name];
  const bound = typeof original === 'function' ? (original as (...args: never[]) => unknown).bind(target) : original;
  Object.defineProperty(target, name, { value: replace(bound as T[K]), configurable: true, writable: true });
}

/** A promise settled from outside, so the test decides exactly when a late result lands. */
function deferred<T>(): { readonly promise: Promise<T>; readonly settle: (value: T) => void } {
  let settle: (value: T) => void = () => {};
  const promise = new Promise<T>(resolve => {
    settle = resolve;
  });
  return { promise, settle };
}

const nextTurn = async (): Promise<void> => {
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve));
};

/**
 * Asks the seed ports `buildWorld` hands to `TwoFactorSeedStages` what they answer BEFORE the agenda
 * and the owner's session exist, which is the only moment the answer can be seen.
 *
 * WHY NOT A NORMAL SEAM. `seedAgenda` and `seedOwnerSession` are `let`s inside `buildWorld`, filled
 * halfway through `createSubsystems`. By the time any boot returns they are filled, so no request can
 * see the empty answer, and nothing the world exposes reaches the closures before then. A class field
 * is defined, not assigned, so a prototype setter cannot see the object either. What CAN is the one
 * property the constructor reads from it: `deps.newStageId`, which `buildWorld` leaves out. A getter
 * on `Object.prototype` for exactly that name sees the object it was read from, and is removed again
 * before `buildWorld` returns — or throws, which is why the caller restores it in a `finally`. No
 * production line knows it is asked.
 */
function captureEarlySeedReads(): {
  readonly answers: Array<Promise<string>>;
  readonly restore: () => void;
} {
  const answers: Array<Promise<string>> = [];
  const settle = async (label: string, read: () => unknown): Promise<string> => {
    try {
      const value = await read();
      return `${label} -> ${value === undefined ? 'undefined' : JSON.stringify(value)}`;
    } catch (error) {
      return `${label} throws "${error instanceof Error ? error.message : String(error)}"`;
    }
  };
  // Whatever was on the prototype before is put back as it was, descriptor and all, and only when it was there.
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'newStageId');
  Object.defineProperty(Object.prototype, 'newStageId', {
    configurable: true,
    get(this: Record<string, unknown>) {
      const agenda = this.agenda as { raise?: unknown; close?: unknown } | undefined;
      if (typeof this.ownerSession === 'function' && typeof agenda?.raise === 'function') {
        const deps = this as unknown as {
          readonly ownerSession: () => Promise<string | undefined>;
          readonly agenda: {
            readonly raise: (sessionId: string, card: never) => Promise<unknown>;
            readonly close: (sessionId: string, id: never, note: string) => Promise<unknown>;
          };
        };
        answers.push(settle('seedOwnerSession', () => deps.ownerSession()));
        answers.push(settle('seedAgenda.raise', () => deps.agenda.raise('session', {} as never)));
        answers.push(settle('seedAgenda.close', () => deps.agenda.close('session', 'item' as never, 'note')));
      }
      return undefined;
    },
  });
  return {
    answers,
    restore: () => {
      if (previous === undefined) Reflect.deleteProperty(Object.prototype, 'newStageId');
      else Object.defineProperty(Object.prototype, 'newStageId', previous);
    },
  };
}

/** What a run of the boot needs: the world, the trace it writes, and the controls the cases use. */
interface Rig {
  readonly world: DaemonWorld;
  readonly events: string[];
  readonly cleanups: Release[];
  /** Ends `untilShutdown`: a stop that lands once the boot is serving. */
  readonly stop: () => void;
  /** The warden's `arm()` promise, and the `agendaHomesMigrated` promise that releases it. */
  readonly homesMigrated: ReturnType<typeof deferred<void>>;
  readonly wardenArmed: ReturnType<typeof deferred<() => void>>;
  readonly captured: Captured;
  /** What each late-bound port answered when it was built and its source was not, in construction order. */
  readonly early: () => Promise<string[]>;
  /** Runs the cleanups in the order `execute()` runs them after `start` returns or throws. */
  readonly runCleanups: () => Promise<void>;
}

/** What the rig keeps of the one construction and of the dispatchers `start()` mounted over it. */
interface Captured {
  mounted: unknown;
  modules: unknown;
  dispatch?: Parameters<DaemonWorld['createDirectCarrier']>[0];
  sockets?: Parameters<DaemonWorld['createDirectCarrier']>[1];
}

interface RigOptions {
  /** Called inside the declared-wait watcher's first run: the stretch after serving and before the observer arms. */
  readonly duringBoot?: (rig: Rig) => Promise<void>;
  /** Makes the world throw once storage is open. */
  readonly failAfterStorage?: boolean;
  /** Writes `attention.resurfaceAfterMinutes`, which turns the agenda resurfacer on. */
  readonly resurface?: boolean;
}

/** Everything a rig put in place globally or on a shared prototype, undone after each case. */
const undo: Array<() => void> = [];

/** Replaces a prototype method, calling the original with the caller's `this`; returns what puts it back. */
function spyOnPrototype<T extends object, K extends keyof T & string>(
  prototype: T,
  method: K,
  before: () => void,
): () => void {
  const original = prototype[method] as unknown as (...args: unknown[]) => unknown;
  Object.defineProperty(prototype, method, {
    value: function (this: unknown, ...args: unknown[]) {
      before();
      return original.apply(this, args);
    },
    configurable: true,
    writable: true,
  });
  return () => {
    Object.defineProperty(prototype, method, { value: original, configurable: true, writable: true });
  };
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';

/**
 * Runs `call` and returns the `METHOD path` pairs of the one router it looked a request up in. A dispatcher keeps its
 * router private and `start()` hands the carrier only a closure over it, so the router is caught at `lookup`, the one
 * method every dispatch and upgrade asks.
 */
async function routesBehind(call: () => Promise<unknown>): Promise<ReadonlySet<string>> {
  const seen = new Set<ApiRouter<RoutePattern>>();
  const original = ApiRouter.prototype.lookup;
  Object.defineProperty(ApiRouter.prototype, 'lookup', {
    value: function (this: ApiRouter<RoutePattern>, ...args: Parameters<typeof original>) {
      seen.add(this);
      return original.apply(this, args);
    },
    configurable: true,
    writable: true,
  });
  try {
    await call();
  } finally {
    Object.defineProperty(ApiRouter.prototype, 'lookup', { value: original, configurable: true, writable: true });
  }
  if (seen.size !== 1) throw new Error(`expected the request to reach exactly one router, it reached ${seen.size}`);
  const [router] = [...seen];
  return new Set(
    (router as ApiRouter<RoutePattern>).routes.map(route => `${route.method.toUpperCase()} ${route.path}`),
  );
}

async function rig(options: RigOptions = {}): Promise<Rig> {
  const home = await tempDirectory('fyd-boot-trace');
  await seedHome(home, options.resurface === true);
  const early = captureEarlySeedReads();
  let base: DaemonWorld;
  try {
    base = buildIntegrationWorld();
  } finally {
    early.restore();
  }
  const events: string[] = [];
  const registered: Release[] = [];
  let sequence = 0;
  /** The registration whose release is running now: a timer cleared outside a release is not a release. */
  let running: number | undefined;
  const wrap = (release: Release, kind: string): Release => {
    sequence += 1;
    const id = sequence;
    events.push(`${kind} #${String(id)}`);
    return typeof release === 'function'
      ? async () => {
          events.push(`release #${String(id)}`);
          running = id;
          try {
            await release();
          } finally {
            running = undefined;
          }
        }
      : release;
  };
  // The list `start` is given. Only the two ways `start` adds to it are intercepted.
  const cleanups = new Proxy(registered, {
    get(target, property, receiver) {
      if (property === 'push')
        return (...releases: Release[]) => target.push(...releases.map(release => wrap(release, 'register')));
      if (property === 'unshift')
        return (...releases: Release[]) => target.unshift(...releases.map(release => wrap(release, 'register first')));
      return Reflect.get(target, property, receiver);
    },
  });
  const homesMigrated = deferred<void>();
  const wardenArmed = deferred<() => void>();
  const stopped = deferred<void>();
  const captured: Captured = { mounted: undefined, modules: undefined };

  const mountedWorld = base;
  const instrument = (mounted: Record<string, unknown>): void => {
    captured.mounted = mounted;
    // A disarm is released later, by a number; this gives it the name of what it disarms.
    const nameDisarm = (owner: string, value: unknown): unknown =>
      typeof value === 'function'
        ? () => {
            events.push(`disarm ${owner}`);
            return (value as () => unknown)();
          }
        : value;
    const arm = (owner: string, name: string): void => {
      const object = mounted[owner] as Record<string, unknown>;
      patch(
        object,
        name,
        (original: unknown) =>
          ((...args: unknown[]) => {
            events.push(`${name} ${owner}`);
            const result = (original as (...rest: unknown[]) => unknown)(...args);
            return name === 'arm' && isThenable(result)
              ? result.then(value => nameDisarm(owner, value))
              : name === 'arm'
                ? nameDisarm(owner, result)
                : result;
          }) as never,
      );
    };
    // The releases that are a method on a mounted subsystem rather than a disarm: written when they run.
    const named = (owner: string, name: string, label: string): void => {
      const object = mounted[owner] as Record<string, unknown>;
      patch(
        object,
        name,
        (original: unknown) =>
          ((...args: unknown[]) => {
            events.push(label);
            return (original as (...rest: unknown[]) => unknown)(...args);
          }) as never,
      );
    };
    for (const [owner, name] of [
      ['harnessLogin', 'shutdown'],
      ['sharedDrafts', 'close'],
      ['signInRules', 'flush'],
      ['observer', 'close'],
      ['monitor', 'close'],
      ['sendReproof', 'stop'],
      ['queueDelivery', 'stop'],
    ] as const)
      named(owner, name, `${owner}.${name}`);
    for (const [owner, name] of [
      ['observer', 'arm'],
      ['configFiles', 'arm'],
      ['models', 'refreshLocal'],
      ['fleetRefresh', 'arm'],
      ['analyticsIngest', 'arm'],
      ['handoverReconcile', 'arm'],
      ['boardGitHub', 'arm'],
      ['daemonUpdate', 'arm'],
      ['sendTracking', 'arm'],
      ['sendReproof', 'run'],
      ['queueDelivery', 'arm'],
      ['monitor', 'arm'],
    ] as const)
      arm(owner, name);
    // The declared-wait monitor's first run is awaited by `start`; a case may stop inside it.
    const monitor = mounted.monitor as { run: () => Promise<unknown> };
    patch(
      monitor,
      'run',
      original =>
        (async () => {
          events.push('run monitor');
          if (options.duringBoot !== undefined && !events.includes('during boot')) {
            events.push('during boot');
            await options.duringBoot(current);
          }
          return await original();
        }) as never,
    );
    // The warden: its `arm()` is never the real one, so no sweep can spawn; the late result is the test's.
    patch(
      mounted.warden as { arm: () => Promise<() => void> },
      'arm',
      () =>
        (async () => {
          events.push('arm warden');
          return await wardenArmed.promise;
        }) as never,
    );
    // `start` waits on this before it arms the warden.
    Object.defineProperty(mounted, 'agendaHomesMigrated', {
      value: homesMigrated.promise,
      configurable: true,
      writable: true,
    });
  };

  const restoreSpies = (): (() => void) => {
    const setInterval0 = globalThis.setInterval;
    const setTimeout0 = globalThis.setTimeout;
    const originals: Array<() => void> = [];
    const wakerStart = AgendaWaker.prototype.start;
    AgendaWaker.prototype.start = function (this: AgendaWaker) {
      events.push('agenda waker starts');
      return wakerStart.call(this);
    };
    originals.push(() => {
      AgendaWaker.prototype.start = wakerStart;
    });
    const resurfacerStart = AgendaResurfacer.prototype.start;
    AgendaResurfacer.prototype.start = function (this: AgendaResurfacer) {
      events.push('agenda resurfacer starts');
      return resurfacerStart.call(this);
    };
    originals.push(() => {
      AgendaResurfacer.prototype.start = resurfacerStart;
    });
    // The three sweeps' IMMEDIATE first runs are the real methods being called: `MemberSweepTimer.start` runs the
    // sweep and only then asks the clock to repeat it, so each `first sweep` entry precedes its `setInterval`.
    originals.push(
      spyOnPrototype(CatalogMemberService.prototype, 'sweep', () => events.push('first sweep: catalog members')),
      spyOnPrototype(CatalogLinkService.prototype, 'reconcile', () => events.push('first sweep: link reconcile')),
      spyOnPrototype(CatalogLinkService.prototype, 'refresh', () => events.push('first sweep: link refresh')),
    );
    globalThis.setInterval = ((callback: () => void, ms?: number, ...rest: unknown[]) => {
      events.push(`setInterval ${String(ms)}`);
      return (setInterval0 as (...a: unknown[]) => unknown)(callback, ms, ...rest);
    }) as unknown as typeof setInterval;
    globalThis.setTimeout = ((callback: () => void, ms?: number, ...rest: unknown[]) => {
      events.push(`setTimeout ${String(ms)}`);
      return (setTimeout0 as (...a: unknown[]) => unknown)(callback, ms, ...rest);
    }) as unknown as typeof setTimeout;
    return () => {
      globalThis.setInterval = setInterval0;
      globalThis.setTimeout = setTimeout0;
      for (const restore of originals) restore();
    };
  };

  // THE RELEASES' OWN PORTS. A release is registered as a closure, so the trace names what it really calls: the
  // host adapters the world owns, the carriers and counter `start()` builds itself, and the timers it clears.
  for (const [owner, name, label] of [
    [mountedWorld.browserLogin, 'close', 'browserLogin.close'],
    [mountedWorld.agentBrowserDisplay, 'close', 'agentBrowserDisplay.close'],
    [mountedWorld.fileEvents, 'close', 'fileEvents.close'],
    [mountedWorld.tmuxControl, 'stop', 'tmuxControl.stop'],
  ] as const)
    patch(
      owner as Record<string, unknown>,
      name,
      (original: unknown) =>
        ((...args: unknown[]) => {
          events.push(label);
          return (original as (...rest: unknown[]) => unknown)(...args);
        }) as never,
    );
  undo.push(spyOnPrototype(WebRtcCarrier.prototype, 'close', () => events.push('webrtc.close')));
  undo.push(spyOnPrototype(TunnelCarrierSwitch.prototype, 'stop', () => events.push('tunnel.stop')));
  patch(
    mountedWorld.analyticsIndexes,
    'open',
    open =>
      (async (...args: Parameters<typeof open>) => {
        const analytics = await open(...args);
        patch(
          analytics.store,
          'close',
          close =>
            (async () => {
              events.push('analyticsStore.close');
              return await close();
            }) as never,
        );
        return analytics;
      }) as never,
  );
  patch(
    mountedWorld.boot.binder,
    'bind',
    bind =>
      (async (...args: Parameters<typeof bind>) => {
        const server = await bind(...args);
        const handle = server as Record<string, unknown>;
        for (const [name, label] of [
          ['closeSockets', 'server.closeSockets'],
          ['stop', 'server.stop'],
        ] as const)
          patch(
            handle,
            name,
            (original: unknown) =>
              ((...rest: unknown[]) => {
                events.push(label);
                return (original as (...more: unknown[]) => unknown)(...rest);
              }) as never,
          );
        return server;
      }) as never,
  );
  // A timer a release clears is named by the interval it was made with. Only the wiring's own timers count: one
  // MADE in `packages/daemon/bin` (`start()`, or an adapter it declares) and CLEARED by the release itself rather
  // than from inside a subsystem in `packages/daemon/src`, whose own timers are that subsystem's business and
  // some of which have a delay that depends on the clock. A release written `() => clearInterval(t)` is a tail
  // call with no frame of its own, so the clear side looks for a subsystem frame, not for the release's; the
  // gate that runs an early release (`termination-gate.ts`) is a caller, not a subsystem.
  {
    const callerOutsideTheTest = (): string | undefined =>
      (new Error().stack ?? '')
        .split('\n')
        .slice(1)
        .find(frame => !frame.includes('boot-trace.test.ts') && !frame.includes('termination-gate.ts'));
    const madeByWiring = (): boolean => callerOutsideTheTest()?.includes('/packages/daemon/bin/') === true;
    const clearedByTheRelease = (): boolean => callerOutsideTheTest()?.includes('/packages/daemon/src/') !== true;
    const made = new Map<unknown, string>();
    const { setInterval: setInterval0, setTimeout: setTimeout0 } = globalThis;
    const { clearInterval: clearInterval0, clearTimeout: clearTimeout0 } = globalThis;
    const remember =
      (make: (...a: unknown[]) => unknown, kind: string) =>
      (callback: () => void, ms?: number, ...rest: unknown[]) => {
        const handle = make(callback, ms, ...rest);
        if (madeByWiring()) made.set(handle, `${kind} ${String(ms)}`);
        return handle;
      };
    const forget = (clear: (handle: never) => void) => (handle: never) => {
      const name = made.get(handle);
      if (running !== undefined && name !== undefined && clearedByTheRelease()) events.push(`clear ${name}`);
      clear(handle);
    };
    globalThis.setInterval = remember(setInterval0 as never, 'setInterval') as unknown as typeof setInterval;
    globalThis.setTimeout = remember(setTimeout0 as never, 'setTimeout') as unknown as typeof setTimeout;
    globalThis.clearInterval = forget(clearInterval0 as never) as unknown as typeof clearInterval;
    globalThis.clearTimeout = forget(clearTimeout0 as never) as unknown as typeof clearTimeout;
    undo.push(() => {
      globalThis.setInterval = setInterval0;
      globalThis.setTimeout = setTimeout0;
      globalThis.clearInterval = clearInterval0;
      globalThis.clearTimeout = clearTimeout0;
    });
  }
  // Patched on the storage factory itself: it is a class instance, so a spread of it would lose its methods.
  patch(
    mountedWorld.storage,
    'open',
    open =>
      (async () => {
        const opened = await open();
        events.push('storage opened');
        patch(
          opened.storage,
          'close',
          close =>
            (async () => {
              events.push('storage closes');
              return await close();
            }) as never,
        );
        // The two unsubscribes a release calls are named by what they unsubscribe from.
        for (const [name, label] of [
          ['subscribeStates', 'unsubscribe states'],
          ['subscribeEvents', 'unsubscribe events'],
        ] as const)
          patch(
            opened.storage,
            name,
            (subscribe: unknown) =>
              ((...args: unknown[]) => {
                const unsubscribe = (subscribe as (...rest: unknown[]) => unknown)(...args);
                return typeof unsubscribe === 'function'
                  ? () => {
                      events.push(label);
                      return (unsubscribe as () => unknown)();
                    }
                  : unsubscribe;
              }) as never,
          );
        return opened;
      }) as never,
  );
  const world: DaemonWorld = {
    ...mountedWorld,
    notices: {
      step: name => void events.push(`step: ${name}`),
      state: () => undefined,
    },
    // The housekeeping lane never opens inside a case, so its queued passes cannot interleave with the trace.
    boot: { ...mountedWorld.boot, backgroundDelayMs: 3_600_000 },
    createSubsystems: async (...args) => {
      events.push(TRACE.constructBegin);
      const restore = restoreSpies();
      let pending: ReturnType<DaemonWorld['createSubsystems']>;
      try {
        // Everything a subsystem starts while it is built happens inside this one synchronous call.
        pending = mountedWorld.createSubsystems(...args);
      } finally {
        restore();
      }
      events.push(TRACE.constructEnd);
      const created = await pending;
      captured.modules = created.modules;
      instrument(created.mounted as unknown as Record<string, unknown>);
      return created;
    },
    // The two dispatchers `start()` mounts reach the direct carrier as these closures; the call is passed through.
    createDirectCarrier: async (dispatch, sockets, devices, pairing) => {
      captured.dispatch = dispatch;
      captured.sockets = sockets;
      return await mountedWorld.createDirectCarrier(dispatch, sockets, devices, pairing);
    },
    ...(options.failAfterStorage === true
      ? {
          createDirectCarrier: async () => {
            events.push('direct carrier requested');
            throw new Error('the boot failed after storage opened');
          },
        }
      : {}),
    untilShutdown: async () => await stopped.promise,
  };

  const current: Rig = {
    world,
    events,
    cleanups: cleanups as unknown as Release[],
    stop: () => stopped.settle(),
    homesMigrated,
    wardenArmed,
    captured,
    early: async () => await Promise.all(early.answers),
    runCleanups: async () => {
      for (const release of registered.splice(0)) {
        try {
          await release();
        } catch {
          // execute() ignores a failing release too.
        }
      }
    },
  };
  return current;
}

async function untilReady(r: Rig): Promise<void> {
  await waitFor(() => r.events.includes('step: ready'), 'the boot to say ready');
}

/** The warden's `arm()` is only called once the agenda's homes are migrated; the case decides when. */
async function armWarden(r: Rig): Promise<void> {
  r.homesMigrated.settle();
  await waitFor(() => r.events.includes('arm warden'), 'the warden to be armed');
}

describe('the boot and shutdown trace', () => {
  const previousHome = process.env.FY_HOME;
  afterEach(async () => {
    for (const restore of undo.splice(0).reverse()) restore();
    if (previousHome === undefined) delete process.env.FY_HOME;
    else process.env.FY_HOME = previousHome;
    await cleanupTempDirectories();
  });

  it('should record a clean boot and its stop: every step, job arm, construction-time start and release, in order', async () => {
    // Arrange
    const r = await rig();

    // Act
    const exit = start(r.world, r.cleanups);
    await untilReady(r);
    await armWarden(r);
    r.wardenArmed.settle(() => r.events.push('warden disarm'));
    await nextTurn();
    r.events.push('stop requested');
    r.stop();
    const code = await exit;
    r.events.push(`start returned ${String(code)}`);
    await r.runCleanups();

    // Assert
    should(code).equal(0);
    should(r.events).deepEqual(CLEAN_BOOT_THEN_STOP);
  }, 60_000);

  it('should record a stop that lands during the boot: what is released at once, what the unwinding boot registers after, and who releases that', async () => {
    // Arrange: the stop lands inside the declared-wait watcher's first run, after the daemon is serving and
    // before the session observer arms — the stretch `releaseAcquired` exists for.
    const r = await rig({
      duringBoot: async each => {
        each.events.push('stop requested');
        await releaseAcquired(each.cleanups);
        each.events.push('early release done');
        each.stop();
      },
    });

    // Act
    const outcome = await start(r.world, r.cleanups).then(
      code => `returned ${String(code)}`,
      () => 'threw',
    );
    r.events.push(`start ${outcome}`);
    await releaseAcquired(r.cleanups);

    // Assert: the storage closed under the boot, so the boot unwinds; everything it registered after the
    // early release is released by the final pass, in registration order.
    should(r.events).deepEqual(STOP_DURING_BOOT);
  }, 60_000);

  it('should record a boot that throws after storage opened, and release exactly what it had acquired', async () => {
    // Arrange
    const r = await rig({ failAfterStorage: true });

    // Act
    const outcome = await start(r.world, r.cleanups).then(
      code => `returned ${String(code)}`,
      () => 'threw',
    );
    r.events.push(`start ${outcome}`);
    await r.runCleanups();

    // Assert
    should(r.events).deepEqual(BOOT_THAT_THROWS_AFTER_STORAGE_OPENS);
  }, 60_000);

  it('should disarm the warden at once, registering nothing, when the stop lands before its late arm() result', async () => {
    // Arrange
    const r = await rig();
    const exit = start(r.world, r.cleanups);
    await untilReady(r);
    await armWarden(r);

    // Act: the stop, the whole shutdown, and only then the result of the warden's arm().
    r.events.push('stop requested');
    r.stop();
    const code = await exit;
    r.events.push(`start returned ${String(code)}`);
    await r.runCleanups();
    r.events.push('warden arm result lands');
    r.wardenArmed.settle(() => r.events.push('warden disarm'));
    await nextTurn();

    // Assert
    should(code).equal(0);
    should(r.events).deepEqual(STOP_BEFORE_THE_WARDENS_LATE_ARM);
    const landed = r.events.slice(r.events.indexOf('warden arm result lands'));
    should(landed).deepEqual(['warden arm result lands', 'warden disarm']);
  }, 60_000);

  it('should start the agenda resurfacer while the subsystems are built, before the waker and the deadline sweep, when the configuration turns it on', async () => {
    // Arrange: no case above turns `attention.resurfaceAfterMinutes` on, so none of them would notice the start go.
    const r = await rig({ resurface: true });

    // Act
    const exit = start(r.world, r.cleanups);
    await untilReady(r);
    r.stop();
    await exit;
    await r.runCleanups();

    // Assert: the whole construction stretch, so the resurfacer is pinned relative to the waker, the deadline
    // sweep (`setInterval 300000` then `setTimeout 30000`) and the sweeps that follow them.
    const begins = r.events.indexOf('createSubsystems: construction begins');
    const ends = r.events.indexOf('createSubsystems: construction ends');
    should(r.events.slice(begins, ends + 1)).deepEqual(CONSTRUCTION_WITH_THE_RESURFACER_ON);
    should(r.events.filter(event => event === 'agenda resurfacer starts')).have.length(1);
  }, 60_000);

  it('should keep the subsystems a createSubsystems override receives the very ones start() arms', async () => {
    // Arrange
    const r = await rig();

    // Act
    const exit = start(r.world, r.cleanups);
    await untilReady(r);
    r.stop();
    await exit;
    await r.runCleanups();

    // Assert: the override patched the instances it was handed, in place; `start` armed them through those
    // patched instances, so the object the override saw is the object that was mounted.
    const mounted = r.captured.mounted as Record<string, unknown>;
    should(Object.keys(mounted)).containEql('monitor').and.containEql('analyticsIngest').and.containEql('warden');
    for (const armed of ['arm observer', 'arm configFiles', 'arm boardGitHub', 'arm daemonUpdate', 'arm queueDelivery'])
      should(r.events).containEql(armed);
  }, 60_000);

  it('should key every extracted module by its id and mount every route and socket it contributes', async () => {
    // Arrange
    const r = await rig();
    const exit = start(r.world, r.cleanups);
    await untilReady(r);
    const modules = r.captured.modules as Record<string, BuiltModule<unknown, object>>;
    const { dispatch, sockets } = r.captured;
    if (dispatch === undefined || sockets === undefined) throw new Error('the boot never reached the direct carrier');
    const { admin } = await r.world.credentials.load();
    const headers = { authorization: `Bearer ${admin}` };

    // Act: read the route tables of the two dispatchers `start()` mounted. They reach the carrier only as closures, so
    // each is made to answer one authenticated request while `ApiRouter.lookup` records which router it asked; the
    // table is that router's own `routes`, not an answer probed path by path.
    const mountedHttp = await routesBehind(() => dispatch(request({ method: 'GET', path: '/healthz', headers })));
    const mountedSockets = await routesBehind(() =>
      sockets.upgrade(request({ method: 'GET', path: '/healthz', headers })),
    );
    r.stop();
    await exit;
    await r.runCleanups();

    // Assert: the handle's key IS the module's id, and every METHOD+path a module contributes is in the table that
    // is served: routes in the request/response table, sockets in the socket table. Nothing is missing.
    const pair = (route: { readonly method: string; readonly path: string }): string =>
      `${route.method.toUpperCase()} ${route.path}`;
    const missing = (
      contributed: (module: BuiltModule<unknown, object>) => ReadonlyArray<{ method: string; path: string }>,
      mounted: ReadonlySet<string>,
    ): string[] =>
      Object.entries(modules).flatMap(([key, module]) =>
        contributed(module)
          .map(pair)
          .filter(route => !mounted.has(route))
          .map(route => `${key}: ${route}`),
      );
    for (const [key, module] of Object.entries(modules)) should(module.id).equal(key);
    should(missing(module => module.contributes.routes ?? [], mountedHttp)).deepEqual([]);
    should(missing(module => module.contributes.sockets ?? [], mountedSockets)).deepEqual([]);
  }, 60_000);

  it('should answer the early reads of the late-bound 2FA seed ports as today: no owner session, no agenda to raise on, a close that does nothing', async () => {
    // Arrange / Act: asked while the world is being built, before any agenda exists.
    const r = await rig();
    const answers = await r.early();

    // Assert
    should(answers).deepEqual([
      'seedOwnerSession -> undefined',
      'seedAgenda.raise throws "the agenda is not running yet"',
      'seedAgenda.close -> undefined',
    ]);
  });

  /**
   * THE ONE EARLY READ NO SEAM REACHES. The board's roster reads the warden's liveness ledger through
   * `wardenLedgers.read`, which answers `undefined` until `createWardenSubsystem` publishes the real
   * reader far below. The roster, the closure and the object are all built inside `createSubsystems` and
   * nothing hands a test any of them before the published reader replaces the placeholder, so this is
   * pinned as the text it is written as, and the extraction that turns it into a `LateBound` replaces
   * this assertion with a behavioural one on the seam it creates.
   */
  it('should still declare the warden ledger reader as a placeholder that answers undefined until the warden publishes its own', async () => {
    // Arrange
    const source = await Bun.file(new URL('../../../bin/fyd.ts', import.meta.url)).text();

    // Act
    const placeholder = source.match(
      /const wardenLedgers: \{ read: LivenessLedgerReader \} = \{ read: \(\) => undefined \};/u,
    );
    const published = source.match(/parts\.ledgers\.read = sessionId => liveness\.ledger\(sessionId\);/u);
    const roster = source.match(/new StorageSessionRoster\(storage, sessionId => wardenLedgers\.read\(sessionId\)\)/u);

    // Assert
    should(placeholder).not.be.null();
    should(published).not.be.null();
    should(roster).not.be.null();
  });
});
