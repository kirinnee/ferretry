// This import MUST come first: it captures Bun's WebSocket and WebCrypto before happy-dom replaces the globals.
import { NativeResponse, nativeSetTimeout } from './native-socket.ts';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { EventDef } from '@ferretry/kernel/contract';
import { type StartedDaemon, startDaemon } from '../../../../../scripts/test/two-release/daemon.ts';
import { builds, hits, hitTotal, resetCounters } from '../../../../../scripts/test/two-release/hits.ts';
import { buildReleases, type Release } from '../../../../../scripts/test/two-release/releases.ts';
import { UPDATE_DAEMON_COMMAND } from '../../../src/client/sentences.ts';
import { DaemonCallError } from '../../../src/client/transport.ts';
import { DeviceLayoutStore } from '../../../src/layout/device-layout.ts';
import { ScrollMemory } from '../../../src/scroll/scroll-memory.ts';
import { App } from '../../../src/shell/app.tsx';
import { ShellProvider, type ShellWindow } from '../../../src/shell/context.tsx';
import { PluginView } from '../../../src/shell/views.tsx';
import { ThemePreferenceStore } from '../../../src/theme/preferences.ts';
import { type AppSession, openApp } from './session.ts';

/**
 * THE TWO-RELEASE FIXTURE, the app's leg (redesign §10.5, §9.6).
 *
 * The app of THIS commit (release A: the real `DaemonClient`, the real `ShellRuntime`, the real `App` frame in
 * happy-dom) runs over a REAL paired direct session — a WebSocket to the daemon's own listener, a sealed session, the
 * device's key — against a real daemon of release A or of a release BUILT WITH A CHANGE (the real generator, the real
 * kernel host, the hashes the change really moves).
 *
 * "Nothing was attempted" is read three independent ways: the recording transport holds no request, socket or event
 * stream for the blocked package; the daemon's own hit counters are zero; and no half of the blocked package was built.
 *
 * Titles that start with a gap id (G1, G2, G3) are RED on 5.0 because a piece of 5.0 is not built: G1 Gate projects a
 * device's inventory with an empty surface map, so a paired device sees no plugin at all; G2 the kernel has no event
 * stream route. They turn green when the gap lands; none is skipped. G4 (Catalogs' member table) is a `todo`.
 */

/** The packages every release carries unchanged: the core pieces, Access, and Connections (its direct carrier serves the paired session). */
const CORE_IDS = ['kernel', 'gate', 'asks', 'vault', 'ferrets', 'access', 'connections'] as const;
const FIXTURE_IDS = ['alpha', 'beta', 'gamma', 'delta'] as const;
const OLDER = '4.9.0';
const NEWER = '5.1.0';
/** The remedy the app names for an older daemon: its own constant, the one fact (redesign §9.6: `fy update`). */
const UPDATE = `\`${UPDATE_DAEMON_COMMAND}\``;

let A: Release;
let Bb: Release;
let Bc: Release;
let Bd: Release;

/**
 * The DOM, loaded for THIS file only. The integration tier runs every file in one bun process, and happy-dom replaces
 * the global scope (fetch, WebSocket, timers) for whoever runs after it, so it is registered here and unregistered
 * in `afterAll`: no other integration file ever sees it.
 */
let dom: typeof import('../../support/dom.ts');
const mount: typeof import('../../support/dom.ts').mount = element => dom.mount(element);
const interact: typeof import('../../support/dom.ts').interact = callback => dom.interact(callback);

beforeAll(async () => {
  dom = await import('../../support/dom.ts');
  // The daemon in this process answers through the global `Response`, and `Bun.serve` accepts only Bun's own.
  globalThis.Response = NativeResponse;
  [A, Bb, Bc, Bd] = await buildReleases();
});

afterAll(async () => {
  for (const release of [A, Bb, Bc, Bd]) release?.dispose();
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  await GlobalRegistrator.unregister();
  (globalThis as { __ferretryDomRegistered?: boolean }).__ferretryDomRegistered = false;
});

const browser = (): ShellWindow => ({
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  document: { documentElement: document.documentElement },
});

const go = (path: string): void => window.history.replaceState({}, '', path);
afterEach(() => {
  if (typeof window !== 'undefined') go('/');
});

/** A bounded poll with a short step; the step is a poll interval, never a budget. */
async function until(condition: () => boolean, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`waited ${ms} ms for ${what}, and it never happened`);
    await interact(() => new Promise<void>(resolve => nativeSetTimeout(resolve, 10)));
  }
}

interface Scenario {
  readonly daemon: StartedDaemon;
  readonly session: AppSession;
  stop(): Promise<void>;
}

/**
 * A device paired with `grants` on an ALREADY-RUNNING `daemon`, the app of release A over it, its inventory read.
 * Stopping it closes the device only; whoever booted the daemon stops it.
 */
async function pairDevice(daemon: StartedDaemon, grants: 'full' | 'limited'): Promise<Scenario> {
  const session = await openApp(daemon, A, { grants });
  try {
    await session.ready();
  } catch (error) {
    session.close();
    throw error;
  }
  return { daemon, session, stop: async () => session.close() };
}

/** A daemon of `daemonRelease`, a device paired with `grants`, the app of release A over it, its inventory read. */
async function open(
  daemonRelease: Release,
  options: { readonly version: string; readonly grants: 'full' | 'limited' },
): Promise<Scenario> {
  const daemon = await startDaemon(daemonRelease, { version: options.version });
  try {
    const device = await pairDevice(daemon, options.grants);
    return {
      ...device,
      stop: async () => {
        await device.stop();
        await daemon.stop();
      },
    };
  } catch (error) {
    await daemon.stop();
    throw error;
  }
}

async function drawApp(scenario: Scenario, path: string) {
  go(path);
  const { session } = scenario;
  return await mount(
    <App
      runtime={session.runtime}
      themes={new ThemePreferenceStore(session.storage)}
      layouts={new DeviceLayoutStore(session.storage)}
      browser={browser()}
      scroll={new ScrollMemory(null)}
    />,
  );
}

/** The package client of an id, even when it is blocked (`ShellRuntime.packageClient` answers nothing for a blocked one). */
function clientOf(scenario: Scenario, caller: string) {
  const connection = scenario.session.runtime.connection(scenario.session.daemonId);
  if (connection.kind !== 'connected') throw new Error('the app is not connected');
  return connection.client.forPackage(caller);
}

const standing = (scenario: Scenario, id: string) => scenario.session.runtime.standing(scenario.session.daemonId, id);
const lineOf = (scenario: Scenario, id: string) => scenario.session.runtime.blockedLine(scenario.session.daemonId, id);

async function refusal(promise: Promise<unknown>): Promise<DaemonCallError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DaemonCallError) return error;
    throw error;
  }
  throw new Error('the call was sent; it should have been refused without being sent');
}

/** The sentences a blocked package shows (`sentences.ts`), per release direction. */
const OLDER_LINES = {
  alpha: `Update this daemon to use Alpha: ${UPDATE}.`,
  beta: `Beta needs Alpha, which needs an update: ${UPDATE}.`,
  gamma: `Gamma needs Alpha, which needs an update: ${UPDATE}.`,
};
const NEWER_LINES = {
  alpha: 'Reload the app to use Alpha.',
  beta: 'Beta needs Alpha, which needs a reload of the app.',
  gamma: 'Gamma needs Alpha, which needs a reload of the app.',
};

/** Nothing the app sent a daemon names a blocked package's paths. */
function expectNothingSentTo(scenario: Scenario, ...ids: ('alpha' | 'beta' | 'gamma')[]): void {
  const sent = scenario.session.recording().paths();
  for (const id of ids) expect(sent.filter(path => path.startsWith(`/v1/${id}`))).toEqual([]);
}

// ─── (a) nothing changed ───────────────────────────────────────────────────────────────────────────────────────────────

describe('(a) nothing changed: the app of this commit against a daemon of this commit, a full device', () => {
  let scenario: Scenario;
  beforeAll(async () => {
    scenario = await open(A, { version: A.appVersion, grants: 'full' });
  });
  afterAll(async () => {
    await scenario.stop();
  });

  test('every core piece is allowed', () => {
    for (const id of CORE_IDS) expect(standing(scenario, id)).toEqual({ state: 'allowed' });
  });

  test('G1 every fixture plugin is allowed (a paired device sees no plugin in its inventory yet)', () => {
    for (const id of FIXTURE_IDS) expect(standing(scenario, id)).toEqual({ state: 'allowed' });
  });

  test('G1 delta’s route answers and its socket opens and echoes one frame', async () => {
    resetCounters();
    const client = clientOf(scenario, 'delta');
    expect(await client.call('GET /v1/delta')).toEqual({ plugin: 'delta', item: 'one' });
    const frames: string[] = [];
    const socket = client.socket(
      'GET /v1/delta/stream',
      {},
      {
        onFrame: frame => frames.push(typeof frame === 'string' ? frame : new TextDecoder().decode(frame)),
        onClose: () => {},
      },
    );
    await until(() => frames.length > 0, 'delta’s socket to echo its frame');
    socket.close();
    expect(JSON.parse(frames[0] as string)).toEqual({ frame: 'delta' });
    expect(hits.delta.route).toBe(1);
    expect(hits.delta.socket).toBe(1);
  });

  test('G1 alpha’s route answers: the provider is reachable when it matches', async () => {
    resetCounters();
    expect(await clientOf(scenario, 'alpha').call('GET /v1/alpha/items')).toEqual({ plugin: 'alpha', item: 'one' });
    expect(hits.alpha.route).toBe(1);
  });

  test('G1 the mounted app draws delta’s screen', async () => {
    const view = await drawApp(scenario, `/d/${scenario.session.daemonId}/delta`);
    await until(() => view.container.querySelector('[data-testid="delta"]') !== null, 'delta’s screen');
    expect(view.container.querySelector('[data-testid="delta"]')?.textContent).toBe('The Delta screen');
    await view.unmount();
  });

  test('G1 the positive control for (c): the ask renderer of the unchanged workspace DRAWS gamma’s renderer and builds its half', async () => {
    resetCounters();
    const view = await mount(
      <PluginViewWithShell id="ask:alpha-item" plugin="gamma" scenario={scenario} section="renderers" />,
    );
    await until(
      () => view.container.querySelector('[data-testid="gamma-renderer"]') !== null,
      'gamma’s renderer to be drawn',
    );
    expect(view.container.querySelector('[data-testid="gamma-renderer"]')?.textContent).toBe('The Gamma renderer');
    await view.unmount();
    expect(builds.gamma.app).toBe(1);
  });

  test('G2 an unchanged event reaches its listener (the kernel has no event stream route)', async () => {
    const { DeltaChangedEvent } = await A.load('packages/plugins/delta/contract/index.ts');
    const heard: unknown[] = [];
    const cancel = clientOf(scenario, 'delta').subscribe(
      DeltaChangedEvent as EventDef<'delta.changed', { item: string }>,
      payload => heard.push(payload),
    );
    try {
      await until(() => {
        scenario.daemon.host.events.publish(DeltaChangedEvent as EventDef, { item: 'one' });
        return heard.length > 0;
      }, 'G2: delta.changed to reach the app (no event stream route on the kernel)');
    } finally {
      cancel();
    }
    expect(heard[0]).toEqual({ item: 'one' });
  });
});

// ─── (b) one provider's route, tool, event and socket schema changed ──────────────────────────────────────────────────

describe('(b) a provider’s route, tool, event and socket schema changed: daemon B_b', () => {
  describe('the daemon is older than the app', () => {
    let scenario: Scenario;
    beforeAll(async () => {
      scenario = await open(Bb, { version: OLDER, grants: 'full' });
    });
    afterAll(async () => {
      await scenario.stop();
    });

    test('G1 alpha is blocked as different; beta and gamma are blocked through alpha; delta and the core pieces are allowed', () => {
      expect(standing(scenario, 'alpha')).toEqual({ state: 'blocked', reason: 'different' });
      expect(standing(scenario, 'beta')).toEqual({ state: 'blocked', reason: 'different', via: 'alpha' });
      expect(standing(scenario, 'gamma')).toEqual({ state: 'blocked', reason: 'different', via: 'alpha' });
      expect(standing(scenario, 'delta')).toEqual({ state: 'allowed' });
      for (const id of CORE_IDS) expect(standing(scenario, id)).toEqual({ state: 'allowed' });
    });

    test('G1 each blocked package says what to do, and who it is waiting for', () => {
      expect(lineOf(scenario, 'alpha')).toBe(OLDER_LINES.alpha);
      expect(lineOf(scenario, 'beta')).toBe(OLDER_LINES.beta);
      expect(lineOf(scenario, 'gamma')).toBe(OLDER_LINES.gamma);
    });

    test('G1 a route, a socket, the consumer’s call to the provider and a tool-bearing subscription are all refused `plugin_paused`, unsent', async () => {
      resetCounters();
      scenario.session.recording().reset();
      const { AlphaChangedEvent } = await A.load('packages/plugins/alpha/contract/index.ts');
      const alpha = clientOf(scenario, 'alpha');
      const beta = clientOf(scenario, 'beta');

      expect((await refusal(alpha.call('GET /v1/alpha/items'))).code).toBe('plugin_paused');
      expect(() => alpha.socket('GET /v1/alpha/stream', {}, { onFrame: () => {}, onClose: () => {} })).toThrow(
        /paused/u,
      );
      // The consumer calling the provider is refused on the PROVIDER's standing.
      expect((await refusal(beta.call('GET /v1/alpha/items'))).code).toBe('plugin_paused');

      // A subscription is registered but heard only while its package is allowed: the publish below reaches no one.
      let heard = 0;
      const spied = {
        ...(AlphaChangedEvent as EventDef),
        schema: {
          safeParse: (value: unknown) => {
            heard += 1;
            return { success: true, data: value };
          },
        },
      } as unknown as EventDef<'alpha.changed', unknown>;
      const cancel = alpha.subscribe(spied, () => {
        heard += 1;
      });
      scenario.daemon.host.events.publish(AlphaChangedEvent as EventDef, { item: 'one' });
      await interact(() => new Promise<void>(resolve => nativeSetTimeout(resolve, 50)));
      cancel();
      expect(heard).toBe(0);

      // The three witnesses.
      expectNothingSentTo(scenario, 'alpha', 'beta', 'gamma');
      expect(scenario.session.recording().sockets()).toEqual([]);
      for (const id of ['alpha', 'beta', 'gamma'] as const) expect(hitTotal(id)).toBe(0);
    });

    test('G1 the mounted screens draw the same lines and none of the blocked halves was built', async () => {
      resetCounters();
      for (const id of ['alpha', 'beta', 'gamma'] as const) {
        const view = await drawApp(scenario, `/d/${scenario.session.daemonId}/${id}`);
        await until(() => view.container.textContent?.includes(OLDER_LINES[id]) === true, `${id}’s blocked line`);
        expect(view.container.querySelector(`[data-testid="${id}"]`)).toBeNull();
        await view.unmount();
      }
      for (const id of ['alpha', 'beta', 'gamma'] as const) expect(builds[id].app).toBe(0);
      expectNothingSentTo(scenario, 'alpha', 'beta', 'gamma');
    });

    test('G1 delta still works after the blocked attempts', async () => {
      resetCounters();
      expect(await clientOf(scenario, 'delta').call('GET /v1/delta')).toEqual({ plugin: 'delta', item: 'one' });
      expect(hits.delta.route).toBe(1);
    });
  });

  describe('the daemon is newer than the app', () => {
    let scenario: Scenario;
    beforeAll(async () => {
      scenario = await open(Bb, { version: NEWER, grants: 'full' });
    });
    afterAll(async () => {
      await scenario.stop();
    });

    test('G1 the remedy flips to a reload of the app', () => {
      expect(lineOf(scenario, 'alpha')).toBe(NEWER_LINES.alpha);
      expect(lineOf(scenario, 'beta')).toBe(NEWER_LINES.beta);
      expect(lineOf(scenario, 'gamma')).toBe(NEWER_LINES.gamma);
    });
  });
});

// ─── (c) a consumer's renderer for that provider ──────────────────────────────────────────────────────────────────────

describe('(c) a consumer that only RENDERS the provider’s ask source: daemon B_c', () => {
  let scenario: Scenario;
  beforeAll(async () => {
    scenario = await open(Bc, { version: OLDER, grants: 'full' });
  });
  afterAll(async () => {
    await scenario.stop();
  });

  test('G1 gamma, which imports nothing of alpha, is blocked through its renderer edge; alpha and beta are blocked; delta works', async () => {
    expect(standing(scenario, 'gamma')).toEqual({ state: 'blocked', reason: 'different', via: 'alpha' });
    expect(standing(scenario, 'alpha')).toEqual({ state: 'blocked', reason: 'different' });
    expect(standing(scenario, 'beta')).toEqual({ state: 'blocked', reason: 'different', via: 'alpha' });
    expect(standing(scenario, 'delta')).toEqual({ state: 'allowed' });
    resetCounters();
    expect(await clientOf(scenario, 'delta').call('GET /v1/delta')).toEqual({ plugin: 'delta', item: 'one' });
  });

  test('G1 the ask renderer shows the line instead of drawing, gamma’s half is never built and nothing is sent to it', async () => {
    resetCounters();
    scenario.session.recording().reset();
    const view = await mount(
      <PluginViewWithShell id="ask:alpha-item" plugin="gamma" scenario={scenario} section="renderers" />,
    );
    await until(() => view.container.textContent?.includes(OLDER_LINES.gamma) === true, 'gamma’s renderer line');
    expect(view.container.querySelector('[data-testid="gamma-renderer"]')).toBeNull();
    await view.unmount();
    expect(builds.gamma.app).toBe(0);
    expectNothingSentTo(scenario, 'alpha', 'beta', 'gamma');
    expect(hitTotal('gamma')).toBe(0);
  });
});

/** A plugin view inside the real frame's provider: `PluginView` reads the shell through context. */
function PluginViewWithShell(props: {
  readonly scenario: Scenario;
  readonly plugin: string;
  readonly section: 'renderers';
  readonly id: string;
}) {
  return (
    <ShellProvider
      browser={browser()}
      layouts={new DeviceLayoutStore(props.scenario.session.storage)}
      runtime={props.scenario.session.runtime}
      scroll={new ScrollMemory(null)}
      themes={new ThemePreferenceStore(props.scenario.session.storage)}
    >
      <PluginView
        daemon={props.scenario.session.daemonId}
        id={props.id}
        plugin={props.plugin}
        props={{}}
        section={props.section}
      />
    </ShellProvider>
  );
}

// ─── (d) a core contract changed ──────────────────────────────────────────────────────────────────────────────────────

describe('(d) a core contract changed: daemon B_d', () => {
  for (const [direction, version, sentence] of [
    ['older', OLDER, `This daemon needs an update: run ${UPDATE} on that machine.`],
    ['newer', NEWER, 'Reload to get the new app.'],
  ] as const) {
    describe(`the daemon is ${direction} than the app`, () => {
      let scenario: Scenario;
      beforeAll(async () => {
        resetCounters();
        scenario = await open(Bd, { version, grants: 'full' });
      });
      afterAll(async () => {
        await scenario.stop();
      });

      test('the whole daemon is blocked with one sentence, and every compiled package is blocked as core', () => {
        expect(scenario.session.runtime.wholeDaemonLine(scenario.session.daemonId)).toBe(sentence);
        for (const id of [...CORE_IDS, ...FIXTURE_IDS])
          expect(standing(scenario, id)).toEqual({ state: 'blocked', reason: 'core' });
      });

      test('the mounted app draws the full-screen sentence instead of the screen, with no side panel', async () => {
        const view = await drawApp(scenario, `/d/${scenario.session.daemonId}/delta`);
        await until(
          () => view.container.querySelector('main')?.textContent?.includes(sentence) === true,
          'the sentence',
        );
        expect(view.container.querySelector('[data-testid="delta"]')).toBeNull();
        expect(view.container.querySelector('[data-slot="side"]')).toBeNull();
        await view.unmount();
      });

      test('nothing but the inventory and the version was read, and no plugin did any work — the unchanged one included', () => {
        const sent = scenario.session.recording().requests();
        expect(sent.filter(line => line !== 'GET /v1/plugins' && line !== 'GET /v1/health')).toEqual([]);
        expect(scenario.session.recording().sockets()).toEqual([]);
        for (const id of FIXTURE_IDS) {
          expect(hitTotal(id)).toBe(0);
          expect(builds[id].app).toBe(0);
        }
      });
    });
  }
});

// ─── (e) a limited device ─────────────────────────────────────────────────────────────────────────────────────────────

describe('(e) a limited device reads the inventory: daemon A', () => {
  // ONE daemon, two devices paired on it: the control is about one Gate projecting the same table differently.
  let daemon: StartedDaemon;
  let limited: Scenario;
  let full: Scenario;
  const stopAll = async (): Promise<void> => {
    await limited?.stop();
    await full?.stop();
    await daemon?.stop();
  };
  beforeAll(async () => {
    daemon = await startDaemon(A, { version: A.appVersion });
    try {
      limited = await pairDevice(daemon, 'limited');
      full = await pairDevice(daemon, 'full');
    } catch (error) {
      await stopAll();
      throw error;
    }
  });
  afterAll(stopAll);

  test('G1 the limited device’s inventory is the core pieces, Access, Connections (`GET /v1/carriers` asks no capability) and the one plugin its grants admit', () => {
    const connection = limited.session.runtime.connection(limited.session.daemonId);
    if (connection.kind !== 'connected' || connection.client.inventory?.kind !== 'read')
      throw new Error('no inventory');
    expect([...connection.client.inventory.entries.keys()].sort()).toEqual([...CORE_IDS, 'delta'].sort());
  });

  // NOT evidence of grant filtering today: while G1 stands every paired device, a full one included, reads these as
  // `missing` (the G1 control below is the red half). It becomes a proof of the limited projection when G1 lands.
  test('the plugins the grants do not admit are missing, say so in their own line, and are never contacted (a proof of filtering only once G1 lands; today every device reads missing)', () => {
    limited.session.recording().reset();
    for (const id of ['alpha', 'beta', 'gamma'] as const) {
      expect(standing(limited, id)).toEqual({ state: 'blocked', reason: 'missing' });
      expect(lineOf(limited, id)).toBe(
        `${id[0]?.toUpperCase()}${id.slice(1)} is not available to this device on this daemon.`,
      );
    }
    expectNothingSentTo(limited, 'alpha', 'beta', 'gamma');
  });

  test('G1 delta’s route answers for the limited device', async () => {
    expect(standing(limited, 'delta')).toEqual({ state: 'allowed' });
    resetCounters();
    expect(await clientOf(limited, 'delta').call('GET /v1/delta')).toEqual({ plugin: 'delta', item: 'one' });
  });

  test('G1 the positive control: a FULL device on the SAME daemon sees all four fixture plugins', () => {
    expect(full.daemon).toBe(limited.daemon);
    for (const id of FIXTURE_IDS) expect(standing(full, id)).toEqual({ state: 'allowed' });
  });

  test.todo(
    "G4 a member reads its own table's contract hash (`GET /v1/shared/contract` does not exist on Catalogs yet, §9.6)",
  );
});
