/**
 * THE COMPOSITION ROOT, PROVED BY MOUNTING IT.
 *
 * `App.tsx` is the one module in this package that is nothing but wiring, which
 * is exactly why it needs executed tests rather than a reading: a slot pointed
 * at the wrong component, a provider that never reaches its consumer, or a
 * daemon taken from the selected pairing instead of the route are all invisible
 * to the typechecker and all silent in a build log.
 *
 * Three kinds of test live here, and the split is deliberate:
 *
 *   * MOUNTED SHELL tests drive `AppShell` through a real router and a real
 *     store over stubbed transports. Anything about routing, focus, live
 *     regions or keyboard handling is a document fact and is asserted against
 *     the document.
 *   * BROWSER SURFACE tests call the root's capability factories directly with
 *     the globals patched, because those factories are the only place in the
 *     package that reads `Notification`, `navigator.serviceWorker` and
 *     `isSecureContext` — and the whole point of the ports beneath them is that
 *     nothing else has to.
 *   * PURE HELPER tests cover the decisions the root makes on its own:
 *     the one-shot install latch, the text-entry guard and the route
 *     announcement.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import {
  type AttentionSnapshot,
  DoctorReportSchema,
  type FyEvent,
  HealthViewSchema,
  type ProjectInfo,
  type SessionStatus,
  SOCKET_TICKET_TTL_SECONDS,
  type WardenVerdictsView,
} from '@ferretry/protocol';
import type { FyApiClient } from '@ferretry/protocol/client';
import { StrictMode } from 'react';

import {
  App,
  AppShell,
  browserNotificationSurface,
  browserPushEnrolment,
  browserQrScan,
  installOnce,
  isTextEntryTarget,
  routeAnnouncement,
} from '../../src/App.tsx';
import { CARRIER_NO_FALLBACK } from '../../src/features/carrier/active-carrier-card.tsx';
import { PALETTE_PULL_THRESHOLD_PX, PULL_TO_PALETTE_ATTR } from '../../src/hooks/use-pull-to-palette.ts';
import type { DaemonConnectionRepository } from '../../src/lib/connections.ts';
import { type DaemonConnection, type DaemonId, daemonConnection, daemonId } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import type { PageRoute } from '../../src/lib/pages/routes.ts';
import type { PushRegistrationLike } from '../../src/lib/push-enrolment.ts';
import { RouterProvider } from '../../src/lib/router.tsx';
import { type AppStore, createAppStore, StoreProvider } from '../../src/lib/store.tsx';
import { resetSidePaneTabsStates } from '../../src/shell/side-pane-tab-model.ts';
import { interact, mount, must, pressKey } from '../support/dom.ts';
import { sessionView } from '../support/sessions.ts';

const alpha = daemonConnection({
  daemonId: 'alpha',
  baseUrl: 'https://alpha.example.test',
  deviceToken: 'alpha-token',
});
const beta = daemonConnection({
  daemonId: 'beta',
  baseUrl: 'https://beta.example.test',
  deviceToken: 'beta-token',
});
const GAMMA_ID = `fy_daemon_${'g'.repeat(43)}`;
const GAMMA_TOKEN = `fy_device_${'t'.repeat(43)}`;
const GAMMA_FRAGMENT = `v1;url=https%3A%2F%2Fgamma.example.test;code=7F3K-Q2ND;fp=${GAMMA_ID}`;

const HOSTED_RELAY = { kind: 'relay', relayUrl: 'https://relay.example.test', operator: 'hosted' } as const;

/**
 * The same published carrier set under two daemon identities.
 *
 * `alpha` is not a fingerprint this protocol can address, so `daemonCarriers`
 * strips its relay and the router never dials one; `gamma` is, so its relay is a
 * real fallback. Everything else about the two pairings is identical, which is
 * what makes them a pair of fixtures rather than two unrelated ones.
 */
const alphaRelayed = daemonConnection({
  daemonId: 'alpha',
  baseUrl: 'https://alpha.example.test',
  deviceToken: 'alpha-token',
  carriers: [{ kind: 'direct', daemonUrl: 'https://alpha.example.test' }, HOSTED_RELAY],
});
const gammaRelayed = daemonConnection({
  daemonId: GAMMA_ID,
  baseUrl: 'https://gamma.example.test',
  deviceToken: GAMMA_TOKEN,
  carriers: [{ kind: 'direct', daemonUrl: 'https://gamma.example.test' }, HOSTED_RELAY],
});

/**
 * One running shell on the `shared` session, and the ticket the daemon sells for its socket.
 *
 * The deck is driven through the ROOT'S OWN dependency object here rather than an injected fake, so
 * these are the daemon's real wire shapes: anything the protocol's schemas reject would surface as
 * an empty deck that never attaches, which is indistinguishable from the bug under test.
 */
const TERMINAL_ID = 'a1b2c3d4e5f6';
const TERMINAL_TICKET = `fy_ticket_${'a'.repeat(43)}`;
const terminalListing = {
  sessionId: 'shared',
  terminals: [
    {
      id: TERMINAL_ID,
      sessionId: 'shared',
      title: 'build',
      state: 'running',
      cols: 80,
      rows: 24,
      viewers: 0,
      createdAt: '2026-08-01T10:00:00.000Z',
      lastActivityAt: '2026-08-01T10:05:00.000Z',
      idleDeadline: '2026-08-01T11:05:00.000Z',
    },
  ],
  limits: { perSession: 6, global: 24, runningGlobal: 1, idleTimeoutSeconds: 900, scrollbackLines: 5_000 },
};

/** One frame off `/v1/events`, carrying only what the session route reads from it. */
const liveEvent = (sequence: number): FyEvent => ({
  sequence,
  time: '2026-08-01T10:00:00.000Z',
  sessionId: 'shared',
  type: 'assistant/message',
  source: 'daemon',
  data: {},
});

const doctorReport = {
  checks: [],
  harnesses: [{ kind: 'claude' as const, launchable: ['claude-auto-loge'], blocked: [] }],
  ready: true,
  limitation: 'PATH presence is all this report proves.',
};

const externalAttentionItem: AttentionSnapshot['items'][number] = {
  id: 'A3',
  source: 'agent-raised',
  sourceRef: null,
  sourceSeq: 1,
  subject: 'Approve the pairing request',
  why: 'The device needs a signed pairing record.',
  waitingSince: '2026-07-31T11:30:00.000Z',
  howToResolve: 'Approve to let this browser reach the daemon.',
  ask: { kind: 'permission' },
  raisedBy: 'agent',
  raisedBySession: 'shared',
  raisedByName: 'zoe',
};

const attentionSnapshot = (
  sessionId: string,
  items: AttentionSnapshot['items'] = [],
  updatedAt = '2026-07-31T12:00:00.000Z',
): AttentionSnapshot => ({
  v: 1,
  sessionId,
  items,
  resolved: [],
  count: items.length,
  parseErrors: 0,
  updatedAt,
});

class MemoryRepository implements DaemonConnectionRepository {
  readonly values = new Map<string, string>();

  async load(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async save(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

/**
 * Replaces one global for the duration of a test and answers its undo.
 *
 * The suite shares a single happy-dom document across every file in the
 * process, so a patched capability that outlived its test would change what a
 * later file's `AppShell` believes the browser can do.
 */
const patchGlobal = (host: object, name: string, value: unknown): (() => void) => {
  const original = Object.getOwnPropertyDescriptor(host, name);
  Object.defineProperty(host, name, { configurable: true, writable: true, value });
  return () => {
    if (original === undefined) delete (host as Record<string, unknown>)[name];
    else Object.defineProperty(host, name, original);
  };
};

const setPath = (path: string): void => window.history.replaceState({}, '', path);

/**
 * Global fetch is a tripwire for accidental ambient transport. The root must
 * consume the push service already bound to its store's injected fetcher, and
 * pairing must use that same injected fetcher; any URL recorded here is a
 * regression. It is also stubbed because a suite that can dial out is a suite
 * that can hang.
 */
let restoreFetch: (() => void) | undefined;
const requestedUrls: string[] = [];

beforeAll(() => {
  restoreFetch = patchGlobal(globalThis, 'fetch', async (input: unknown) => {
    requestedUrls.push(String(input instanceof Request ? input.url : input));
    return Response.json({});
  });
});

afterAll(() => restoreFetch?.());

afterEach(() => {
  setPath('/');
  localStorage.clear();
  requestedUrls.length = 0;
  // WHICH PANES ARE OPEN IS MODULE STATE, not this shell's. A test that opens the terminal pane
  // therefore leaves it open for every later mount of the same route — and a deck mounted by
  // accident lists, buys a ticket and dials a real socket at a host that does not exist, which
  // surfaces as an unhandled socket error in whichever unrelated test happens to be running.
  resetSidePaneTabsStates();
});

/* ---------- the mounted shell --------------------------------------------- */

interface ShellOptions {
  /** Sessions the stub daemon answers `list` with. */
  readonly sessions?: readonly string[];
  /** Makes `get` reject, which is the session route's failure path. */
  readonly sessionFailure?: string;
  /** Makes creating the daemon-bound client reject before any read starts. */
  readonly clientFailure?: string;
  /**
   * Holds `get` open. Without it the read resolves inside the mount's own act
   * flush and the loading state never exists to be observed — which is exactly
   * the state the live-region tests are about.
   */
  readonly sessionGate?: Promise<void>;
  /**
   * The status `list` answers with, read on EVERY call so a test can drive a
   * real status transition through two hydrations. The notification watch is
   * silent on first sight, so a transition is the only thing that delivers.
   */
  readonly sessionStatus?: () => SessionStatus;
  /** Daemon-owned normalized transcript tail returned by `logs`. */
  readonly transcript?: string | ((daemonId: DaemonId, sessionId: string) => string);
  /** Complete Attention board returned by this daemon/session route. */
  readonly attention?: (sessionId: string) => AttentionSnapshot;
  /** The recent Warden-report index, deliberately supplied by the paired daemon. */
  readonly wardenVerdicts?: () => Promise<WardenVerdictsView>;
  /** The durable project registry this daemon answers `/v1/projects` with. */
  readonly projects?: readonly ProjectInfo[];
}

interface HealthRead {
  readonly daemonId: DaemonId;
  readonly path: string;
  readonly schema: unknown;
  readonly timeout: number | undefined;
}

/**
 * One live `/v1/events` subscription the mounted session route actually opened.
 *
 * The fake stream cannot RESOLVE (see below), so the only way a test can say "an event reached this
 * browser" is to keep the daemon's half of the subscription: `emit` is the route's own callback, and
 * calling it is exactly what a delivered frame does.
 */
interface LiveFeed {
  readonly sessionId: string | undefined;
  readonly after: number;
  readonly emit: (event: FyEvent) => void;
}

const appStore = async (
  reads: string[],
  options: ShellOptions = {},
  transcriptReads: string[] = [],
  healthReads: HealthRead[] = [],
  liveFeeds: LiveFeed[] = [],
  carrierRequests: string[] = [],
): Promise<AppStore> =>
  await createAppStore({
    repository: new MemoryRepository(),
    connectClient: async connection => {
      if (options.clientFailure !== undefined) throw new Error(options.clientFailure);
      return {
        get: async (sessionId: string) => {
          reads.push(`${connection.daemonId}:${sessionId}`);
          await options.sessionGate;
          if (options.sessionFailure !== undefined) throw new Error(options.sessionFailure);
          return sessionView(sessionId, {
            config: {
              teammate: connection.daemonId === alpha.daemonId ? 'Alpha Agent' : 'Beta Agent',
              name: `${connection.daemonId} session`,
            },
          });
        },
        list: async () =>
          (options.sessions ?? []).map(id =>
            sessionView(id, { state: { status: options.sessionStatus?.() ?? 'running' } }),
          ),
        logs: async (sessionId: string) => {
          transcriptReads.push(`${connection.daemonId}:${sessionId}`);
          return typeof options.transcript === 'function'
            ? options.transcript(connection.daemonId, sessionId)
            : (options.transcript ?? '');
        },
        interrupt: async (sessionId: string) => sessionView(sessionId),
        start: async () => sessionView('started'),
        /*
         * The live event feed the session route subscribes to. It never resolves and never rejects:
         * a real one runs for the life of the workspace, and a fake that RESOLVED would tell the
         * route its feed had ended the moment it opened. Aborting is what stops it, as in production.
         */
        stream: async (
          sessionId: string | undefined,
          after: number,
          onEvent: (event: FyEvent) => void,
          signal?: AbortSignal,
        ) =>
          await new Promise<void>(resolve => {
            if (signal?.aborted === true) {
              resolve();
              return;
            }
            liveFeeds.push({ sessionId, after, emit: onEvent });
            signal?.addEventListener('abort', () => resolve(), { once: true });
          }),
        wardenStatus: async () => ({ config: {}, anomalies: [], fingerprint: 'alpha-fingerprint' }),
        wardenVerdicts: async () => (options.wardenVerdicts === undefined ? [] : await options.wardenVerdicts()),
        wardenReport: async (reportPath: string) => `# Evidence from ${reportPath}`,
        foreignHistory: async () => ({ conversations: [], skipped: [] }),
        foreignHistoryConversation: async () => ({
          conversation: {
            id: 'fixture-history',
            harness: 'claude',
            title: 'Fixture imported history',
            eventCount: 1,
            readOnly: true,
          },
          messages: [],
        }),
        request: async (path: string, schema: unknown, _init: RequestInit, timeout?: number) => {
          healthReads.push({ daemonId: connection.daemonId, path, schema, timeout });
          return path === '/v1/doctor' ? doctorReport : {};
        },
      } as unknown as FyApiClient;
    },
    // Only the pairing exchange and the terminal deck have shapes the root itself depends on; every
    // other page reads through a store port that answers an empty document.
    fetcher: async input => {
      const url = String(input);
      carrierRequests.push(url);
      // The board a live session reads. A test that wants to watch a refresh
      // land supplies its own answer per read; every other test gets the same
      // empty deck the shell has always been given here.
      const attentionRoute = new URL(url).pathname.match(/^\/v1\/sessions\/([^/]+)\/attention$/u);
      if (attentionRoute?.[1] !== undefined) {
        const sessionId = decodeURIComponent(attentionRoute[1]);
        return Response.json(options.attention?.(sessionId) ?? attentionSnapshot(sessionId));
      }
      if (url.endsWith('/v1/pair'))
        return Response.json({
          daemonId: GAMMA_ID,
          deviceToken: GAMMA_TOKEN,
          daemonName: 'gamma',
          capabilities: [],
          carriers: [{ kind: 'direct', url: 'https://gamma.example.test' }],
        });
      if (url.endsWith('/stream/ticket'))
        return Response.json({
          ticket: TERMINAL_TICKET,
          ttlSeconds: SOCKET_TICKET_TTL_SECONDS,
          expiresAt: '2026-08-01T10:00:30.000Z',
        });
      if (url.endsWith('/terminals')) return Response.json(terminalListing);
      // The durable registry, and ONLY when a test supplies one. The default
      // stays the empty document every other page gets, because the registry's
      // own failure path is what the projects-route test asserts on.
      if (options.projects !== undefined && new URL(url).pathname === '/v1/projects')
        return Response.json(options.projects);
      return Response.json({});
    },
  });

/**
 * A daemon id names one of the two default fixtures; a whole connection pairs
 * itself, which is how a test says something about the carrier set a pairing
 * published without inventing a third id nothing else knows.
 */
const renderShell = async (
  path: string,
  paired: readonly (DaemonId | DaemonConnection)[] = [],
  options: ShellOptions = {},
) => {
  const reads: string[] = [];
  const transcriptReads: string[] = [];
  const healthReads: HealthRead[] = [];
  const liveFeeds: LiveFeed[] = [];
  const carrierRequests: string[] = [];
  const store = await appStore(reads, options, transcriptReads, healthReads, liveFeeds, carrierRequests);
  for (const daemon of paired) {
    if (typeof daemon !== 'string') store.connections.add(daemon);
    else store.connections.add(daemon === alpha.daemonId ? alpha : beta);
  }
  setPath(path);
  const view = await mount(
    <RouterProvider>
      <StoreProvider store={store}>
        <AppShell />
      </StoreProvider>
    </RouterProvider>,
  );
  return { carrierRequests, healthReads, liveFeeds, reads, store, transcriptReads, view };
};

const settle = async (): Promise<void> => {
  await interact(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

/**
 * Settles a surface whose effects cross REAL task boundaries, not just microtasks.
 *
 * The terminal deck loads its emulator through a dynamic `import()` and only then attaches, so the
 * chain is module load → listing → ticket → socket, with a task between the links and a first module
 * load that is measurably slower than the rest. `settle` flushes two microtasks, which is right for
 * everything else here and is not enough for that.
 *
 * It stops on the CONDITION rather than after a fixed count, so a loaded machine waits longer instead
 * of failing; the ceiling is only there so a genuine regression fails in a second rather than hanging.
 */
const settleUntil = async (ready: () => boolean, turns = 60): Promise<void> => {
  for (let turn = 0; turn < turns && !ready(); turn += 1) {
    await interact(async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
    });
  }
};

/**
 * A socket that records its URL and does nothing else.
 *
 * The deck's direct attach ends in `new WebSocket(...)`; a real one here would dial a host that does
 * not exist and surface as an unhandled socket error in whichever test happened to be running when
 * it gave up. What this test is about is the URL — a ticket bought on the carrier's own fetcher, for
 * the daemon the route named — so recording it is the whole job.
 */
const recordingSocket = (opened: string[]): unknown =>
  class RecordingSocket {
    static readonly OPEN = 1;
    binaryType = 'blob';
    readyState = 0;

    constructor(url: string) {
      opened.push(url);
    }

    addEventListener(): void {}
    removeEventListener(): void {}
    send(): void {}
    close(): void {}
  };

/** Which screen of the setup guide is on the glass, if it is on the glass at all. */
const stepOfSetup = (container: HTMLElement): string | null | undefined =>
  container.querySelector('[data-onboarding="setup"]')?.getAttribute('data-onboarding-screen');

/** Answers WHO INSTALLS IT the way a reader does. */
const chooseDoer = async (container: HTMLElement, doer: string): Promise<void> => {
  await interact(() =>
    must(
      container.querySelector<HTMLButtonElement>(`button[data-onboarding-doer="${doer}"]`),
      `the ${doer} answer`,
    ).click(),
  );
};

/**
 * Answers the ENTRY question, and then the daemon subflow's own question.
 *
 * Every caller here is a reader who is about to type commands on the machine
 * holding the page, and this walks the whole way rather than making each test
 * remember which questions that combination is asked. A phone would be asked one
 * fewer, which is the model's business and is tested there.
 */
const chooseRoute = async (container: HTMLElement, route: string): Promise<void> => {
  await interact(() =>
    must(
      container.querySelector<HTMLButtonElement>(`button[data-onboarding-route="${route}"]`),
      `the ${route} answer`,
    ).click(),
  );
  if (stepOfSetup(container) === 'target') {
    await interact(() =>
      must(container.querySelector<HTMLButtonElement>('button[data-onboarding-target="this"]'), 'this machine').click(),
    );
  }
  if (stepOfSetup(container) === 'doer') await chooseDoer(container, 'self');
};

/** Moves on from a stage that has a Next, which is every stage the page cannot check. */
const advanceStep = async (container: HTMLElement): Promise<void> => {
  await interact(() =>
    must(container.querySelector<HTMLButtonElement>('[data-onboarding-next]'), 'the next control').click(),
  );
};

/** Answers the second chooser, which is what moves the reader off `connect`. */
const chooseConnection = async (container: HTMLElement, connection: string): Promise<void> => {
  await interact(() =>
    must(
      container.querySelector<HTMLButtonElement>(`button[data-onboarding-connection="${connection}"]`),
      `the ${connection} answer`,
    ).click(),
  );
};

/**
 * Walks the LONG route to the browser's half of pairing: the question, install,
 * daemon, the carrier choice, then `fy pair` on the computer. Deliberately not
 * the two-tap "I have a link" answer — these tests are about the pairing surface
 * behaving the same at the end of the full journey as it does in the picker.
 *
 * Two of these hops are not a `Next`. The carrier question is answered by
 * picking a carrier, and the stage that answer opens is what the reader has to
 * pass through before the scan surface exists; walking it here is what keeps
 * these tests on the REAL long route rather than on a shortcut into `scan`.
 */
const advanceToPairing = async (container: HTMLElement): Promise<void> => {
  await chooseRoute(container, 'add-client');
  /* pair → scan */
  await advanceStep(container);
};

/**
 * Walks the LONG route: first-time setup on a computer, all the way to the step
 * that pairs it. That step is `local` now, not `scan` — the daemon is on the
 * machine reading the page, so there is no QR and no code, and the browser's own
 * pairing surface is the fallback for a terminal that cannot open a window.
 */
const advanceToLocalPairing = async (container: HTMLElement): Promise<void> => {
  await chooseRoute(container, 'first-time');
  /*
   * install → agents → daemon → connect. The agents step is not decoration on the
   * way past: Ferretry runs Claude Code and Codex and is neither of them, so a
   * daemon standing up with both missing serves perfectly and runs nothing.
   */
  await advanceStep(container);
  await advanceStep(container);
  await advanceStep(container);
  /* connect → local, by answering rather than by advancing */
  await chooseConnection(container, 'default-relay');
};

/** Drives a browser history navigation the way the back button does. */
const popTo = async (path: string): Promise<void> => {
  window.history.pushState({}, '', path);
  await interact(() => window.dispatchEvent(new PopStateEvent('popstate')));
};

describe('AppShell', () => {
  it('asks an unpaired first run what it has, and then who installs it', async () => {
    const { reads, view } = await renderShell('/');

    // A cold visitor might be holding a link, might be starting from nothing, or
    // might be adding a machine to a fleet — and only they know which. What the
    // root must never ask is what this DEVICE is: it can see that.
    expect(view.container.querySelector('h1')?.textContent).toBe('Set up Ferretry');
    expect(stepOfSetup(view.container)).toBe('entry');
    expect(view.container.querySelectorAll('button[data-onboarding-route]')).toHaveLength(3);
    expect(view.container.querySelectorAll('button[data-onboarding-doer]')).toHaveLength(0);
    expect(view.container.querySelector('ul[aria-label="Paired daemons"]')).toBeNull();
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(reads).toEqual([]);

    // Answering "first time" asks the one question that changes every screen
    // after it, with the machine this device settles already stated.
    await chooseRoute(view.container, 'first-time');
    expect(stepOfSetup(view.container)).toBe('install');
    expect(view.container.querySelector('[data-onboarding-diagram]')?.getAttribute('aria-label')).toContain(
      'not yet linked',
    );
    await view.unmount();
  });

  it('never greets an unpaired browser with "you are set up", however stale storage reads', async () => {
    // Progress says the arc finished; the pairing registry — the authority on
    // that — holds nothing. A cleared registry, another profile, an abandoned
    // attempt: all of them make the stored claim unbelievable.
    localStorage.setItem(
      'fy-onboarding-v4',
      JSON.stringify({
        v: 4,
        stage: 'walk',
        route: 'first-time',
        target: 'this',
        doer: 'self',
        current: 'done',
        furthest: 'done',
      }),
    );

    const { view } = await renderShell('/');

    // Back to the first question, which is the honest reading of a claim no
    // other store supports.
    expect(stepOfSetup(view.container)).toBe('entry');
    expect(view.container.textContent).not.toContain('You are set up');
    await view.unmount();
  });

  it('opens a paired browser straight onto its fleet, asking nothing', async () => {
    const { view } = await renderShell('/', [alpha.daemonId]);

    // The daily open. No chooser, no guide, and no picker to dismiss either —
    // this browser answered every question it can be asked, months ago.
    expect(window.location.pathname).toBe('/d/alpha');
    expect(view.container.querySelector('[data-onboarding="setup"]')).toBeNull();

    // The picker is still REACHABLE, because it is the only screen that offers
    // "set up another machine". A permanent redirect off `/` would leave a
    // paired reader unable to add their second daemon at all.
    await popTo('/');
    expect(view.container.querySelector('h1')?.textContent).toBe('Your daemons');
    await interact(() =>
      must(view.container.querySelector<HTMLButtonElement>('[data-pairing-setup]'), 'the setup link').click(),
    );

    expect(window.location.pathname).toBe('/setup');
    expect(view.container.querySelector('[data-onboarding="setup"]')).not.toBeNull();
    await view.unmount();
  });

  it('mounts the daemon-scoped projects registry from its routed destination', async () => {
    const { view } = await renderShell('/d/alpha/projects', [alpha.daemonId]);
    await settle();

    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not read this daemon’s project registry',
    );
    await view.unmount();
  });

  it('mounts one registered project from its UUID-addressed route', async () => {
    // Arrange — the route carries the record id, not the folder path, so the
    // screen has to find the project in the daemon's own registry.
    const projectId = '11111111-1111-4111-8111-111111111111';

    // Act
    const { view } = await renderShell(`/d/alpha/projects/${projectId}`, [alpha.daemonId], {
      projects: [
        {
          id: projectId,
          name: 'ferretry',
          path: '/work/ferretry',
          source: 'existing-folder',
          createdAt: '2026-08-01T10:00:00.000Z',
        },
      ],
    });
    await settle();

    // Assert — the composition root reached the real page through its slot,
    // and the shell put the reader inside the projects trail rather than at its
    // root.
    const page = view.container.querySelector(`[data-project-detail="${projectId}"]`);
    expect(page).not.toBeNull();
    expect(page?.textContent).toContain('ferretry');
    expect(page?.textContent).toContain('/work/ferretry');
    const crumbs = [...view.container.querySelectorAll('nav a, nav span')].map(node => node.textContent ?? '');
    expect(crumbs).toContain('Projects');
    await view.unmount();
  });

  it('replays the whole thing when a paired browser adds another machine', async () => {
    // This browser finished setup — for a DIFFERENT host. Every new machine is a
    // first-time setup for that machine, so "set up another machine" must not
    // resume the last screen of a journey completed for a laptop.
    localStorage.setItem(
      'fy-onboarding-v4',
      JSON.stringify({
        v: 4,
        stage: 'walk',
        route: 'first-time',
        target: 'this',
        doer: 'self',
        current: 'done',
        furthest: 'done',
      }),
    );
    const { view } = await renderShell('/', [alpha.daemonId]);
    // Opening the app took them to their fleet; asking for the picker is what a
    // reader standing at a second machine does.
    await popTo('/');

    await interact(() =>
      must(view.container.querySelector<HTMLButtonElement>('[data-pairing-setup]'), 'the setup link').click(),
    );

    // Replayed from the very first question: a second machine may well be set up
    // by an agent even if the first one was not.
    expect(stepOfSetup(view.container)).toBe('entry');

    // And the instructions are the same ones, replayed rather than a second copy
    // of them: install, the daemon, the carrier choice, then pairing.
    await chooseRoute(view.container, 'first-time');
    expect(stepOfSetup(view.container)).toBe('install');
    expect(view.container.textContent).toContain('fy --version');
    await view.unmount();
  });

  it('lands a hand-off link on the install step, which is what makes the recursion real', async () => {
    // THE CENTRAL CLAIM OF THE DEVICE-AWARE FLOW, wired end to end. A phone that
    // cannot host a daemon sends this link to a computer; that computer walks the
    // SAME subflow answering "this one", which is why installation is taught in
    // exactly one place. The place travels in the fragment, and the root has to
    // read it before the store hydrates — a slot pointed at the wrong option here
    // would silently drop the reader back on the entry question with no sign that
    // anything was carried.
    const { view } = await renderShell('/setup#fy-setup=v2;route=first-time;target=this;doer=self;step=install');

    expect(stepOfSetup(view.container)).toBe('install');
    expect(view.container.textContent).toContain('fy --version');
    // Neither question is asked again: the link answered both, and this machine
    // can hold the answer it proposed.
    expect(view.container.querySelector('button[data-onboarding-target]')).toBeNull();
    expect(view.container.querySelector('button[data-onboarding-doer]')).toBeNull();
    await view.unmount();
  });

  it('refuses a hand-off payload rather than repairing one, through the root that reads it', async () => {
    // A step that is not a step is not a hand-off with a typo in it; it is
    // something else, and guessing which journey its author meant would land a
    // reader somewhere nobody chose. The entry question is always a correct answer.
    // Asserted here, at the root, because this is the one place the fragment is
    // read at all — the refusal that matters is the one the reader experiences.
    const { view } = await renderShell('/setup#fy-setup=v2;route=first-time;target=this;doer=self;step=nowhere');

    expect(stepOfSetup(view.container)).toBe('entry');
    await view.unmount();
  });

  it('keeps /setup reachable, and reload-durable, for a browser that is already paired', async () => {
    const { view } = await renderShell('/setup', [alpha.daemonId]);

    expect(view.container.querySelector('h1')?.textContent).toBe('Set up Ferretry');
    expect(must(view.container.querySelector('[data-route]'), 'the route announcer').textContent).toBe('Set up');
    await view.unmount();
  });

  it('takes a scanned pairing link through setup even when daemons already exist', async () => {
    const { store, view } = await renderShell(`/pair#${GAMMA_FRAGMENT}`, [alpha.daemonId]);

    // A camera app opening this link IS the setup journey, arriving on the stage
    // that redeems a code — not a picker with a banner on it. That stage is now
    // `scan`: `pair` became the terminal half, which somebody holding a link has
    // by definition already had run for them.
    expect(view.container.querySelector('[data-onboarding="setup"]')?.getAttribute('data-onboarding-screen')).toBe(
      'scan',
    );
    expect(window.location.hash).toBe('');

    await interact(() =>
      must(
        [...view.container.querySelectorAll('button')].find(button => button.textContent?.includes('Pair this device')),
        'the confirmation control',
      ).click(),
    );
    await settle();

    // Finishes in the guide, keeps the daemon this browser already had, and
    // leaves only when the reader says so.
    expect(view.container.querySelector('[data-onboarding="setup"]')?.getAttribute('data-onboarding-screen')).toBe(
      'done',
    );
    const snapshot = store.connections.getSnapshot();
    expect(snapshot.connections.map(one => String(one.daemonId))).toEqual([GAMMA_ID, 'alpha']);
    expect(String(snapshot.selectedDaemonId)).toBe(GAMMA_ID);
    expect(window.location.pathname).toBe('/pair');

    await interact(() =>
      must(view.container.querySelector<HTMLButtonElement>('[data-onboarding-open-fleet]'), 'the fleet action').click(),
    );
    expect(window.location.pathname).toBe(`/d/${GAMMA_ID}`);
    await view.unmount();
  });

  it('stops substituting setup once the reader has left it for their fleet', async () => {
    const { view } = await renderShell('/');
    await advanceToPairing(view.container);
    expect(stepOfSetup(view.container)).toBe('scan');

    // Pair it for real, finish, and leave for the fleet.
    const field = must(view.container.querySelector<HTMLInputElement>('#pairing-link'), 'the pairing link field');
    await interact(() => {
      const setter = must(
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set,
        'the input value setter',
      );
      setter.call(field, `https://pwa.example.test/#${GAMMA_FRAGMENT}`);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await interact(() =>
      must(field.closest('form'), 'the pairing form').dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      ),
    );
    await interact(() =>
      must(
        [...view.container.querySelectorAll('button')].find(button => button.textContent?.includes('Pair this device')),
        'the confirmation control',
      ).click(),
    );
    await settle();
    await interact(() =>
      must(view.container.querySelector<HTMLButtonElement>('[data-onboarding-open-fleet]'), 'the fleet action').click(),
    );
    await settle();
    expect(window.location.pathname).toBe(`/d/${GAMMA_ID}`);

    // Coming back to the root later is ordinary browsing, not a second first run.
    await popTo('/');
    expect(view.container.querySelector('[data-onboarding="setup"]')).toBeNull();
    expect(view.container.querySelector('h1')?.textContent).toBe('Your daemons');
    expect(view.container.querySelector('[data-pairing-setup]')).not.toBeNull();
    await view.unmount();
  });

  it('still opens an existing daemon immediately from the pairing stage of setup', async () => {
    const { view } = await renderShell('/setup', [alpha.daemonId]);
    await advanceToLocalPairing(view.container);

    // Choosing a daemon that already exists is not part of the setup journey,
    // so it behaves exactly as it does in the picker: it leaves at once.
    await interact(() =>
      must(
        view.container.querySelector<HTMLButtonElement>('ul[aria-label="Paired daemons"] button'),
        'the daemon row',
      ).click(),
    );

    expect(window.location.pathname).toBe('/d/alpha');
    await view.unmount();
  });

  it('forgets a daemon from the pairing stage without leaving setup', async () => {
    const { store, view } = await renderShell('/setup', [alpha.daemonId]);
    await advanceToLocalPairing(view.container);

    await interact(() =>
      must(view.container.querySelector<HTMLButtonElement>('[aria-label^="Forget"]'), 'the forget control').click(),
    );

    expect(store.connections.getSnapshot().connections).toEqual([]);
    expect(window.location.pathname).toBe('/setup');
    await view.unmount();
  });

  it('fails closed when a daemon-qualified route has no matching runtime pairing', async () => {
    const { reads, view } = await renderShell('/d/missing/session/shared', [alpha.daemonId, beta.daemonId]);

    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('not paired in this browser');
    // Two daemons ARE paired here — just not the one the route named — so the
    // picker leads with them rather than with a first-run screen.
    expect(view.container.querySelector('h1')?.textContent).toBe('Your daemons');
    expect(view.container.querySelector('[data-session="shared"]')).toBeNull();
    expect(reads).toEqual([]);
    await view.unmount();
  });

  it('uses the routed daemon instead of the selected daemon', async () => {
    // Adding beta last selects it, while the route explicitly asks for alpha.
    const { reads, view } = await renderShell('/d/alpha/session/shared', [alpha.daemonId, beta.daemonId]);
    await settle();

    const session = view.container.querySelector('[data-session="shared"]');
    expect(session?.getAttribute('data-daemon')).toBe('alpha');
    expect(session?.textContent).toContain('Alpha Agent');
    expect(session?.textContent).not.toContain('Beta Agent');
    expect(reads).toEqual(['alpha:shared']);
    await view.unmount();
  });

  /*
   * THE TWO MACHINE-READABLE FACTS A MOUNTED SESSION STATES ABOUT ITS OWN CARRIER AND FEED.
   *
   * `ActiveCarrierCard` says the carrier at length, and it lives in Settings — so a reader, or a
   * compiled-browser journey, looking at a session had nothing to read without navigating away.
   * Both attributes therefore sit on the session route's own root, and both start at their honest
   * "nothing has happened yet" value rather than at a guess: `none` is NOT `direct`, because no walk
   * has measured anything, and `0` is not "an event arrived".
   */
  it('states the measured carrier and the live-event cursor on the mounted session route', async () => {
    const { view } = await renderShell('/d/alpha/session/shared', [alpha.daemonId]);
    await settle();

    const session = view.container.querySelector('[data-session="shared"]');
    // The session's scoped Attention ledger is now hydrated with the same
    // carrier router. That first successful daemon read is a real direct
    // measurement, so the route need not wait for another unrelated action.
    expect(session?.getAttribute('data-carrier-kind')).toBe('direct');
    expect(session?.getAttribute('data-live-events')).toBe('0');
    await view.unmount();
  });

  /**
   * WHAT AN ARRIVING EVENT DOES, which is the half of the live feed that had never been executed.
   *
   * The subscription itself was already proved by the attribute above; the CALLBACK — the two lines
   * that move the cursor and pull the transcript forward — was reachable only from a daemon that
   * actually delivered, and no test had one. Both halves matter and they fail differently: a cursor
   * that never advances leaves a compiled-browser journey with nothing to poll, and a refresh that
   * never fires leaves the reader on the three-second poll this subscription exists to beat.
   *
   * The walk is driven for real rather than faked, because the effect refuses to subscribe until a
   * carrier has been MEASURED — so "no feed before a walk" is asserted first, and it is the same gate
   * the route's comment describes rather than a separate claim.
   */
  it('advances the live cursor and refreshes the session when the measured feed delivers an event', async () => {
    const { liveFeeds, reads, store, transcriptReads, view } = await renderShell('/d/alpha/session/shared', [
      alpha.daemonId,
    ]);
    await settle();
    // Attention hydration is the first carrier-routed daemon request, so the
    // route can start its feed without a synthetic health probe.
    expect(liveFeeds).toHaveLength(1);

    await interact(async () => {
      await store.carrier.send(alpha, `${alpha.baseUrl}/v1/health`);
    });
    await settle();

    const feed = must(liveFeeds[0], 'the live event subscription');
    expect(feed.sessionId).toBe('shared');
    // From the beginning of the journal: the route has no cursor of its own to resume from yet.
    expect(feed.after).toBe(0);
    const session = must(view.container.querySelector('[data-session="shared"]'), 'the mounted session route');
    expect(session.getAttribute('data-carrier-kind')).toBe('direct');
    const sessionReads = reads.length;
    const logReads = transcriptReads.length;

    await interact(() => feed.emit(liveEvent(9)));
    await settle();

    expect(session.getAttribute('data-live-events')).toBe('9');
    expect(reads.length).toBeGreaterThan(sessionReads);
    expect(transcriptReads.length).toBeGreaterThan(logReads);

    // MONOTONIC, and that is the property a poller depends on: a replayed or out-of-order frame must
    // never rewind a cursor another reader has already seen move past it.
    await interact(() => feed.emit(liveEvent(4)));
    await settle();

    expect(session.getAttribute('data-live-events')).toBe('9');
    await view.unmount();
  });

  /**
   * THE TERMINAL DECK'S THIRD DEPENDENCY: the carrier the deck's attach is allowed to read.
   *
   * `browserTerminalDeckDependencies` takes a measured-carrier getter and defaults it to
   * `() => undefined`, and this root passed only two arguments — so the production deck answered "no
   * carrier measured" forever. That is not a silent nicety: `browserTerminalStreamAttach` gates the
   * DIRECT branch on exactly that getter, so every direct session's terminals threw
   * `TERMINAL_STREAM_NO_CARRIER` and cycled the deck's reconnect backoff instead of buying a ticket
   * and opening a socket. Nothing in the type system notices a defaulted argument, and no deck test
   * can notice it either — the deck is always handed a fake — so the regression has to be the ROOT'S
   * own deck, driven through the real pane, on the real carrier router.
   *
   * The socket is the assertion because it is the far end of the whole chain: a ticket bought on the
   * carrier's fetcher, at the daemon the route named, for the terminal the daemon listed.
   */
  it('gives the production terminal deck the measured carrier its direct attach is gated on', async () => {
    const sockets: string[] = [];
    const restoreSocket = patchGlobal(globalThis, 'WebSocket', recordingSocket(sockets));
    const { carrierRequests, view } = await renderShell('/d/alpha/session/shared', [alpha.daemonId]);
    try {
      await settle();
      // The deck is not mounted yet, so nothing has asked the daemon about terminals at all.
      expect(carrierRequests.some(url => url.includes('/terminals'))).toBe(false);

      await interact(() =>
        must(
          [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(
            button => button.textContent === 'Terminal',
          ),
          'the Terminal pane launcher',
        ).click(),
      );
      await settleUntil(() => sockets.length > 0);

      expect(carrierRequests).toContain('https://alpha.example.test/v1/sessions/shared/terminals');
      expect(carrierRequests).toContain(
        `https://alpha.example.test/v1/sessions/shared/terminals/${TERMINAL_ID}/stream/ticket`,
      );
      expect(sockets).toEqual([
        `wss://alpha.example.test/v1/sessions/shared/terminals/${TERMINAL_ID}/stream?ticket=${TERMINAL_TICKET}`,
      ]);
    } finally {
      // Unmounted and restored even when an assertion above threw: a retained deck keeps its refresh
      // interval, and a leaked real `WebSocket` fails a later test rather than this one.
      await view.unmount();
      restoreSocket();
    }
  });

  it('applies the persisted chat measure to the real session surface', async () => {
    const { store, view } = await renderShell('/d/alpha/session/shared', [alpha.daemonId]);
    await settle();
    const surface = must(view.container.querySelector('[data-chat-width]'), 'the chat-width surface');
    expect(surface.getAttribute('data-chat-width')).toBe('full');

    await interact(() => store.controls.setDeviceControls({ chatWidth: 'readable' }));

    expect(view.container.querySelector('[data-chat-width]')).toBe(surface);
    expect(surface.getAttribute('data-chat-width')).toBe('readable');
    await view.unmount();
  });

  it('never crosses two daemons that own the same session id', async () => {
    const { reads, transcriptReads, view } = await renderShell(
      '/d/alpha/session/shared',
      [alpha.daemonId, beta.daemonId],
      { transcript: daemon => `assistant/message: ${daemon} transcript` },
    );
    await settle();
    expect(view.container.querySelector('[data-session="shared"]')?.textContent).toContain('Alpha Agent');
    expect(view.container.querySelector('[role="log"]')?.textContent).toContain('alpha transcript');

    await popTo('/d/beta/session/shared');
    await settle();

    const session = view.container.querySelector('[data-session="shared"]');
    expect(session?.getAttribute('data-daemon')).toBe('beta');
    expect(session?.textContent).toContain('Beta Agent');
    expect(session?.textContent).not.toContain('Alpha Agent');
    expect(view.container.querySelector('[role="log"]')?.textContent).toContain('beta transcript');
    expect(view.container.querySelector('[role="log"]')?.textContent).not.toContain('alpha transcript');
    expect(reads).toEqual(['alpha:shared', 'beta:shared']);
    expect(transcriptReads).toEqual(['alpha:shared', 'beta:shared']);
    await view.unmount();
  });

  it('revalidates a ready Attention board through the mounted workspace refresh', async () => {
    let items: AttentionSnapshot['items'] = [];
    let attentionReads = 0;
    let refresh: (() => void) | undefined;
    const restoreInterval = patchGlobal(globalThis, 'setInterval', (callback: () => void, milliseconds: number) => {
      if (milliseconds === 3_000 && refresh === undefined) refresh = callback;
      return 1;
    });
    const restoreClearInterval = patchGlobal(globalThis, 'clearInterval', () => {});

    try {
      const { store, view } = await renderShell('/d/alpha/session/shared', [alpha.daemonId], {
        transcript: 'assistant/message: Review !A3 before continuing.',
        attention: sessionId => {
          attentionReads += 1;
          return attentionSnapshot(sessionId, items);
        },
      });
      try {
        await settle();
        expect(refresh).toBeDefined();
        const scope = daemonSessionScope(alpha, 'shared');
        expect(store.attention.store.status(scope)).toBe('ready');
        expect(store.attention.store.count(scope)).toBe(0);
        expect(view.container.querySelector('button[aria-label="Attention"]')).not.toBeNull();
        expect(view.container.querySelector('[data-fy-reference="attention:A3"]')).toBeNull();

        const initialAttentionReads = attentionReads;
        items = [externalAttentionItem];
        await interact(() => refresh?.());
        await settle();
        expect(attentionReads).toBeGreaterThan(initialAttentionReads);
        expect(store.attention.store.count(scope)).toBe(1);

        const trigger = must(
          view.container.querySelector<HTMLButtonElement>('button[aria-label="Answer attention (1)"]'),
          'the refreshed Attention trigger',
        );
        expect(trigger.textContent).toContain('1');
        expect(view.container.querySelector('[data-fy-reference="attention:A3"]')?.textContent).toBe('!A3');
      } finally {
        await view.unmount();
      }
    } finally {
      restoreClearInterval();
      restoreInterval();
    }
  });

  it('publishes a lifecycle result and immediately refreshes its daemon-scoped evidence', async () => {
    const { reads, transcriptReads, view } = await renderShell('/d/alpha/session/shared', [alpha.daemonId]);
    try {
      await settle();
      const findInterrupt = () =>
        Array.from(view.container.querySelectorAll<HTMLButtonElement>('button')).find(button =>
          button.textContent?.includes('Interrupt turn'),
        );
      let interrupt = findInterrupt();

      // This transport test must not depend on the process-global viewport.
      // Compact truthfully keeps lifecycle actions in Session Details, so reach
      // the same production control through that presentation when necessary.
      if (interrupt === undefined) {
        const details = must(
          view.container.querySelector<HTMLButtonElement>('button[aria-label="Open session details"]'),
          'the session details control',
        );
        await interact(() => details.click());
        interrupt = findInterrupt();
      }

      await interact(() => must(interrupt, 'the interrupt control').click());
      await settle();

      expect(reads).toEqual(['alpha:shared', 'alpha:shared']);
      expect(transcriptReads).toEqual(['alpha:shared', 'alpha:shared']);
    } finally {
      await view.unmount();
    }
  });

  it('mounts every daemon-qualified destination through its own slot', async () => {
    const { view } = await renderShell('/d/alpha', [alpha.daemonId], { sessions: ['one'] });
    await settle();
    const announced = () => must(view.container.querySelector('[data-route]'), 'the route announcer').textContent;

    expect(announced()).toBe('Sessions');

    for (const [path, expected] of [
      ['/d/alpha/new', 'Sessions, New'],
      ['/d/alpha/settings', 'Sessions, Settings'],
      ['/d/alpha/warden', 'Sessions, Warden'],
      ['/d/alpha/analytics', 'Sessions, Analytics'],
      ['/d/alpha/learning', 'Sessions, Learning'],
      ['/d/alpha/history', 'Sessions, Imported history'],
      ['/d/alpha/session/one', 'Sessions, one'],
    ] as const) {
      await popTo(path);
      await settle();
      expect(announced()).toBe(expected);
      // Every destination has to put a real page under the app bar; an empty
      // frame is how a mis-wired slot would look.
      expect(must(view.container.querySelector('.kt-shell'), 'the shell').textContent).not.toBe('');
    }

    await view.unmount();
  });

  it('mounts both daemon pickers for a new session without probing account health', async () => {
    const { healthReads, view } = await renderShell('/d/alpha/new', [alpha.daemonId]);
    try {
      await settle();
      expect(view.container.querySelector('#fy-new-session-agent')?.getAttribute('role')).toBe('combobox');
      expect(view.container.querySelector('#fy-new-session-cwd')?.getAttribute('role')).toBe('combobox');
      expect(healthReads.map(read => read.path)).toContain('/v1/fleet/accounts');
      expect(healthReads.map(read => read.path)).not.toContain('/v1/fleet/health');
    } finally {
      await view.unmount();
    }
  });

  it('keeps Warden evidence daemon-bound, opens the complete report, and calls a failed refresh stale', async () => {
    let reads = 0;
    let poll: (() => void) | undefined;
    const restoreInterval = patchGlobal(globalThis, 'setInterval', (callback: () => void) => {
      poll = callback;
      return 1;
    });
    const restoreClearInterval = patchGlobal(globalThis, 'clearInterval', () => {});
    const verdicts = async (): Promise<WardenVerdictsView> => {
      reads += 1;
      if (reads > 1) throw new Error('report index is temporarily unavailable');
      return [
        {
          at: '2026-07-31T11:58:00.000Z',
          targetSession: 'session-a',
          verdict: 'needs_human',
          reportPath: '/state/warden/reports/session-a.md',
        },
      ];
    };

    try {
      const { view } = await renderShell('/d/alpha/warden', [alpha.daemonId], { wardenVerdicts: verdicts });
      await settle();

      const open = must(
        view.container.querySelector<HTMLButtonElement>('button[aria-label="Open Warden report for session-a"]'),
        'the Warden report row',
      );
      await interact(() => open.click());
      await settle();
      expect(view.container.textContent).toContain('Evidence from /state/warden/reports/session-a.md');

      await interact(() => poll?.());
      await settle();
      expect(view.container.textContent).toContain('The latest report check failed; showing the last verified index.');
      await view.unmount();
    } finally {
      restoreClearInterval();
      restoreInterval();
    }
  });

  it('calls an unreadable Warden index unavailable rather than presenting a healthy empty history', async () => {
    const { view } = await renderShell('/d/alpha/warden', [alpha.daemonId], {
      wardenVerdicts: async () => await Promise.reject(new Error('report index is unreadable')),
    });
    try {
      await settle();
      expect(view.container.textContent).toContain('Recent verdicts unavailable');
      expect(view.container.textContent).toContain('will not present an empty history as evidence');
    } finally {
      await view.unmount();
    }
  });
});

/* ---------- F5: route changes are announced and take focus ---------------- */

describe('route change accessibility', () => {
  it('leaves the load-time focus alone and still names the page it opened on', async () => {
    const { view } = await renderShell('/d/alpha', [alpha.daemonId]);
    await settle();

    const announcer = must(view.container.querySelector('[data-route]'), 'the route announcer');
    expect(announcer.getAttribute('role')).toBe('status');
    expect(announcer.getAttribute('aria-live')).toBe('polite');
    expect(announcer.textContent).toBe('Sessions');
    // A page LOAD is not a navigation: the browser has already placed focus.
    expect(document.activeElement).not.toBe(announcer);

    await view.unmount();
  });

  it('does not mistake StrictMode mount-effect replay for a navigation', async () => {
    const reads: string[] = [];
    const store = await appStore(reads);
    store.connections.add(alpha);
    setPath('/d/alpha');
    const view = await mount(
      <StrictMode>
        <RouterProvider>
          <StoreProvider store={store}>
            <AppShell />
          </StoreProvider>
        </RouterProvider>
      </StrictMode>,
    );
    await settle();

    const announcer = must(view.container.querySelector('[data-route]'), 'the route announcer');
    expect(document.activeElement).not.toBe(announcer);

    await popTo('/d/alpha/settings');
    await settle();
    expect(document.activeElement).toBe(announcer);
    await view.unmount();
  });

  it('moves focus to the announcer on an in-app navigation and renames it', async () => {
    const { view } = await renderShell('/d/alpha', [alpha.daemonId]);
    await settle();
    const announcer = must(view.container.querySelector('[data-route]'), 'the route announcer');

    await popTo('/d/alpha/settings');
    await settle();

    expect(document.activeElement).toBe(announcer);
    expect(announcer.textContent).toBe('Sessions, Settings');
    // The SAME node, renamed: a live region replaced wholesale announces nothing.
    expect(view.container.querySelector('[data-route]')).toBe(announcer);
    expect(announcer.getAttribute('tabindex')).toBe('-1');

    await view.unmount();
  });

  it('names every route it can reach, including the picker', () => {
    const id = daemonId('alpha');
    const announcements = (
      [
        { kind: 'connection-picker' },
        { kind: 'setup' },
        { kind: 'sessions', daemonId: id },
        { kind: 'new-session', daemonId: id },
        { kind: 'projects', daemonId: id },
        { kind: 'project-detail', daemonId: id, projectId: '11111111-1111-4111-8111-111111111111' },
        { kind: 'session', daemonId: id, sessionId: 'shared' },
        { kind: 'settings', daemonId: id },
        { kind: 'warden', daemonId: id },
        { kind: 'analytics', daemonId: id },
        { kind: 'learning', daemonId: id },
      ] satisfies readonly PageRoute[]
    ).map(routeAnnouncement);

    expect(announcements).toEqual([
      'Daemons',
      'Set up',
      'Sessions',
      'Sessions, New',
      'Sessions, Projects',
      'Sessions, Projects, Project',
      'Sessions, shared',
      'Sessions, Settings',
      'Sessions, Warden',
      'Sessions, Analytics',
      'Sessions, Learning',
    ]);
    // The daemon fingerprint is a credential-adjacent identifier, not a place.
    for (const announcement of announcements) expect(announcement).not.toContain('alpha');
  });
});

/* ---------- F6: the session live regions outlive their content ------------ */

describe('the session route live regions', () => {
  it('keeps one status region mounted and only changes its sentence', async () => {
    let open: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      open = resolve;
    });
    const { view } = await renderShell('/d/alpha/session/shared', [alpha.daemonId], { sessionGate: gate });
    const status = must(view.container.querySelector('[data-session-state]'), 'the session status region');
    const alert = must(view.container.querySelector('[data-session-error]'), 'the session alert region');

    expect(status.getAttribute('data-session-state')).toBe('opening');
    expect(status.getAttribute('role')).toBe('status');
    // The alert exists BEFORE there is anything to say; a region added together
    // with its text is a region no screen reader ever announces.
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toBe('');

    open();
    await settle();

    expect(view.container.querySelector('[data-session-state]')).toBe(status);
    expect(status.getAttribute('data-session-state')).toBe('connected');
    expect(status.textContent).toContain('This session is connected');
    expect(view.container.querySelector('[data-session-error]')).toBe(alert);
    expect(alert.textContent).toBe('');

    await view.unmount();
  });

  it('reports a failed open in the alert region without unmounting either one', async () => {
    const { view } = await renderShell('/d/alpha/session/shared', [alpha.daemonId], {
      sessionFailure: 'daemon refused the read',
    });
    const status = must(view.container.querySelector('[data-session-state]'), 'the session status region');
    const alert = must(view.container.querySelector('[data-session-error]'), 'the session alert region');

    await settle();

    expect(view.container.querySelector('[data-session-state]')).toBe(status);
    expect(status.getAttribute('data-session-state')).toBe('failed');
    expect(status.textContent).toBe('This session could not be opened.');
    expect(view.container.querySelector('[data-session-error]')).toBe(alert);
    expect(alert.textContent).toBe('Session workspace issue: Session: daemon refused the read');

    await view.unmount();
  });

  it('announces a client connection refusal through the same persistent alert', async () => {
    const { view } = await renderShell('/d/alpha/session/shared', [alpha.daemonId], {
      clientFailure: 'pairing expired',
    });
    const alert = must(view.container.querySelector('[data-session-error]'), 'the session alert region');

    await settle();

    expect(alert.textContent).toBe('Session workspace issue: pairing expired');
    expect(view.container.textContent).toContain('Session workspace issue: pairing expired');

    await view.unmount();
  });
});

/* ---------- F7: the palette shortcut yields to text entry ----------------- */

const paletteOpen = (container: HTMLElement): boolean =>
  container.querySelector('[role="dialog"], [data-command-palette]') !== null;

describe('the command palette shortcut', () => {
  it('reserves Cmd/Ctrl+K for current-session file and task search on a session route', async () => {
    const { view } = await renderShell('/d/alpha/session/s1', [alpha.daemonId]);
    await settle();
    const search = must(
      // By the control's stable marker, not by a literal id: the id is now
      // per-mount (`useId`) so the app bar and an open pane cannot collide.
      view.container.querySelector<HTMLInputElement>('[data-current-session-search] input'),
      'the current-session search input',
    );

    await interact(() => pressKey(document.body, 'k', { ctrlKey: true }));

    expect(document.activeElement).toBe(search);
    expect(paletteOpen(view.container)).toBe(false);
    await view.unmount();
  });

  it('reaches the search from inside the composer, which is where a session reader stands', async () => {
    const { view } = await renderShell('/d/alpha/session/s1', [alpha.daemonId]);
    await settle();
    const search = must(
      view.container.querySelector<HTMLInputElement>('[data-current-session-search] input'),
      'the current-session search input',
    );

    // The REAL COMPOSER textarea, not an unrelated element appended by the
    // test: session search deliberately claims this editable context and no
    // other one.
    const composer = must(
      view.container.querySelector<HTMLTextAreaElement>('form.fy-composer textarea'),
      'the session composer',
    );
    composer.focus();
    const event = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true });
    await interact(() => composer.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(search);
    expect(paletteOpen(view.container)).toBe(false);

    // And from inside the search itself it is the ordinary re-select, not a
    // keystroke the field swallows.
    const again = new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true });
    await interact(() => search.dispatchEvent(again));
    expect(again.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(search);

    // Escape closes the current-session palette and restores the exact opener,
    // even after Cmd+K was pressed a second time inside the search itself.
    const escapeKey = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await interact(() => search.dispatchEvent(escapeKey));
    expect(escapeKey.defaultPrevented).toBe(true);
    expect(search.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(composer);

    await view.unmount();
  });

  it('dismisses on an outside pointer without moving focus or clearing the shared query', async () => {
    const { view } = await renderShell('/d/alpha/session/s1', [alpha.daemonId]);
    await settle();
    const search = must(
      view.container.querySelector<HTMLInputElement>('[data-current-session-search] input'),
      'the current-session search input',
    );

    await interact(() => pressKey(document.body, 'k', { ctrlKey: true }));
    const setter = must(Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set, 'input setter');
    await interact(() => {
      setter.call(search, 'needle');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(search.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(search);

    // `pointerdown` alone on a non-focusable outside target does not blur the
    // field. This therefore exercises the document capture listener itself,
    // rather than letting the existing blur handler make the assertion pass.
    await interact(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true })));

    expect(search.getAttribute('aria-expanded')).toBe('false');
    expect(search.value).toBe('needle');
    expect(document.activeElement).toBe(search);
    await view.unmount();
  });

  it('leaves session-route shortcuts inside unrelated editors and modal contexts', async () => {
    const { view } = await renderShell('/d/alpha/session/s1', [alpha.daemonId]);
    await settle();
    const search = must(
      view.container.querySelector<HTMLInputElement>('[data-current-session-search] input'),
      'the current-session search input',
    );

    const rename = document.createElement('input');
    document.body.appendChild(rename);
    rename.focus();
    const editable = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true });
    await interact(() => rename.dispatchEvent(editable));
    expect(editable.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(rename);
    expect(search.getAttribute('aria-expanded')).toBe('false');

    // Native dialogs are modal contexts even without redundant role/aria
    // attributes, so the structural guard names the element too.
    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    const action = document.createElement('button');
    dialog.appendChild(action);
    document.body.appendChild(dialog);
    action.focus();
    const modal = new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true });
    await interact(() => action.dispatchEvent(modal));
    expect(modal.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(action);
    expect(search.getAttribute('aria-expanded')).toBe('false');

    rename.remove();
    dialog.remove();
    await view.unmount();
  });

  it('opens from a keystroke that belongs to no field', async () => {
    const { view } = await renderShell('/d/alpha', [alpha.daemonId]);
    await settle();
    expect(paletteOpen(view.container)).toBe(false);

    await interact(() => pressKey(document.body, 'k', { ctrlKey: true }));

    expect(paletteOpen(view.container)).toBe(true);
    await view.unmount();
  });

  it('accepts the platform modifier in either spelling and either case', async () => {
    const { view } = await renderShell('/d/alpha', [alpha.daemonId]);
    await settle();

    await interact(() => pressKey(document.body, 'K', { metaKey: true }));

    expect(paletteOpen(view.container)).toBe(true);
    await view.unmount();
  });

  it('leaves the keystroke to the field the reader is typing in', async () => {
    const { view } = await renderShell('/d/alpha', [alpha.daemonId]);
    await settle();

    for (const tag of ['input', 'textarea', 'select'] as const) {
      const field = document.createElement(tag);
      document.body.appendChild(field);
      const event = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true });
      await interact(() => field.dispatchEvent(event));
      // Not merely "did not open": the field must still RECEIVE the keystroke,
      // which a `preventDefault` in the capture phase would have taken away.
      expect(event.defaultPrevented).toBe(false);
      expect(paletteOpen(view.container)).toBe(false);
      field.remove();
    }

    const editable = document.createElement('div');
    Object.defineProperty(editable, 'isContentEditable', { configurable: true, value: true });
    document.body.appendChild(editable);
    await interact(() => pressKey(editable, 'k', { ctrlKey: true }));
    expect(paletteOpen(view.container)).toBe(false);
    editable.remove();

    await view.unmount();
  });

  it('ignores a bare key, the wrong modifiers, and a composing IME', async () => {
    const { view } = await renderShell('/d/alpha', [alpha.daemonId]);
    await settle();

    await interact(() => pressKey(document.body, 'k'));
    await interact(() => pressKey(document.body, 'j', { ctrlKey: true }));
    await interact(() => pressKey(document.body, 'k', { ctrlKey: true, shiftKey: true }));
    await interact(() => pressKey(document.body, 'k', { ctrlKey: true, altKey: true }));
    await interact(() => pressKey(document.body, 'k', { ctrlKey: true, keyCode: 229 }));
    await interact(() => pressKey(document.body, 'k', { ctrlKey: true, isComposing: true }));

    expect(paletteOpen(view.container)).toBe(false);
    await view.unmount();
  });

  it('stops listening once the shell unmounts', async () => {
    const { view } = await renderShell('/d/alpha', [alpha.daemonId]);
    await settle();

    // Dispatched at `window`, the exact target the shell listens on, so this
    // asserts the shell's own listener rather than whatever else in the tree
    // happens to be watching the document.
    const armed = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, cancelable: true });
    await interact(() => window.dispatchEvent(armed));
    expect(armed.defaultPrevented).toBe(true);

    await view.unmount();

    const afterwards = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, cancelable: true });
    window.dispatchEvent(afterwards);

    expect(afterwards.defaultPrevented).toBe(false);
  });
});

/* ---------- F38: the global destination and settings finder --------------- */

/** Types into the mounted palette the way the reader's keyboard does. */
const searchPalette = async (value: string): Promise<void> => {
  const field = must(document.getElementById('fy-palette-input') as HTMLInputElement | null, 'the palette input');
  await interact(() => {
    // React listens for `input`, and the value has to be set before it fires.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

/** Activates one palette row the way a pointer does; rows own pointerup, not click. */
const pressPaletteRow = async (id: string): Promise<void> => {
  const row = must(document.getElementById(`fy-palette-option-${id}`), `the ${id} palette row`);
  await interact(() => {
    for (const type of ['pointerdown', 'pointerup']) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { pointerId: 7 });
      row.dispatchEvent(event);
    }
  });
};

const paletteOption = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`#fy-palette-option-${id}`);

/** One touch event with the `touches` list the passive pull handler reads. */
const touchEvent = (type: string, clientY: number, count = 1): Event => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: Array.from({ length: count }, () => ({ clientY })) });
  return event;
};

const finderButton = (container: HTMLElement): HTMLButtonElement =>
  must(container.querySelector<HTMLButtonElement>('[data-app-bar-destination-search]'), 'the destination finder');

describe('the global destination and settings finder', () => {
  it('finds an individual setting by a keyword that is in neither its label nor its description', async () => {
    const { view } = await renderShell('/d/alpha', [alpha.daemonId]);
    await settle();
    await interact(() => pressKey(document.body, 'k', { ctrlKey: true }));

    // "push to talk" appears only in the catalog's keyword list — the row's own
    // prose spells it "Push-to-talk" — so a match here proves the palette is
    // asking the catalog rather than filtering label and description itself.
    await searchPalette('push to talk');

    const row = must(paletteOption('setting-dictation'), 'the dictation settings row');
    expect(row.textContent).toContain('Dictation');
    // The live binding rides along from the shell's own dictation settings, so
    // the row tells the reader which chord it currently is.
    expect(row.textContent).toContain('Push-to-talk shortcut: Alt (either side)');
    await view.unmount();
  });

  it('opens the unanchored Settings page for a row that anchors to no one control', async () => {
    const { view } = await renderShell('/d/alpha', [alpha.daemonId]);
    await settle();
    await interact(() => pressKey(document.body, 'k', { ctrlKey: true }));
    await searchPalette('preferences');

    await pressPaletteRow('open-settings');

    expect(window.location.pathname).toBe('/d/alpha/settings');
    expect(window.location.hash).toBe('');
    await view.unmount();
  });

  it('reaches an app destination through the same search', async () => {
    const { view } = await renderShell('/d/alpha', [alpha.daemonId]);
    await settle();
    await interact(() => pressKey(document.body, 'k', { ctrlKey: true }));
    await searchPalette('warden');

    await pressPaletteRow('destination-warden');

    expect(window.location.pathname).toBe('/d/alpha/warden');
    await view.unmount();
  });

  it('stops promising Cmd/Ctrl+K once a session owns it', async () => {
    const { view } = await renderShell('/d/alpha/session/s1', [alpha.daemonId]);
    await settle();

    // The keystroke belongs to current-session search here, so the bar must not
    // advertise it for the finder: an announced shortcut that does something
    // else is worse than no announcement at all.
    const finder = finderButton(view.container);
    expect(finder.getAttribute('aria-keyshortcuts')).toBeNull();
    expect(finder.textContent).not.toContain('K');

    // The finder itself still opens, and says who owns the keystroke instead.
    await interact(() => finder.click());
    expect(paletteOpen(view.container)).toBe(true);
    expect(document.getElementById('fy-palette')?.textContent).toContain('searches this session’s files & tasks');
    await view.unmount();
  });

  it('still advertises Cmd/Ctrl+K where nothing else claims it', async () => {
    const { view } = await renderShell('/d/alpha', [alpha.daemonId]);
    await settle();

    expect(finderButton(view.container).getAttribute('aria-keyshortcuts')).not.toBeNull();
    await view.unmount();
  });

  it('opens from a pull on a destination that carries no pull marker at all', async () => {
    // Settings names nothing about this gesture, which is the point: the region
    // finds the page's scroll port from the touch, so a destination added later
    // is reachable without being listed anywhere.
    const { view } = await renderShell('/d/alpha/settings', [alpha.daemonId]);
    await settle();
    const region = must(view.container.querySelector<HTMLElement>('[data-pull-to-palette-region]'), 'the pull region');
    const inside = must(region.querySelector<HTMLElement>('h1, h2, p, div'), 'something on the settings page');

    await interact(() => inside.dispatchEvent(touchEvent('touchstart', 100)));
    await interact(() => inside.dispatchEvent(touchEvent('touchmove', 100 + PALETTE_PULL_THRESHOLD_PX)));
    await interact(() => inside.dispatchEvent(touchEvent('touchend', 0, 0)));

    expect(paletteOpen(view.container)).toBe(true);
    await view.unmount();
  });

  it('never takes the pull that belongs to the transcript', async () => {
    const { view } = await renderShell('/d/alpha/session/s1', [alpha.daemonId]);
    await settle();
    const transcript = must(view.container.querySelector<HTMLElement>('.fy-transcript'), 'the transcript scroller');
    Object.defineProperty(transcript, 'scrollTop', { configurable: true, value: 0 });

    // The same movement loads older messages here. A finder that opened over it
    // would take a reader's history away from them.
    await interact(() => transcript.dispatchEvent(touchEvent('touchstart', 100)));
    await interact(() => transcript.dispatchEvent(touchEvent('touchmove', 100 + PALETTE_PULL_THRESHOLD_PX)));
    await interact(() => transcript.dispatchEvent(touchEvent('touchend', 0, 0)));

    expect(paletteOpen(view.container)).toBe(false);
    expect(view.container.querySelector('[data-pull-to-palette-indicator]')?.getAttribute('style')).toContain(
      'opacity: 0',
    );
    await view.unmount();
  });

  it('opens from a pull on an opted-in page scroller, and leaves an ordinary scroll alone', async () => {
    // The harness reports no fine pointer, so `useInputModality` resolves to the
    // conservative touch-affected state a phone gets.
    const { view } = await renderShell('/d/alpha', [alpha.daemonId], { sessions: ['s1'] });
    await settle();
    const scroller = must(
      view.container.querySelector<HTMLElement>(`[${PULL_TO_PALETTE_ATTR}]`),
      'the opted-in dashboard scroller',
    );

    // Already scrolled: the same gesture is the reader scrolling back up, and
    // must stay the browser's.
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 40 });
    await interact(() => scroller.dispatchEvent(touchEvent('touchstart', 100)));
    await interact(() => scroller.dispatchEvent(touchEvent('touchmove', 100 + PALETTE_PULL_THRESHOLD_PX)));
    await interact(() => scroller.dispatchEvent(touchEvent('touchend', 0, 0)));
    expect(paletteOpen(view.container)).toBe(false);

    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 0 });
    await interact(() => scroller.dispatchEvent(touchEvent('touchstart', 100)));
    await interact(() => scroller.dispatchEvent(touchEvent('touchmove', 140)));

    const indicator = must(
      view.container.querySelector<HTMLElement>('[data-pull-to-palette-indicator]'),
      'the pull indicator',
    );
    expect(indicator.dataset.pullToPaletteIndicator).toBe('pulling');
    expect(indicator.textContent).toContain('Pull to find');

    await interact(() => scroller.dispatchEvent(touchEvent('touchmove', 100 + PALETTE_PULL_THRESHOLD_PX)));
    expect(indicator.dataset.pullToPaletteIndicator).toBe('armed');
    expect(indicator.textContent).toContain('Release to find');

    await interact(() => scroller.dispatchEvent(touchEvent('touchend', 0, 0)));
    expect(paletteOpen(view.container)).toBe(true);
    await view.unmount();
  });
});

describe('isTextEntryTarget', () => {
  it('recognises the elements that own a keystroke, and nothing else', () => {
    const element = (tagName: string, contentEditable = false): EventTarget =>
      ({ tagName, isContentEditable: contentEditable }) as unknown as EventTarget;

    expect(isTextEntryTarget(element('INPUT'))).toBe(true);
    expect(isTextEntryTarget(element('textarea'))).toBe(true);
    expect(isTextEntryTarget(element('Select'))).toBe(true);
    expect(isTextEntryTarget(element('DIV', true))).toBe(true);
    expect(isTextEntryTarget(element('DIV'))).toBe(false);
    expect(isTextEntryTarget(element('BUTTON'))).toBe(false);
    // A target that is not an element at all — `window`, a `MessagePort`, or a
    // detached node from another realm — must not be mistaken for a field.
    expect(isTextEntryTarget({} as EventTarget)).toBe(false);
    expect(isTextEntryTarget(window as unknown as EventTarget)).toBe(false);
    expect(isTextEntryTarget(null)).toBe(false);
  });
});

/* ---------- F8: the one-shot install latch -------------------------------- */

describe('installOnce', () => {
  it('latches only after the install actually succeeded', () => {
    let installs = 0;
    const install = installOnce(() => {
      installs += 1;
    });

    expect(install()).toBe(true);
    expect(install()).toBe(false);
    expect(installs).toBe(1);
  });

  it('retries after a refusal instead of spending the tab’s only attempt', () => {
    let attempts = 0;
    const install = installOnce(() => {
      attempts += 1;
      // The first attempt refuses, the way a browser that has not yet granted
      // an orientation lock does.
      if (attempts === 1) throw new Error('refused');
    });

    // A refusal must not take the shell down, and must not latch.
    expect(install()).toBe(false);
    expect(install()).toBe(true);
    expect(install()).toBe(false);
    expect(attempts).toBe(2);
  });
});

/* ---------- the browser capability surfaces ------------------------------- */

class FakeNotification {
  static permission: NotificationPermission = 'default';
  static requested = 0;
  static readonly shown: string[] = [];

  onclick: ((event: unknown) => unknown) | null = null;
  closed = false;

  constructor(readonly title: string) {
    FakeNotification.shown.push(title);
  }

  static async requestPermission(): Promise<NotificationPermission> {
    FakeNotification.requested += 1;
    return 'granted';
  }

  close(): void {
    this.closed = true;
  }
}

describe('browserNotificationSurface', () => {
  const undo: (() => void)[] = [];
  afterEach(() => {
    while (undo.length > 0) undo.pop()?.();
    FakeNotification.permission = 'default';
    FakeNotification.requested = 0;
    FakeNotification.shown.length = 0;
  });

  it('answers “unsupported” and refuses to prompt where the API is absent', async () => {
    const surface = browserNotificationSurface(
      () => undefined,
      () => undefined,
    );

    expect(surface.permission()).toBe('unsupported');
    expect(await surface.requestPermission()).toBe('unsupported');
    // No constructor means no page-level fallback; `showNotification` reports
    // `unavailable` rather than pretending.
    expect(surface.showOnPage).toBeNull();
  });

  it('reads and requests the real permission, reporting the answer onward', async () => {
    undo.push(patchGlobal(globalThis, 'Notification', FakeNotification));
    FakeNotification.permission = 'default';
    const seen: string[] = [];
    const surface = browserNotificationSurface(
      () => undefined,
      permission => seen.push(permission),
    );

    expect(surface.permission()).toBe('default');
    expect(await surface.requestPermission()).toBe('granted');

    expect(FakeNotification.requested).toBe(1);
    // The shell's own permission state is what gates the fleet watch, so the
    // answer has to travel back out of the surface rather than being read again.
    expect(seen).toEqual(['granted']);
  });

  it('prefers the worker registration and degrades to none without a container', async () => {
    const registration = { getNotifications: async () => [], showNotification: async () => undefined };
    undo.push(patchGlobal(navigator, 'serviceWorker', { getRegistration: async () => registration }));
    const surface = browserNotificationSurface(
      () => undefined,
      () => undefined,
    );

    expect(await surface.registration()).toBe(registration);

    undo.push(patchGlobal(navigator, 'serviceWorker', { getRegistration: async () => undefined }));
    expect(await surface.registration()).toBeNull();
  });

  it('reports no registration at all in a browser without a service worker', async () => {
    const surface = browserNotificationSurface(
      () => undefined,
      () => undefined,
    );

    expect('serviceWorker' in navigator).toBe(false);
    expect(await surface.registration()).toBeNull();
  });

  it('builds the page-level fallback and routes its click through the app', () => {
    undo.push(patchGlobal(globalThis, 'Notification', FakeNotification));
    const navigated: string[] = [];
    const surface = browserNotificationSurface(
      path => navigated.push(path),
      () => undefined,
    );

    const showOnPage = must(surface.showOnPage, 'the page-level fallback');
    const notification = showOnPage('Alpha stopped', { body: 'body', tag: 'tag', renotify: false });

    expect(FakeNotification.shown).toEqual(['Alpha stopped']);
    surface.navigate('/d/alpha/session/one');
    expect(navigated).toEqual(['/d/alpha/session/one']);
    expect(notification).toBeDefined();
  });
});

describe('browserPushEnrolment', () => {
  const undo: (() => void)[] = [];
  afterEach(() => {
    while (undo.length > 0) undo.pop()?.();
  });

  const supportPush = (getRegistration: () => Promise<unknown>): void => {
    undo.push(patchGlobal(globalThis, 'isSecureContext', true));
    undo.push(patchGlobal(navigator, 'serviceWorker', { getRegistration }));
    undo.push(patchGlobal(window, 'PushManager', class {}));
  };

  it('declines where this browser cannot do Web Push at all', () => {
    // No secure context, no container, no PushManager: the ordinary state of
    // this suite's document, and of any plain-HTTP page.
    expect(browserPushEnrolment()).toBeNull();
  });

  it('declines in a secure context that still has no push manager', () => {
    undo.push(patchGlobal(globalThis, 'isSecureContext', true));
    undo.push(patchGlobal(navigator, 'serviceWorker', { getRegistration: async () => undefined }));

    expect(browserPushEnrolment()).toBeNull();
  });

  it('resolves the registration that can hold a subscription', async () => {
    const registration = {
      pushManager: { getSubscription: async () => null, subscribe: async () => ({}) },
    } as unknown as PushRegistrationLike;
    supportPush(async () => registration);

    const enrolment = must(browserPushEnrolment(), 'the push enrolment');

    expect(await enrolment.registration()).toBe(registration);
    // The name is what a reader revokes by, on the daemon's device list.
    expect(enrolment.deviceName()).toBe('Ferretry PWA');
  });

  it('refuses a build whose registration cannot carry a subscription', async () => {
    supportPush(async () => undefined);
    const missing = must(browserPushEnrolment(), 'the push enrolment');
    await expect(missing.registration()).rejects.toThrow('no active service worker registration');

    while (undo.length > 0) undo.pop()?.();
    supportPush(async () => ({}));
    const unusable = must(browserPushEnrolment(), 'the push enrolment');
    await expect(unusable.registration()).rejects.toThrow('no active service worker registration');
  });
});

/* ---------- the picker, the settings host, and the public root ------------ */

describe('the settings route composition', () => {
  /**
   * Opens the Carrier panel with a measured answer already on it.
   *
   * The fallback sentence exists only once something has been carried — before the
   * first request the panel honestly says nothing has — so the router is driven for
   * real rather than handed a fabricated choice.
   */
  const carrierPanelText = async (connection: DaemonConnection): Promise<string> => {
    const { store, view } = await renderShell(`/d/${String(connection.daemonId)}/settings#daemons`, [connection]);
    await settle();
    await interact(async () => {
      await store.carrier.send(connection, `${connection.baseUrl}/v1/health`);
    });
    await interact(() =>
      must(
        view.container.querySelector<HTMLButtonElement>('[aria-controls="daemon-settings-tab-carrier"]'),
        'the Carrier panel tab',
      ).click(),
    );
    const rendered = view.container.textContent ?? '';
    await view.unmount();
    return rendered;
  };

  /**
   * THE CARRIER PANEL PROMISES WHAT THE ROUTER WILL DIAL, not what the cache holds.
   *
   * A pairing whose fingerprint this protocol cannot address has its relays stripped
   * by `daemonCarriers` before a single attempt, so a screen reading the cached set
   * alone would tell that reader a rendezvous will catch them when nothing ever will
   * — and would withhold the one line saying the daemon has to be reachable from here.
   */
  it('names the missing fallback when the router would strip this pairing’s relay', async () => {
    expect(await carrierPanelText(alphaRelayed)).toContain(CARRIER_NO_FALLBACK);
  });

  it('stays silent about a fallback the router would actually dial', async () => {
    expect(await carrierPanelText(gammaRelayed)).not.toContain(CARRIER_NO_FALLBACK);
  });

  it('binds the Doctor tab to the selected daemon through the typed diagnostic endpoint', async () => {
    const { healthReads, view } = await renderShell('/d/alpha/settings#daemons', [alpha.daemonId]);
    await settle();

    await interact(() =>
      must(
        [...view.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(tab =>
          tab.textContent?.includes('Doctor'),
        ),
        'Doctor tab',
      ).click(),
    );
    await settle();

    const doctorRead = healthReads.find(read => read.path === '/v1/doctor');
    expect(doctorRead?.daemonId).toBe(alpha.daemonId);
    expect(doctorRead?.schema).toBe(DoctorReportSchema);
    expect(view.container.textContent).toContain('Required dependencies are present.');
    await view.unmount();
  });

  it('probes each selected sub-tab through the carrier-aware typed health endpoint, then routes switch and add', async () => {
    const { healthReads, store, view } = await renderShell('/d/alpha/settings#daemons', [
      alpha.daemonId,
      beta.daemonId,
    ]);
    await settle();

    // A daemon tab does not read another daemon merely by being visible. Opening
    // Host checks is the explicit request, and it travels through the same typed
    // client (and therefore carrier router) as every other daemon read.
    expect(healthReads).toEqual([]);
    await interact(() =>
      must(
        view.container.querySelector<HTMLButtonElement>('[aria-controls="daemon-settings-tab-host-checks"]'),
        'alpha host checks tab',
      ).click(),
    );
    await settle();
    expect(healthReads.map(read => String(read.daemonId))).toEqual(['alpha']);
    for (const read of healthReads) {
      expect(read.path).toBe('/v1/health');
      expect(read.schema).toBe(HealthViewSchema);
      expect(read.timeout).toBe(5_000);
    }
    expect(
      must(view.container.querySelector('[data-daemon-subtab="alpha"]'), 'alpha sub-tab').getAttribute('aria-selected'),
    ).toBe('true');

    await interact(() =>
      must(view.container.querySelector<HTMLButtonElement>('[data-daemon-subtab="beta"]'), 'beta tab').click(),
    );
    expect(store.connections.getSnapshot().selectedDaemonId).toBe(beta.daemonId);
    expect(window.location.pathname).toBe('/d/beta/settings');
    expect(window.location.hash).toBe('#daemons');
    await settle();
    await interact(() =>
      must(
        view.container.querySelector<HTMLButtonElement>('[aria-controls="daemon-settings-tab-host-checks"]'),
        'beta host checks tab',
      ).click(),
    );
    await settle();
    expect(healthReads.map(read => String(read.daemonId)).sort()).toEqual(['alpha', 'beta']);

    await interact(() =>
      must(view.container.querySelector<HTMLButtonElement>('[data-add-daemon]'), 'add daemon').click(),
    );
    expect(window.location.pathname).toBe('/');
    expect(view.container.querySelector('h1')?.textContent).toBe('Your daemons');
    expect(view.container.textContent).toContain('Pair another daemon');
    await view.unmount();
  });

  it('persists a routed daemon rename and sends active removal to the selected fallback settings', async () => {
    const { store, view } = await renderShell('/d/alpha/settings#daemons', [alpha.daemonId, beta.daemonId]);
    await settle();
    await interact(() =>
      must(
        view.container.querySelector<HTMLButtonElement>('[aria-controls="daemon-settings-tab-host-checks"]'),
        'alpha host checks tab',
      ).click(),
    );
    const alphaHostChecks = must(
      view.container.querySelector<HTMLElement>('[data-daemon-host-checks="alpha"]'),
      'alpha host checks',
    );
    const details = must(
      [...alphaHostChecks.querySelectorAll<HTMLDetailsElement>('details')].find(
        candidate => candidate.querySelector('summary')?.textContent === 'Manage daemon',
      ),
      'alpha management disclosure',
    );
    await interact(() => must(details.querySelector<HTMLElement>('summary'), 'manage daemon').click());

    const input = must(details.querySelector<HTMLInputElement>('input'), 'display name');
    const setter = must(Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set, 'input setter');
    await interact(() => {
      setter.call(input, 'Primary workstation');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await interact(() =>
      must(input.closest('form'), 'rename form').dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      ),
    );
    expect(store.connections.get(alpha.daemonId)?.label).toBe('Primary workstation');

    await interact(() =>
      must(view.container.querySelector<HTMLButtonElement>('[data-remove-daemon="alpha"]'), 'remove alpha').click(),
    );
    expect(store.connections.get(alpha.daemonId)).toBeUndefined();
    expect(window.location.pathname).toBe('/d/beta/settings');
    expect(window.location.hash).toBe('#daemons');
    await view.unmount();
  });
});

describe('the connection picker slot', () => {
  it('pairs a fresh daemon and opens the daemon it just paired', async () => {
    // A browser with a pairing already gets the picker, and pairing from the
    // picker still leaves immediately — that behaviour is unchanged by setup.
    const { store, view } = await renderShell('/', [alpha.daemonId]);
    // Opening the app went straight to the fleet; the picker is what a reader
    // asks for when they are adding a machine.
    await popTo('/');
    const field = must(view.container.querySelector<HTMLInputElement>('#pairing-link'), 'the pairing link field');
    const form = must(field.closest('form'), 'the pairing form');

    await interact(() => {
      const setter = must(
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set,
        'the input value setter',
      );
      setter.call(field, `https://pwa.example.test/#${GAMMA_FRAGMENT}`);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await interact(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    // A pasted link is confirmed against the daemon it names before anything is
    // exchanged, so the reader can check the host they are about to trust.
    const confirm = must(
      [...view.container.querySelectorAll('button')].find(button => button.textContent?.includes('Pair this device')),
      'the confirmation control',
    );
    await interact(() => confirm.click());
    await settle();

    // The root must land on the daemon the exchange returned, not on whichever
    // pairing happened to be selected before.
    expect(window.location.pathname).toBe(`/d/${GAMMA_ID}`);
    // The new pairing joins the existing one and becomes the selected daemon.
    expect(store.connections.getSnapshot().connections.map(one => String(one.daemonId))).toEqual([GAMMA_ID, 'alpha']);
    expect(requestedUrls.some(url => url.endsWith('/v1/pair'))).toBe(false);

    await view.unmount();
  });

  it('confirms a pre-filled arrival and empties the address bar of its one-time code', async () => {
    const { store, view } = await renderShell(`/pair#${GAMMA_FRAGMENT}`);

    // An unpaired browser opened from a QR is in the setup guide — but the
    // arrival puts it straight on the stage that redeems the code, with the
    // confirmation and the fragment hygiene of the standalone screen unchanged.
    expect(view.container.querySelector('[data-onboarding="setup"]')?.getAttribute('data-onboarding-screen')).toBe(
      'scan',
    );
    expect(view.container.textContent).toContain('Pair this device?');
    expect(view.container.textContent).toContain('gamma.example.test');
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/pair');
    // Embedded: the host page owns the only `<main>` and the only `<h1>`.
    expect(view.container.querySelectorAll('main')).toHaveLength(1);
    expect(view.container.querySelectorAll('h1')).toHaveLength(1);

    const confirm = must(
      [...view.container.querySelectorAll('button')].find(button => button.textContent?.includes('Pair this device')),
      'the confirmation control',
    );
    await interact(() => confirm.click());
    await settle();

    expect(store.connections.getSnapshot().connections.map(one => String(one.daemonId))).toEqual([GAMMA_ID]);
    // Setup finishes on its own last stage rather than teleporting the reader
    // out of the guide the moment the exchange lands.
    expect(view.container.querySelector('[data-onboarding="setup"]')?.getAttribute('data-onboarding-screen')).toBe(
      'done',
    );
    expect(window.location.pathname).toBe('/pair');

    await interact(() =>
      must(view.container.querySelector<HTMLButtonElement>('[data-onboarding-open-fleet]'), 'the fleet action').click(),
    );
    expect(window.location.pathname).toBe(`/d/${GAMMA_ID}`);
    await view.unmount();
  });

  it('offers the camera only when the browser has both halves of a scan', async () => {
    const win = window as unknown as { BarcodeDetector?: unknown };
    // This DOM has no `BarcodeDetector`, which is exactly what WebKit looks
    // like: no scan host at all, so the screen shows its paste field instead.
    expect(browserQrScan()).toBeNull();

    const formats: string[][] = [];
    win.BarcodeDetector = class {
      constructor(options: { formats: string[] }) {
        formats.push(options.formats);
      }
      async detect(): Promise<readonly { readonly rawValue: string }[]> {
        return [{ rawValue: 'https://pwa.example.test/pair#v1;url=x;code=y;fp=z' }];
      }
    };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [] }) },
    });
    try {
      const host = must(browserQrScan(), 'the browser scan host');
      expect(host.supported).toBe(true);
      await expect(host.scan({ show: () => 'source', clear: () => {} }, new AbortController().signal)).resolves.toBe(
        'https://pwa.example.test/pair#v1;url=x;code=y;fp=z',
      );
      expect(formats).toEqual([['qr_code']]);
    } finally {
      win.BarcodeDetector = undefined;
      delete (navigator as { mediaDevices?: unknown }).mediaDevices;
    }
    expect(browserQrScan()).toBeNull();
  });

  it('selects and forgets a pairing without leaving the picker', async () => {
    const { store, view } = await renderShell('/', [alpha.daemonId, beta.daemonId]);
    await popTo('/');
    await settle();

    const open = must(
      [...view.container.querySelectorAll('button')].find(button => button.textContent?.includes('alpha')),
      'the alpha pairing control',
    );
    await interact(() => open.click());

    expect(window.location.pathname).toBe('/d/alpha');
    expect(store.connections.getSnapshot().selectedDaemonId).toBe(alpha.daemonId);

    await popTo('/');
    await settle();
    const before = store.connections.getSnapshot().connections.length;
    const remove = must(
      [...view.container.querySelectorAll('button')].find(button =>
        /remove|forget|unpair/i.test(button.textContent ?? ''),
      ),
      'the remove control',
    );
    await interact(() => remove.click());

    expect(store.connections.getSnapshot().connections.length).toBe(before - 1);
    await view.unmount();
  });
});

describe('the fleet notification watch', () => {
  const undo: (() => void)[] = [];
  afterEach(() => {
    while (undo.length > 0) undo.pop()?.();
    FakeNotification.permission = 'default';
    FakeNotification.shown.length = 0;
  });

  /**
   * Mounts the shell with delivery possible and the fleet's status baseline
   * already taken, and answers the handle that moves that status.
   *
   * `hidden` is the whole point of the two tests below: the watch takes it from
   * `document.hidden`, and the default preference is to stay quiet while the
   * reader can see the page, so the same transition must deliver hidden and stay
   * silent visible.
   */
  const watchingShell = async (hidden: boolean) => {
    FakeNotification.permission = 'granted';
    undo.push(patchGlobal(globalThis, 'Notification', FakeNotification));
    undo.push(patchGlobal(document, 'hidden', hidden));

    let status: SessionStatus = 'running';
    const { store, view } = await renderShell('/d/alpha', [alpha.daemonId], {
      sessions: ['one'],
      sessionStatus: () => status,
    });
    await settle();
    store.notificationPreferences.set(alpha.daemonId, { enabled: true });

    const moveTo = async (next: SessionStatus): Promise<void> => {
      status = next;
      await interact(async () => {
        await store.fleet.hydrate(alpha);
      });
      await settle();
    };
    // First sight is deliberately silent, so the baseline is taken here rather
    // than in the tests, which are about the transition off it.
    await moveTo('running');
    return { moveTo, store, view };
  };

  it('delivers a hidden reader’s session transition through the document’s own Notification', async () => {
    const { moveTo, store, view } = await watchingShell(true);

    // Granted permission is what mounts the watch, and the shell reads it from
    // the real API rather than assuming; a baseline hydration is not news.
    expect(FakeNotification.shown).toEqual([]);
    // The watch is wired to THIS store's fleet: a refresh has to reach it
    // through the subscription the shell handed over.
    expect(store.fleet.getSnapshot().daemons.get(alpha.daemonId)?.sessions?.length).toBe(1);

    await moveTo('awaiting_question');

    // Delivered, and named after the session rather than the daemon: this is the
    // only assertion in the file that proves the whole chain — fleet diff, the
    // preference read, the surface, and the page-level constructor.
    expect(FakeNotification.shown).toEqual(['Session one']);

    await view.unmount();
  });

  it('stays silent on the same transition while the reader is looking at the page', async () => {
    const { moveTo, view } = await watchingShell(false);

    await moveTo('awaiting_question');

    // Nothing about the transition changed — only `document.hidden`. So a
    // notification here would mean the watch is reading some other visibility,
    // or none at all.
    expect(FakeNotification.shown).toEqual([]);

    await view.unmount();
  });
});

describe('App', () => {
  it('mounts the public root with its own router and store', async () => {
    setPath('/');
    const view = await mount(<App />);
    await settle();

    expect(view.container.querySelector('h1')?.textContent).toBe('Set up Ferretry');
    // What a reader HEARS names the screen they are actually on.
    expect(must(view.container.querySelector('[data-route]'), 'the route announcer').textContent).toBe('Set up');
    await view.unmount();
  });
});
