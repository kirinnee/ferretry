import { describe, expect, it } from 'bun:test';

import {
  PRELOAD_ERROR_EVENT,
  type ApplyDeps,
  type ListenerTarget,
  type RegistrationLike,
  type ServiceWorkerContainerLike,
  type ServiceWorkerUpdate,
  type ServiceWorkerUpdateEnvironment,
  type VisibilityTarget,
  type WaitingRegistration,
  type WorkerLike,
  applyDecision,
  browserApplyDeps,
  canRegister,
  nextUpdateReason,
  runApplyUpdate,
  startPreloadErrorWatch,
  startWorkerLifecycle,
  useServiceWorkerUpdate,
  workerScope,
  workerUrl,
} from '../../src/hooks/use-service-worker-update.ts';
import { render, run, runAsync } from '../support/react.ts';

/** An `addEventListener`/`removeEventListener` pair whose listeners the test fires. */
const listenerTarget = () => {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const target: ListenerTarget = {
    addEventListener: (type, listener) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type, listener) => {
      listeners.get(type)?.delete(listener);
    },
  };
  return {
    target,
    count: (type: string) => listeners.get(type)?.size ?? 0,
    fire: (type: string, event: Partial<Event> = {}) => {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event as Event);
    },
  };
};

const visibilityTarget = (visibilityState = 'visible') => {
  const events = listenerTarget();
  const doc: VisibilityTarget = { ...events.target, visibilityState };
  return { doc, fire: events.fire, count: events.count };
};

const installingWorker = (state = 'installing') => {
  const events = listenerTarget();
  let current = state;
  const worker: WorkerLike = {
    ...events.target,
    get state() {
      return current;
    },
  };
  return {
    worker,
    count: events.count,
    become: (next: string) => {
      current = next;
      events.fire('statechange');
    },
  };
};

interface RegistrationHarness {
  readonly registration: RegistrationLike;
  readonly fire: (type: string) => void;
  readonly count: (type: string) => number;
  readonly updates: () => number;
}

const workerRegistration = (
  options: { installing?: WorkerLike | null; waiting?: unknown; rejectUpdate?: boolean } = {},
): RegistrationHarness => {
  const events = listenerTarget();
  let updates = 0;
  const registration: RegistrationLike = {
    ...events.target,
    installing: options.installing ?? null,
    waiting: options.waiting ?? null,
    update: async () => {
      updates += 1;
      if (options.rejectUpdate === true) throw new Error('update check failed');
      return undefined;
    },
  };
  return { registration, fire: events.fire, count: events.count, updates: () => updates };
};

interface ContainerHarness {
  readonly container: ServiceWorkerContainerLike;
  readonly registered: () => { url: string; scope: string }[];
  readonly controllerChange: () => void;
  readonly controllerListeners: () => number;
}

const container = (options: {
  controller?: unknown;
  registration?: RegistrationLike;
  rejectRegister?: boolean;
  waiting?: WaitingRegistration | null | undefined;
  rejectLookup?: boolean;
}): ContainerHarness => {
  const registered: { url: string; scope: string }[] = [];
  const controllerListeners: (() => void)[] = [];
  return {
    container: {
      controller: options.controller ?? null,
      register: async (url, scope) => {
        registered.push({ url, scope: scope.scope });
        if (options.rejectRegister === true) throw new Error('registration was refused');
        if (options.registration === undefined) throw new Error('no registration was configured');
        return options.registration;
      },
      getRegistration: async () => {
        if (options.rejectLookup === true) throw new Error('the registration lookup was revoked');
        return options.waiting;
      },
      addEventListener: (_type, listener) => controllerListeners.push(listener),
    },
    registered: () => registered,
    controllerChange: () => {
      for (const listener of controllerListeners) listener();
    },
    controllerListeners: () => controllerListeners.length,
  };
};

const settle = () =>
  runAsync(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

describe('workerScope and workerUrl', () => {
  it('normalises an app base path into a scope', () => {
    expect(workerScope()).toBe('/');
    expect(workerScope('/')).toBe('/');
    expect(workerScope('app')).toBe('/app/');
    expect(workerScope('/app')).toBe('/app/');
    expect(workerScope('/app/')).toBe('/app/');
  });

  it('names the release inside the app scope, not at a fixed origin root', () => {
    expect(workerUrl('2026.08.03-1')).toBe('/sw.2026.08.03-1.js');
    expect(workerUrl('abc123', '/app')).toBe('/app/sw.abc123.js');
  });

  it('refuses a release that is not a plain asset name', () => {
    expect(() => workerUrl('../evil')).toThrow('plain asset name');
    expect(() => workerUrl('')).toThrow('plain asset name');
  });
});

describe('nextUpdateReason', () => {
  it('never downgrades recovery and always upgrades to it', () => {
    expect(nextUpdateReason(null, 'update')).toBe('update');
    expect(nextUpdateReason('update', 'update')).toBe('update');
    expect(nextUpdateReason('recovery', 'update')).toBe('recovery');
    expect(nextUpdateReason('update', 'recovery')).toBe('recovery');
    expect(nextUpdateReason(null, 'recovery')).toBe('recovery');
  });
});

describe('canRegister', () => {
  it('asks for the secure-context fact rather than deriving it from a protocol', () => {
    expect(canRegister({ serviceWorker: {} as ServiceWorkerContainer }, true)).toBe(true);
    expect(canRegister({ serviceWorker: {} as ServiceWorkerContainer }, false)).toBe(false);
    expect(canRegister({}, true)).toBe(false);
    expect(canRegister(undefined, true)).toBe(false);
  });
});

describe('applyDecision', () => {
  it('takes the direct reload branch when no worker is waiting', () => {
    expect(applyDecision({ waiting: { postMessage: () => undefined } }, false)).toBe('skip-waiting');
    expect(applyDecision({ waiting: null }, false)).toBe('direct-reload');
    expect(applyDecision(null, false)).toBe('direct-reload');
    expect(applyDecision({ waiting: null }, true)).toBe('already-armed');
  });
});

describe('runApplyUpdate', () => {
  const deps = (over: Partial<ApplyDeps> = {}) => {
    const log = { armed: 0, reloads: 0, posted: [] as unknown[] };
    let armedFlag = false;
    const base: ApplyDeps = {
      getRegistration: async () => ({ waiting: { postMessage: message => log.posted.push(message) } }),
      armReload: () => {
        log.armed += 1;
      },
      reload: () => {
        log.reloads += 1;
      },
      isArmed: () => armedFlag,
      setArmed: () => {
        armedFlag = true;
      },
    };
    return { deps: { ...base, ...over }, log };
  };

  it('arms this tab before telling the waiting worker to take over', async () => {
    const { deps: applyDeps, log } = deps();

    expect(await runApplyUpdate(applyDeps)).toBe('skip-waiting');
    expect(log.armed).toBe(1);
    expect(log.posted).toEqual([{ type: 'SKIP_WAITING' }]);
    expect(log.reloads).toBe(0);
  });

  it('reloads directly when there is no waiter to hear a message', async () => {
    const { deps: applyDeps, log } = deps({ getRegistration: async () => ({ waiting: null }) });

    expect(await runApplyUpdate(applyDeps)).toBe('direct-reload');
    expect(log.reloads).toBe(1);
    expect(log.armed).toBe(0);
  });

  it('treats a rejected lookup as no waiter rather than stranding the reader', async () => {
    const { deps: applyDeps, log } = deps({
      getRegistration: async () => {
        throw new Error('private mode revoked the registration');
      },
    });

    expect(await runApplyUpdate(applyDeps)).toBe('direct-reload');
    expect(log.reloads).toBe(1);
  });

  it('collapses a second press into one action', async () => {
    const { deps: applyDeps, log } = deps({ isArmed: () => true });

    expect(await runApplyUpdate(applyDeps)).toBe('already-armed');
    expect(log.reloads).toBe(0);
  });

  it('does nothing when the guard was set while the lookup was in flight', async () => {
    let armed = false;
    const { deps: applyDeps, log } = deps({
      getRegistration: async () => {
        armed = true;
        return { waiting: null };
      },
      isArmed: () => armed,
    });

    expect(await runApplyUpdate(applyDeps)).toBe('already-armed');
    expect(log.reloads).toBe(0);
  });
});

describe('startWorkerLifecycle', () => {
  it('registers at the app scope and offers the update a previous visit installed', async () => {
    const registration = workerRegistration({ waiting: { postMessage: () => undefined } });
    const harness = container({ controller: {}, registration: registration.registration });
    const raised: string[] = [];

    const stop = startWorkerLifecycle({
      container: harness.container,
      doc: visibilityTarget().doc,
      release: 'r1',
      basePath: '/app',
      onUpdateReady: reason => raised.push(reason),
      onError: () => raised.push('error'),
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.registered()).toEqual([{ url: '/app/sw.r1.js', scope: '/app/' }]);
    expect(raised).toEqual(['update']);
    stop();
  });

  it('offers nothing on a first install, and offers once the new worker is installed', async () => {
    const installing = installingWorker();
    const registration = workerRegistration({ installing: installing.worker });
    const withoutController = container({ controller: null, registration: registration.registration });
    const raised: string[] = [];

    const stop = startWorkerLifecycle({
      container: withoutController.container,
      doc: visibilityTarget().doc,
      release: 'r1',
      onUpdateReady: reason => raised.push(reason),
      onError: () => undefined,
    });
    await Promise.resolve();
    await Promise.resolve();

    installing.become('installed');
    expect(raised).toEqual([]);

    const second = installingWorker();
    const controlled = workerRegistration({ installing: second.worker });
    const withController = container({ controller: {}, registration: controlled.registration });
    const offers: string[] = [];
    const stopSecond = startWorkerLifecycle({
      container: withController.container,
      doc: visibilityTarget().doc,
      release: 'r2',
      onUpdateReady: reason => offers.push(reason),
      onError: () => undefined,
    });
    await Promise.resolve();
    await Promise.resolve();
    second.become('installed');

    expect(offers).toEqual(['update']);
    stop();
    stopSecond();
  });

  it('watches the worker a later updatefound starts installing', async () => {
    const later = installingWorker('installed');
    const registration = workerRegistration({ installing: null });
    const harness = container({ controller: {}, registration: registration.registration });
    const raised: string[] = [];

    const stop = startWorkerLifecycle({
      container: harness.container,
      doc: visibilityTarget().doc,
      release: 'r1',
      onUpdateReady: reason => raised.push(reason),
      onError: () => undefined,
    });
    await Promise.resolve();
    await Promise.resolve();

    Object.defineProperty(registration.registration, 'installing', { value: later.worker, configurable: true });
    registration.fire('updatefound');

    expect(raised).toEqual(['update']);
    expect(later.count('statechange')).toBe(1);
    stop();
    expect(later.count('statechange')).toBe(0);
  });

  it('reports a refused registration instead of breaking the app', async () => {
    const harness = container({ rejectRegister: true });
    const errors: unknown[] = [];

    const stop = startWorkerLifecycle({
      container: harness.container,
      doc: visibilityTarget().doc,
      release: 'r1',
      onUpdateReady: () => undefined,
      onError: error => errors.push(error),
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(errors).toHaveLength(1);
    stop();
  });

  it('attaches nothing when the cleanup ran while registration was in flight', async () => {
    const registration = workerRegistration({ waiting: { postMessage: () => undefined } });
    const harness = container({ controller: {}, registration: registration.registration });
    const raised: string[] = [];

    const stop = startWorkerLifecycle({
      container: harness.container,
      doc: visibilityTarget().doc,
      release: 'r1',
      onUpdateReady: reason => raised.push(reason),
      onError: () => undefined,
    });
    stop();
    await Promise.resolve();
    await Promise.resolve();

    expect(raised).toEqual([]);
    expect(registration.count('updatefound')).toBe(0);
  });

  it('re-checks when the tab comes back, and only then', async () => {
    const registration = workerRegistration({ rejectUpdate: true });
    const harness = container({ registration: registration.registration });
    const visible = visibilityTarget('visible');
    const hidden = visibilityTarget('hidden');

    const stopHidden = startWorkerLifecycle({
      container: container({ registration: workerRegistration().registration }).container,
      doc: hidden.doc,
      release: 'r1',
      onUpdateReady: () => undefined,
      onError: () => undefined,
    });
    hidden.fire('visibilitychange');
    stopHidden();

    const stop = startWorkerLifecycle({
      container: harness.container,
      doc: visible.doc,
      release: 'r1',
      onUpdateReady: () => undefined,
      onError: () => undefined,
    });
    await Promise.resolve();
    await Promise.resolve();
    visible.fire('visibilitychange');
    await Promise.resolve();

    expect(registration.updates()).toBe(1);
    stop();
    expect(visible.count('visibilitychange')).toBe(0);
  });
});

describe('startPreloadErrorWatch', () => {
  it('claims the preload failure and raises recovery', () => {
    const events = listenerTarget();
    let prevented = 0;
    let raised = 0;

    const stop = startPreloadErrorWatch(events.target, () => {
      raised += 1;
    });
    events.fire(PRELOAD_ERROR_EVENT, {
      preventDefault: () => {
        prevented += 1;
      },
    });

    expect(prevented).toBe(1);
    expect(raised).toBe(1);
    stop();
    expect(events.count(PRELOAD_ERROR_EVENT)).toBe(0);
  });
});

describe('browserApplyDeps', () => {
  it('reloads this tab when the controller changes, once', async () => {
    const waiting: WaitingRegistration = { waiting: { postMessage: () => undefined } };
    const harness = container({ waiting });
    let reloads = 0;
    let armed = false;

    const deps = browserApplyDeps({
      container: harness.container,
      basePath: '/app',
      reload: () => {
        reloads += 1;
      },
      isArmed: () => armed,
      setArmed: () => {
        armed = true;
      },
    });

    expect(await deps.getRegistration()).toBe(waiting);
    deps.armReload();
    harness.controllerChange();

    expect(harness.controllerListeners()).toBe(1);
    expect(reloads).toBe(1);
  });

  it('answers no registration where the container is absent, and arms nothing', async () => {
    const deps = browserApplyDeps({
      container: null,
      reload: () => undefined,
      isArmed: () => false,
      setArmed: () => undefined,
    });

    expect(await deps.getRegistration()).toBeNull();
    deps.armReload();
  });

  it('normalises an undefined registration to null', async () => {
    const deps = browserApplyDeps({
      container: container({ waiting: undefined }).container,
      reload: () => undefined,
      isArmed: () => false,
      setArmed: () => undefined,
    });

    expect(await deps.getRegistration()).toBeNull();
  });
});

describe('useServiceWorkerUpdate', () => {
  const mount = (environment: ServiceWorkerUpdateEnvironment) => {
    let latest: ServiceWorkerUpdate | undefined;
    function Probe() {
      latest = useServiceWorkerUpdate(environment);
      return null;
    }
    const renderer = render(<Probe />);
    return {
      hook: () => {
        if (latest === undefined) throw new Error('the hook did not run');
        return latest;
      },
      unmount: async () => {
        await runAsync(async () => {
          renderer.unmount();
        });
      },
    };
  };

  it('raises the update chip from the lifecycle and upgrades it to recovery', async () => {
    const registration = workerRegistration({ waiting: { postMessage: () => undefined } });
    const harness = container({ controller: {}, registration: registration.registration });
    const win = listenerTarget();
    const probe = mount({
      release: 'r1',
      container: harness.container,
      doc: visibilityTarget().doc,
      win: win.target,
      reload: () => undefined,
      onError: () => undefined,
    });
    await settle();

    expect(probe.hook().updateReady).toBe('update');

    run(() =>
      win.fire(PRELOAD_ERROR_EVENT, {
        preventDefault: () => undefined,
      }),
    );
    expect(probe.hook().updateReady).toBe('recovery');
    await probe.unmount();
  });

  it('still offers recovery where no worker can be registered', async () => {
    const win = listenerTarget();
    const probe = mount({
      release: 'r1',
      container: null,
      doc: visibilityTarget().doc,
      win: win.target,
      reload: () => undefined,
      onError: () => undefined,
    });
    await settle();

    expect(probe.hook().updateReady).toBeNull();
    run(() => probe.hook().raiseRecovery());
    expect(probe.hook().updateReady).toBe('recovery');
    await probe.unmount();
  });

  it('reloads once per chip press, no matter how many times it is pressed', async () => {
    const harness = container({ waiting: { waiting: null } });
    let reloads = 0;
    const probe = mount({
      release: 'r1',
      container: harness.container,
      doc: visibilityTarget().doc,
      win: listenerTarget().target,
      reload: () => {
        reloads += 1;
      },
      onError: () => undefined,
    });
    await settle();

    run(() => probe.hook().applyUpdate());
    await settle();
    run(() => probe.hook().applyUpdate());
    await settle();

    expect(reloads).toBe(1);
    await probe.unmount();
  });
});
