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
  CONVERSATION_IMPORT_PATH,
  DAEMON_CAPABILITIES,
  DoctorReportSchema,
  type FyEvent,
  type FyEventStreamIdle,
  HealthViewSchema,
  type ProjectInfo,
  type SessionLiveActivity,
  type SessionStatus,
  type SessionView,
  TUNNEL_OFF_SENTENCE,
  type TunnelStatusView,
  type WardenAttentionView,
  type WardenStatusView,
} from '@ferretry/protocol';
import type { FyApiClient } from '@ferretry/protocol/client';
// `chooseConnection` is aliased so the relay's carrier choice reads as what it is here: a
// measurement a live session makes, not a question onboarding asks (it asks none).
import { type ConnectionChoice, carrierProbe, chooseConnection as chooseCarrier } from '@ferretry/relay';
import { type ReactElement, StrictMode } from 'react';

import {
  App,
  AppShell,
  browserNotificationSurface,
  browserPushEnrolment,
  browserQrScan,
  installOnce,
  isTextEntryTarget,
  pairedPushMachines,
  pushMachineLabel,
  routeAnnouncement,
  sessionsBarPlace,
  updateOffer,
} from '../../src/App.tsx';
import { SESSION_EVENT_STREAM_QUIET_MS } from '../../src/components/session-event-stream-model.ts';
import { NUDGE_SETTLE_MS } from '../../src/components/session-workspace-model.ts';
import { CARRIER_NO_FALLBACK } from '../../src/features/carrier/active-carrier-card.tsx';
import { PALETTE_PULL_THRESHOLD_PX, PULL_TO_PALETTE_ATTR } from '../../src/hooks/use-pull-to-palette.ts';
import { themePreferences } from '../../src/hooks/use-theme.ts';
import { CARRIER_PREFERENCE_KEY, CarrierPreferenceStore } from '../../src/lib/carrier-preference.ts';
import type { DaemonConnectionRepository } from '../../src/lib/connections.ts';
import { type DaemonConnection, type DaemonId, daemonConnection, daemonId } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { NOTIFICATION_OPEN_MESSAGE } from '../../src/lib/notification-open.ts';
import { notificationBrand } from '../../src/lib/notify.ts';
import { daemonSessionPath, type PageRoute } from '../../src/lib/pages/routes.ts';
import { type DaemonCarrierRouter, DEVICE_NOT_ACCEPTED_SENTENCE } from '../../src/lib/relay-carrier.ts';
import { RouterProvider } from '../../src/lib/router.tsx';
import { SCROLL_MEMORY_KEY, type ScrollMemoryStorage } from '../../src/lib/scroll-memory.ts';
import { SessionCache, type SessionCacheBackend } from '../../src/lib/session-cache.ts';
import { type AppStore, createAppStore, StoreProvider } from '../../src/lib/store.tsx';
import { openWorkspaceTab, workspaceTab } from '../../src/lib/workspace-layout.ts';
import { UPDATE_CHIP } from '../../src/shell/app-bar.tsx';
import { resetSidePaneTabsStates } from '../../src/shell/side-pane-tab-model.ts';
import { MemoryDeviceKeyStore } from '../support/device-keys.ts';
import { interact, type Mounted, mount, must, pressKey } from '../support/dom.ts';
import { fetcherDaemons, newDaemonIdentity, relayCrypto, testDevice } from '../support/relay.ts';
import { sessionView } from '../support/sessions.ts';
import { settleUntil } from '../support/settle.ts';
import { attentionItem, wardenAttention, wardenInvestigation, wardenStatus } from '../support/warden.ts';

/** A connection-health clock whose timers never fire: a suite drives recovery by sending requests. */
const idleConnectionHealth = {
  now: () => Date.now(),
  schedule: () => () => undefined,
  random: () => 0,
  isOnline: () => true,
};

/*
 * REAL FINGERPRINTS, because every daemon request rides a session now and a session is checked
 * against the fingerprint before anything is sent. `ALPHA` and `BETA` are those fingerprints, used
 * wherever a route or an assertion names the daemon.
 */
const ALPHA_IDENTITY = await newDaemonIdentity();
const BETA_IDENTITY = await newDaemonIdentity();
const GAMMA_IDENTITY = await newDaemonIdentity();
const ALPHA = ALPHA_IDENTITY.daemonId;
const autoCarrierPreferences = (): CarrierPreferenceStore => {
  const stored = new Map<string, string>();
  stored.set(
    CARRIER_PREFERENCE_KEY,
    JSON.stringify(Object.fromEntries([ALPHA, BETA, GAMMA_ID, alphaRelayed.daemonId].map(id => [id, 'auto']))),
  );
  return new CarrierPreferenceStore({
    getItem: key => stored.get(key) ?? null,
    setItem: (key, value) => void stored.set(key, value),
  });
};
const BETA = BETA_IDENTITY.daemonId;
const DEVICE_KEY = (await testDevice()).privateKey;
const alpha = daemonConnection({
  daemonId: ALPHA,
  baseUrl: 'https://alpha.example.test',
  deviceId: 'fy_device_id_alphaDevice00000000001',
});
const beta = daemonConnection({
  daemonId: BETA,
  baseUrl: 'https://beta.example.test',
  deviceId: 'fy_device_id_betaDevice000000000001',
});
const GAMMA_ID = GAMMA_IDENTITY.daemonId;
const GAMMA_TOKEN = 'fy_device_id_gammaDevice00000000001';
const GAMMA_FRAGMENT = `v1;url=https%3A%2F%2Fgamma.example.test;code=7F3K-Q2ND;fp=${GAMMA_ID}`;

const HOSTED_RELAY = { kind: 'relay', relayUrl: 'https://relay.example.test', operator: 'hosted' } as const;

/**
 * The same published carrier set under two daemon identities.
 *
 * `alphaRelayed` is not a fingerprint this protocol can address, so `daemonCarriers`
 * strips its relay and the router never dials one; `gamma` is, so its relay is a
 * real fallback. Everything else about the two pairings is identical, which is
 * what makes them a pair of fixtures rather than two unrelated ones.
 */
const alphaRelayed = daemonConnection({
  daemonId: 'alpha-unaddressable',
  baseUrl: 'https://alpha.example.test',
  deviceId: 'alpha-token',
  carriers: [{ kind: 'direct', daemonUrl: 'https://alpha.example.test' }, HOSTED_RELAY],
});
const gammaRelayed = daemonConnection({
  daemonId: GAMMA_ID,
  baseUrl: 'https://gamma.example.test',
  deviceId: GAMMA_TOKEN,
  carriers: [{ kind: 'direct', daemonUrl: 'https://gamma.example.test' }, HOSTED_RELAY],
});

/**
 * One running shell on the `shared` session.
 *
 * The deck is driven through the ROOT'S OWN dependency object here rather than an injected fake, so
 * these are the daemon's real wire shapes: anything the protocol's schemas reject would surface as
 * an empty deck that never attaches, which is indistinguishable from the bug under test.
 */
const TERMINAL_ID = 'a1b2c3d4e5f6';
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

/**
 * The two reads every session route's search provider makes, answered in the
 * shape the daemon actually sends.
 *
 * `{}` used to be enough because these tests only assert focus and expansion —
 * which is precisely the problem: an unparseable answer settles the provider on
 * `unavailable`, and a shortcut test passes either way. The regression would be
 * a silent state change nothing here could see. `/fs/index` is matched FIRST
 * because it does not end with `/fs`, and a bare `/tasks` is distinguished from
 * a `?q=` narrowing because `pathname` excludes the query string — a ladder that
 * ignores `q` answers every search with the whole board and makes a no-match
 * test pass for the wrong reason.
 */
const sessionSearchFixture = (url: URL): Response | null => {
  const sessionId = decodeURIComponent(url.pathname.split('/v1/sessions/')[1]?.split('/')[0] ?? '');
  if (sessionId === '') return null;
  if (url.pathname.endsWith('/fs/index'))
    return Response.json({ v: 1, sessionId, root: `/work/${sessionId}`, files: [], coverage: 'complete', skipped: [] });
  if (url.pathname.endsWith('/tasks'))
    return Response.json({ v: 1, sessionId, tasks: [], parseErrors: 0, updatedAt: '2026-08-06T00:00:00.000Z' });
  return null;
};

/**
 * THE WIDTH THIS SHELL IS ASSERTED AT, said out loud rather than inherited.
 *
 * `useLayoutMode` reads `window.innerWidth`, which is one process-wide happy-dom window shared by
 * every file in the tier — so a file that mounts a phone and does not hand the viewport back decides
 * what the NEXT file's shell looks like. This suite asserts a desktop app bar (the destination row
 * exists only above 768px), and it was failing on CI and nowhere else purely because CI walks the
 * tree in a different order and reached this file while a sidebar suite's 390px was still installed.
 *
 * A suite that depends on a global states it. 1440px is the width the other shell suites pin, and it
 * is handed back afterwards so this file cannot do to another what was done to it.
 */
const DESKTOP_WIDTH = 1_440;
let restoreInnerWidth: (() => void) | undefined;

beforeAll(() => {
  restoreInnerWidth = patchGlobal(window, 'innerWidth', DESKTOP_WIDTH);
  restoreFetch = patchGlobal(globalThis, 'fetch', async (input: unknown) => {
    const raw = String(input instanceof Request ? input.url : input);
    requestedUrls.push(raw);
    return sessionSearchFixture(new URL(raw, 'https://fixture.example.test')) ?? Response.json({});
  });
});

afterAll(() => {
  restoreFetch?.();
  restoreInnerWidth?.();
});

/**
 * Every shell this file has mounted and not yet torn down.
 *
 * Each test unmounts its own view on its last line, which is the right thing to read and is not a
 * guarantee: an assertion that throws first skips that line, and the abandoned root stays mounted in
 * the live document with its effects, intervals and subscriptions running, for whatever runs next.
 *
 * This is hygiene, not a repair of a known failure — and the distinction is worth writing down,
 * because the obvious story here is wrong. The three CI failures this file used to produce LOOKED
 * like exactly that cascade and were not: the terminal-deck test already unmounts in a `finally`, so
 * it never leaked a mount at all, and forcing a genuine leak from the first finder test leaves the
 * second one passing. They were two leaked browser globals, fixed at their leakers. So do not read
 * this net as the thing that keeps those green.
 *
 * A test's own `unmount` deregisters, so the teardown below only ever fires for a test that already
 * failed, and it keeps that failure local to the test that caused it.
 */
const liveMounts = new Set<Mounted>();

const mountShell = async (element: ReactElement): Promise<Mounted> => {
  const view = await mount(element);
  liveMounts.add(view);
  return {
    ...view,
    unmount: async () => {
      liveMounts.delete(view);
      await view.unmount();
    },
  };
};

afterEach(async () => {
  // Before the module state below is reset, because unmounting runs the effect cleanups that read it.
  // Newest first: a shell mounted later can only be over the top of an earlier one.
  for (const view of [...liveMounts].reverse()) {
    liveMounts.delete(view);
    await view.unmount();
  }
  setPath('/');
  localStorage.clear();
  requestedUrls.length = 0;
  // WHICH PANES ARE OPEN IS MODULE STATE, not this shell's. A test that opens the terminal pane
  // therefore leaves it open for every later mount of the same route — and a deck mounted by
  // accident lists and opens a stream session no test is watching, which
  // surfaces as an unhandled socket error in whichever unrelated test happens to be running.
  resetSidePaneTabsStates();
});

/* ---------- the mounted shell --------------------------------------------- */

interface ShellOptions {
  /** Fleet reads by path, answered as given; any other path answers an empty document. */
  readonly fleet?: Readonly<Record<string, unknown>>;
  /** Where the stub daemon says each session's journal stands, on `get`. Absent: an older daemon. */
  readonly journalSequence?: number;
  /** Sessions the stub daemon answers `list` with. */
  readonly sessions?: readonly string[];
  /** Open Attention the stub daemon's `list` reports on every listed session. */
  readonly listedAttention?: { open: number; first: string; ask: string; latestAt: string };
  /** The kind the Sessions bar was left on: 'all' unless a test says otherwise, null for a device that never chose. */
  readonly sessionsMode?: 'all' | 'auto' | 'interactive' | null;
  /** Makes `get` reject, which is the session route's failure path. */
  readonly sessionFailure?: string;
  /** Makes creating the daemon-bound client reject before any read starts. */
  readonly clientFailure?: string;
  /**
   * When this answers true, every carrier probe fails, so the next walk reaches `ok: false`.
   *
   * A PREDICATE RATHER THAN A FLAG, because the interesting case is a daemon that WAS reachable and
   * then stopped being: the router's `ok: false` branch is only entered by a later walk, and a fixed
   * option could only ever make a session unreachable from the start.
   */
  readonly carrierDown?: () => boolean;
  /**
   * Lets a test publish the measured carrier the SURFACES read — see {@link MeasuredCarrierSeam} for
   * what it substitutes and, more importantly, for why the real router cannot express it.
   */
  readonly carrierSeam?: MeasuredCarrierSeam;
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
  /** Overrides on the opened session's state, e.g. a working turn and when it began. */
  readonly sessionState?: Partial<SessionView['state']>;
  /** Daemon-owned normalized transcript tail returned by `logs`. */
  readonly transcript?: string | ((daemonId: DaemonId, sessionId: string) => string);
  /** Complete Attention board returned by this daemon/session route. */
  readonly attention?: (sessionId: string) => AttentionSnapshot;
  /**
   * What this daemon answers `/v1/tunnel` with: told `undefined` on a read and the requested switch on a
   * change. Absent, the path answers an empty document and no machine says anything about its tunnel.
   */
  readonly tunnelSwitch?: (change: boolean | undefined) => TunnelStatusView;
  /** Replaces the store's WebRTC round-trip read, which is the only thing a suite without a dialer lacks. */
  readonly webrtcRttMs?: (daemonId: DaemonId) => Promise<number | undefined>;
  /** Attention actions a daemon was sent (POSTs to a session's board), as `sessionId:body`. */
  readonly attentionPosts?: string[];
  /** Each session's conversation as the messages route serves it, in one page; absent: an empty one. */
  readonly messages?: (sessionId: string) => readonly { readonly role: 'user' | 'assistant'; readonly text: string }[];
  /** The Warden status this daemon answers; the default is a quiet, freshly swept one. */
  readonly wardenStatus?: () => Promise<WardenStatusView>;
  /** The "who needs you" feed this daemon answers; the default is a clean sweep. */
  readonly wardenAttention?: () => Promise<WardenAttentionView>;
  /** The durable project registry this daemon answers `/v1/projects` with. */
  readonly projects?: readonly ProjectInfo[];
  /** The runtimes `GET /v1/fleet/runtimes` answers with. */
  readonly accounts?: readonly unknown[];
  /** Which sessions each daemon (by host) says are instructed to learn, on `GET /v1/learning/sessions`. */
  readonly learners?: Readonly<Record<string, readonly string[]>>;
  /** Where the session cache keeps its copy; the default keeps it in memory only, so no suite shares one. */
  readonly sessionCacheBackend?: SessionCacheBackend;
  /** Where scroll positions are remembered; the default remembers none. */
  readonly scrollMemoryStorage?: ScrollMemoryStorage;
  /** Holds every `logs` read open until it resolves, so a cached transcript can be seen before the live one. */
  readonly transcriptGate?: () => Promise<void>;
  /** Send-ledger rows the ledger read answers with; without it the ledger read fails, as before. */
  readonly sends?: readonly unknown[];
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
  /**
   * THE TYPED CLIENT THIS SUBSCRIPTION WAS OPENED ON, by identity.
   *
   * The route's owner identity is `(client, measured carrier, session)`, and a client REPLACED under
   * a session that stays open — the daemon republishing its carrier set is the ordinary way it
   * happens — is the one third of it no count and no cursor can see. A replacement feed opened on the
   * PREVIOUS client is a subscription on a client the route has let go of, and it looks exactly like a
   * correct one from the outside. So the fake keeps the object it was called on.
   */
  readonly client: FyApiClient;
  readonly emit: (event: FyEvent) => void;
  /** The daemon's quiet-but-alive proof, so a late one can be delivered to an abandoned feed. */
  readonly idle: (frame: FyEventStreamIdle) => void;
  /** Whether the route asked for the working turn's live readout (`?live=1` on the wire). */
  readonly asksForLive: boolean;
  /** One live sample, the daemon's half of the same subscription. */
  readonly live: (sample: SessionLiveActivity) => void;
  /**
   * Ends this subscription the way a daemon going away does.
   *
   * The fake cannot resolve on its own — see below — but a test that never CAN resolve it could not
   * reach the half of the route that matters most: what the reader is shown once the feed has
   * stopped. This is the daemon's half of that, held by the test rather than by a timer.
   */
  readonly end: () => void;
  /**
   * TEARDOWN, OBSERVED RATHER THAN INFERRED.
   *
   * `liveFeeds.length` only ever counts OPENS, so "no replacement appeared" was being read as "the
   * old subscription is gone" — and those are different claims. Delete the route's `stream.stop()`
   * and the length assertion still passes while a live socket keeps running behind a page that has
   * moved on. The signal is the only thing that can tell them apart, so the fake surfaces it.
   */
  readonly aborted: () => boolean;
  /** Whether this subscription's promise has actually settled, which is what a real teardown does. */
  readonly settled: () => boolean;
}

/** The session network the most recent `appStore` built, so a case can read what a daemon was sent. */
let daemonNetwork: ReturnType<typeof fetcherDaemons> | undefined;

const appStore = async (
  reads: string[],
  options: ShellOptions = {},
  transcriptReads: string[] = [],
  healthReads: HealthRead[] = [],
  liveFeeds: LiveFeed[] = [],
  carrierRequests: string[] = [],
  clients: FyApiClient[] = [],
): Promise<AppStore> => {
  const deviceKeys = new MemoryDeviceKeyStore();
  for (const id of [ALPHA, BETA, GAMMA_ID, alphaRelayed.daemonId]) await deviceKeys.save(id, DEVICE_KEY);
  // The one fixture every daemon route below is answered by — over a real session on each daemon's
  // own address, and over the plain network for everything that is not a daemon.
  const daemonFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    carrierRequests.push(url);
    // Every carrier this daemon publishes fails at transport, which is what a walk needs to see
    // before it can answer `ok: false` rather than picking a winner.
    if (options.carrierDown?.() === true) throw new Error('the daemon is unreachable');
    // The board a live session reads. A test that wants to watch a refresh
    // land supplies its own answer per read; every other test gets the same
    // empty deck the shell has always been given here.
    const attentionRoute = new URL(url).pathname.match(/^\/v1\/sessions\/([^/]+)\/attention$/u);
    if (attentionRoute?.[1] !== undefined) {
      const sessionId = decodeURIComponent(attentionRoute[1]);
      if (init?.method === 'POST') options.attentionPosts?.push(`${sessionId}:${String(init.body)}`);
      return Response.json(options.attention?.(sessionId) ?? attentionSnapshot(sessionId));
    }
    // The Processes tab's list, which the open session reads for the count on its tab: nothing runs.
    const processesRoute = new URL(url).pathname.match(/^\/v1\/sessions\/([^/]+)\/processes$/u);
    if (processesRoute?.[1] !== undefined) {
      return Response.json({
        sessionId: decodeURIComponent(processesRoute[1]),
        observedAt: new Date().toISOString(),
        available: true,
        processes: [],
      });
    }
    if (url.endsWith('/terminals')) return Response.json(terminalListing);
    if (options.tunnelSwitch !== undefined && new URL(url).pathname === '/v1/tunnel') {
      const change = init?.method === 'PUT' ? (JSON.parse(String(init.body)) as { enabled: boolean }) : undefined;
      return Response.json(options.tunnelSwitch(change?.enabled));
    }
    // The durable registry, and ONLY when a test supplies one. The default
    // stays the empty document every other page gets, because the registry's
    // own failure path is what the projects-route test asserts on.
    if (options.projects !== undefined && new URL(url).pathname === '/v1/projects')
      return Response.json(options.projects);
    if (options.learners !== undefined && new URL(url).pathname === '/v1/learning/sessions')
      return Response.json(
        (options.learners[new URL(url).host] ?? []).map(sessionId => ({
          sessionId,
          passive: true,
          since: '2026-10-20T00:00:00.000Z',
          setBy: 'owner',
        })),
      );
    // Tasks search and its file index travel the carrier now, so they are answered here too.
    return sessionSearchFixture(new URL(url)) ?? Response.json({});
  };
  const network = fetcherDaemons(
    [
      { host: 'alpha.example.test', identity: ALPHA_IDENTITY },
      { host: 'beta.example.test', identity: BETA_IDENTITY },
      {
        host: 'gamma.example.test',
        identity: GAMMA_IDENTITY,
        paired: {
          daemonId: GAMMA_ID,
          deviceId: GAMMA_TOKEN,
          daemonName: 'gamma',
          capabilities: [],
          carriers: [{ kind: 'direct', url: 'https://gamma.example.test' }],
          idleExpiryDays: 30,
        },
      },
    ],
    daemonFetch,
    () => options.carrierDown?.() !== true,
  );
  daemonNetwork = network;
  return await createAppStore({
    repository: new MemoryRepository(),
    // In memory, never this browser's storage: a preference one case picks must not narrow the next one's walk.
    // Every machine is on Auto here, because these cases prove the walk (direct first); Relay is the default elsewhere.
    carrierPreferences: autoCarrierPreferences(),
    sessionCacheBackend: options.sessionCacheBackend ?? null,
    scrollMemoryStorage: options.scrollMemoryStorage ?? null,
    // The reconnect loop never arms a real timer here: a suite drives recovery by sending requests.
    connectionHealthEnvironment: idleConnectionHealth,
    connectionSignals: { listen: () => () => undefined },
    connectClient: async connection => {
      if (options.clientFailure !== undefined) throw new Error(options.clientFailure);
      const client = {
        get: async (sessionId: string) => {
          reads.push(`${connection.daemonId}:${sessionId}`);
          await options.sessionGate;
          if (options.sessionFailure !== undefined) throw new Error(options.sessionFailure);
          return sessionView(sessionId, {
            config: {
              teammate: connection.daemonId === alpha.daemonId ? 'Alpha Agent' : 'Beta Agent',
              name: `${connection.daemonId} session`,
            },
            ...(options.sessionState === undefined ? {} : { state: options.sessionState }),
            ...(options.journalSequence === undefined ? {} : { journalSequence: options.journalSequence }),
          });
        },
        list: async () =>
          (options.sessions ?? []).map(id =>
            sessionView(id, {
              state: {
                status: options.sessionStatus?.() ?? 'running',
                ...(options.listedAttention === undefined ? {} : { attention: options.listedAttention }),
              },
            }),
          ),
        logs: async (sessionId: string) => {
          transcriptReads.push(`${connection.daemonId}:${sessionId}`);
          await options.transcriptGate?.();
          return typeof options.transcript === 'function'
            ? options.transcript(connection.daemonId, sessionId)
            : (options.transcript ?? '');
        },
        // A conversation's durable rows, in one page — what the Attention page's "Last messages" fold reads.
        messages: async (sessionId: string) => ({
          v: 1 as const,
          sessionId,
          messages: (options.messages?.(sessionId) ?? []).map((message, index) => ({
            point: { v: 1 as const, byteOffset: index * 100, blockIndex: 0 },
            role: message.role,
            text: message.text,
            selectionBinding: `binding-${index}`,
          })),
          nextCursor: null,
        }),
        interrupt: async (sessionId: string) => sessionView(sessionId),
        start: async () => sessionView('started'),
        // The configuration stream the shell keeps open for the machine on screen: like the live feed
        // below, it runs until it is cancelled, and a cancelled one ends.
        configChanges: async (_onFrame: unknown, signal?: AbortSignal) =>
          await new Promise<void>(resolve => {
            if (signal?.aborted === true) resolve();
            else signal?.addEventListener('abort', () => resolve(), { once: true });
          }),
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
          onIdle?: (frame: FyEventStreamIdle) => void,
          onLive?: (sample: SessionLiveActivity) => void,
        ) => {
          let settled = false;
          const finish = (resolve: () => void) => () => {
            settled = true;
            resolve();
          };
          return await new Promise<void>(resolve => {
            // RECORDED BEFORE THE ABORT CHECK, so a subscription opened against an already-cancelled
            // signal is still visible to the test. It is one of the shapes a replacement race takes,
            // and a fake that dropped it on the floor would report the race as "nothing happened".
            liveFeeds.push({
              sessionId,
              after,
              client,
              emit: onEvent,
              idle: frame => onIdle?.(frame),
              asksForLive: onLive !== undefined,
              live: sample => onLive?.(sample),
              end: finish(resolve),
              aborted: () => signal?.aborted === true,
              settled: () => settled,
            });
            if (signal?.aborted === true) {
              finish(resolve)();
              return;
            }
            signal?.addEventListener('abort', finish(resolve), { once: true });
          });
        },
        wardenStatus: async () =>
          options.wardenStatus === undefined
            ? wardenStatus({ fingerprint: 'alpha-fingerprint' })
            : await options.wardenStatus(),
        wardenVerdicts: async () => [],
        wardenAttention: async () =>
          options.wardenAttention === undefined ? wardenAttention() : await options.wardenAttention(),
        wardenRun: async () => ({ sweptAt: '2026-07-31T12:00:00.000Z', anomalies: [] }),
        wardenInvestigate: async ({ sessionId }: { readonly sessionId: string }) => ({
          sessionId,
          state: 'queued' as const,
          message: 'Queued for an investigation.',
        }),
        wardenReport: async (reportPath: string) => `# Evidence from ${reportPath} on ${connection.daemonId}`,
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
          // The ledger is read here and parsed by the app (`readLedgerSends`), never by the strictly
          // validating `sends`; without `options.sends` it fails, as a client with no ledger did.
          if (/^\/v1\/sessions\/[^/]+\/sends$/u.test(path)) {
            if (options.sends === undefined) throw new Error('no send ledger in this fixture');
            return { sends: options.sends };
          }
          if (path === '/v1/fleet/runtimes' && options.accounts !== undefined)
            return { format: 'version-2', runtimes: options.accounts };
          if (options.fleet?.[path] !== undefined) return options.fleet[path];
          // Settings › Machine › Conversations reads machine.yaml; an empty file is a valid answer.
          if (path.startsWith('/v1/config/file?')) return { text: '', etag: 'fixture' };
          return path === '/v1/doctor' ? doctorReport : {};
        },
      } as unknown as FyApiClient;
      // Every client this pool ever built, in order, so a test can say WHICH one a subscription is
      // on rather than only how many there are.
      clients.push(client);
      return client;
    },
    deviceKeys,
    relayCrypto,
    // Every fixture daemon on its own address; `carrierDown` refuses every socket, which is a carrier
    // that is down rather than a daemon that answered.
    relayDial: network.dial,
    fetcher: daemonFetch,
  });
};

/**
 * A REPLACEMENT MEASURED CARRIER, PUBLISHED TO THE SURFACES AND TO NOTHING ELSE.
 *
 * WHY A SEAM AT ALL, said plainly: today's `DaemonCarrierRouter` cannot replace a winner in one
 * step. `#decide` refuses to overwrite an `ok: true` choice, a republish KEEPS the same choice
 * object, and the only way a new winner is ever published is by way of `undefined` — the transition
 * the restoration regression below already drives. So a carrier object replaced DIRECTLY by another
 * of the same kind is unreachable through that one call site, and the route's owner identity is
 * exactly the thing that must not depend on that being true: keyed on the KIND, relay A becoming
 * relay B would leave a live subscription on a carrier the router has already replaced, silently and
 * for the life of the session. "Not reachable today" is a fact about the router; this is a test about
 * the route.
 *
 * WHAT IT SUBSTITUTES IS ONE READ. `choice()` — the single fact `useActiveCarrier` subscribes to —
 * and the notification that it changed. The walk, the fetch, the sessions, the disclosure and the
 * daemon-bound transport underneath are all the real router, and the store's own internals captured
 * that router before this wrapper existed, so a published replacement is visible to the surfaces
 * without redirecting one byte of traffic. Every other member is forwarded BOUND TO THE ROUTER, not
 * to this proxy: the router reads its own private state, which a call whose receiver is a proxy
 * cannot see.
 */
interface MeasuredCarrierSeam {
  /** Publishes a replacement winner and wakes every surface subscribed to the router. */
  readonly publish: (choice: ConnectionChoice) => void;
  readonly wrap: (router: DaemonCarrierRouter) => DaemonCarrierRouter;
}

const measuredCarrierSeam = (): MeasuredCarrierSeam => {
  let published: ConnectionChoice | undefined;
  const listeners = new Set<() => void>();
  return {
    publish: (choice: ConnectionChoice) => {
      published = choice;
      for (const listener of [...listeners]) listener();
    },
    wrap: (router: DaemonCarrierRouter) =>
      new Proxy(router, {
        get(target, property) {
          if (property === 'choice')
            return (id: DaemonId): ConnectionChoice | undefined => published ?? target.choice(id);
          if (property === 'subscribe')
            return (listener: () => void): (() => void) => {
              listeners.add(listener);
              const unsubscribe = target.subscribe(listener);
              return () => {
                listeners.delete(listener);
                unsubscribe();
              };
            };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? (value as (...args: never[]) => unknown).bind(target) : value;
        },
      }),
  };
};

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
  const clients: FyApiClient[] = [];
  const built = await appStore(reads, options, transcriptReads, healthReads, liveFeeds, carrierRequests, clients);
  // ONLY WHEN A TEST ASKS FOR IT. Forwarding every member of the router through a proxy would bind
  // away exactly the receiver mistake `DaemonCarrierRouter`'s constructor comment exists for, so
  // every other test in this file keeps the raw router.
  const store: AppStore =
    options.carrierSeam === undefined && options.webrtcRttMs === undefined
      ? built
      : {
          ...built,
          ...(options.carrierSeam === undefined ? {} : { carrier: options.carrierSeam.wrap(built.carrier) }),
          ...(options.webrtcRttMs === undefined ? {} : { webrtcRttMs: options.webrtcRttMs }),
        };
  if (options.sessionsMode !== null) store.controls.setDeviceControls({ sessionsMode: options.sessionsMode ?? 'all' });
  // Paired one millisecond apart, in the order listed: the all-machines list shows them in pairing order.
  const pairedFrom = Date.now();
  for (const [index, daemon] of paired.entries()) {
    const options = { pairedAt: pairedFrom + index };
    if (typeof daemon !== 'string') store.connections.add(daemon, options);
    else store.connections.add(daemon === alpha.daemonId ? alpha : beta, options);
  }
  setPath(path);
  const view = await mountShell(
    <RouterProvider>
      <StoreProvider store={store}>
        <AppShell />
      </StoreProvider>
    </RouterProvider>,
  );
  return { carrierRequests, clients, healthReads, liveFeeds, reads, store, transcriptReads, view };
};

/**
 * Lets the shell's work land: the microtasks a render schedules, and the task-queue turns real
 * WebCrypto resolves on — every daemon request now opens over a session, and a handshake is several
 * of those turns, where a fetch fixture used to answer in one microtask.
 */
const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 12; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

/**
 * A paired machine that answers with a whole setup. Settings opens a machine's Machine tab for the old
 * `#daemons` anchor, and that tab draws the machine's tools, so the fixture's empty `{}` would not do.
 */
const SET_UP_SHELL: ShellOptions = {
  fleet: {
    '/v1/fleet/machine': {
      name: 'alpha',
      format: 'version-2',
      setUp: true,
      agentPermissions: 'auto',
      defaultRuntime: 'claude-default',
      agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false },
      tools: [{ harness: 'claude', label: 'Claude Code', installed: true, command: '/usr/local/bin/claude' }],
      runtimeCount: 1,
      runningSessions: 0,
      authority: { mayApply: true, applyRefusal: 'granted', confirmation: 'none' },
    },
    // Picking another machine opens its Runtimes tab first.
    '/v1/fleet/runtimes': { format: 'version-2', runtimes: [] },
  },
};

/** A paired machine that answers it is not set up yet, and the first run's reads of it. */
const NOT_SET_UP = {
  '/v1/fleet/machine': {
    name: 'gamma',
    format: 'none',
    setUp: false,
    agentPermissions: 'auto',
    defaultRuntime: null,
    agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false },
    tools: [{ harness: 'claude', label: 'Claude Code', installed: true, command: '/usr/local/bin/claude' }],
    runtimeCount: 0,
    runningSessions: 0,
    authority: { mayApply: true, applyRefusal: 'granted', confirmation: 'none' },
  },
  '/v1/fleet/setup/scan': {
    machine: 'gamma',
    format: 'none',
    tools: [],
    harnesses: [],
    runtimes: [],
    updates: [],
    duplicates: [],
    notes: [],
    importing: { available: true },
  },
  '/v1/fleet/runtimes': { format: 'version-2', runtimes: [] },
};

/**
 * Waits for the root to land on `path`. Where a pairing lands is decided by one read of the machine,
 * over a session that has to be opened first, so it arrives some unknowable number of turns later.
 */
const landed = async (path: string): Promise<void> => {
  await settleUntil(
    () => window.location.pathname === path,
    () => `the root to land on ${path} (it is on ${window.location.pathname})`,
    interact,
  );
};

/** Which screen of the setup guide is on the glass, if it is on the glass at all. */
const stepOfSetup = (container: HTMLElement): string | null | undefined =>
  container.querySelector('[data-onboarding="setup"]')?.getAttribute('data-onboarding-screen');

/**
 * Waits for a confirmed pairing to finish on the guide's last stage.
 *
 * NOT `settle()`. Redeeming the code is an exchange over a real session — a handshake whose
 * WebCrypto settles off the JavaScript thread — so a fixed count of timer turns is a different
 * budget on every machine. Measured: 2 to 12 turns on an idle machine and up to 20 under CPU load,
 * against `settle()`'s 12, which is how "takes a scanned pairing link" read `scan` on CI.
 */
const pairedInGuide = async (container: HTMLElement): Promise<void> => {
  await settleUntil(
    () => stepOfSetup(container) === 'done',
    () => `the pairing to finish on the guide's done stage (it is on ${stepOfSetup(container)})`,
    interact,
  );
};

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

/** Walks the pairing entry to the browser's half of pairing: `fy pair` elsewhere, then the scan. */
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
   * install → agents → daemon → local. The agents step is not decoration on the
   * way past: Ferretry runs Claude Code and Codex and is neither of them, so a
   * daemon standing up with both missing serves perfectly and runs nothing.
   */
  await advanceStep(container);
  await advanceStep(container);
  await advanceStep(container);
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
    expect(window.location.pathname).toBe(`/d/${ALPHA}`);
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

  it('follows a live OS light/dark switch on setup, where no theme control is mounted', async () => {
    // Arrange — B8: only the theme toggle and Settings ran `useTheme`, so the setup page, a phone
    // layout and a session page kept the old scheme until a reload.
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    const original = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    // The tab-wide store outlives each file: an earlier one may have left it on Dark.
    const mode = themePreferences.snapshot().mode;
    themePreferences.setMode('system');
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: () => ({
        matches: false,
        addEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
        removeEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
      }),
    });
    try {
      const { view } = await renderShell('/');
      const before = document.documentElement.dataset.theme;

      // Act
      await interact(() => {
        for (const listener of listeners) listener({ matches: true } as MediaQueryListEvent);
      });

      // Assert
      expect(view.container.querySelector('[data-onboarding="setup"]')).not.toBeNull();
      expect(before).toEndWith('-light');
      expect(document.documentElement.dataset.theme).toEndWith('-dark');
      await view.unmount();
    } finally {
      if (original) Object.defineProperty(window, 'matchMedia', original);
      else Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'matchMedia');
      themePreferences.setMode(mode);
    }
  });

  it('names the machine asking in the one passkey prompt, and a machine it no longer holds plainly', async () => {
    // Arrange
    const { store, view } = await renderShell('/', [alpha.daemonId]);
    const ghost = daemonConnection({
      daemonId: GAMMA_ID,
      baseUrl: 'https://gamma.example.test',
      deviceId: GAMMA_TOKEN,
    });
    const purpose = (): string | null | undefined =>
      view.container.querySelector('[data-step-up-dialog] p')?.textContent;

    // Act — a paired machine asks, then one this browser holds no record of.
    void store.stepUp.require(alpha);
    await settle();
    const named = purpose();
    await interact(() => store.stepUp.dismiss());
    void store.stepUp.require(ghost);
    await settle();
    const unnamed = purpose();
    await interact(() => store.stepUp.dismiss());

    // Assert
    expect(named).toContain(alpha.baseUrl);
    expect(unnamed).toContain('This machine');
    await view.unmount();
  });

  it('raises a machine’s unlock only while it is on screen, and names a twin by its address', async () => {
    // Arrange — B19: two machines on one host both call themselves "kirin-box". The second one's
    // background reads raised its unlock over the first one's page, named by the host they share.
    const twinA = daemonConnection({ ...alpha, daemonName: 'kirin-box' });
    const twinB = daemonConnection({ ...beta, daemonName: 'kirin-box' });
    const { store, view } = await renderShell(`/d/${ALPHA}`, [twinA, twinB]);
    const prompt = (): Element | null => view.container.querySelector('[data-step-up-dialog]');

    // Act — B's read waits while A is on screen, then B comes on screen.
    void store.unlockGate.require(twinB, undefined, 'background');
    await settle();
    const overA = prompt();
    const locked = store.unlockGate.waitingDaemons();
    await popTo(`/d/${BETA}`);
    await settle();
    const named = prompt()?.querySelector('[data-step-up-machine]')?.textContent;
    await interact(() => store.unlockGate.dismiss());

    // Assert
    expect(overA).toBeNull();
    expect(locked).toEqual([twinB.daemonId]);
    expect(named).toBe('kirin-box (beta.example.test)');
    await view.unmount();
  });

  it('nudges a paired device with no passkey toward its Machine tab’s Security panel, once, and not on Settings itself', async () => {
    const PASSKEYS = {
      '/v1/passkeys': { passkeys: [], registration: 'first-window' },
      '/v1/security': {
        settings: {
          stepUpWindowMinutes: 15,
          deviceKeyRotationDays: 30,
          unlockOnOpen: true,
          unlockValidityHours: 8,
          stepUpOnActions: false,
          idleExpiryDays: 30,
        },
        source: 'defaults',
        mayWiden: false,
        widenCommand: 'fy daemon security set <field> <value>',
      },
    };
    const { view } = await renderShell(`/d/${ALPHA}`, [alpha.daemonId], { fleet: PASSKEYS });
    await settle();

    const nudge = view.container.querySelector('[data-passkey-nudge]');
    expect(nudge?.getAttribute('data-passkey-nudge')).toBe(ALPHA);

    await interact(() =>
      must(view.container.querySelector<HTMLButtonElement>('[data-passkey-nudge-open]'), 'the nudge link').click(),
    );
    await settle();

    expect(window.location.pathname).toBe(`/d/${ALPHA}/settings`);
    // The nudge still links the old `#security` anchor; Settings rewrites it to where Security lives now.
    expect(window.location.hash).toBe(`#machines/${encodeURIComponent(alpha.baseUrl)}/machine/security`);
    expect(view.container.querySelector('[data-daemon-panel-open="security"]')).not.toBeNull();
    expect(view.container.querySelector('[data-security-card]')).not.toBeNull();
    expect(view.container.querySelector('[data-passkey-nudge]')).toBeNull();
    await view.unmount();
  });

  it('remembers a dismissed nudge for that machine across mounts', async () => {
    const PASSKEYS = { '/v1/passkeys': { passkeys: [], registration: 'first-window' } };
    const first = await renderShell(`/d/${ALPHA}`, [alpha.daemonId], { fleet: PASSKEYS });
    await settle();
    await interact(() =>
      must(
        first.view.container.querySelector<HTMLButtonElement>('[data-passkey-nudge-dismiss]'),
        'the dismiss',
      ).click(),
    );
    expect(first.view.container.querySelector('[data-passkey-nudge]')).toBeNull();
    await first.view.unmount();

    const second = await renderShell(`/d/${ALPHA}`, [alpha.daemonId], { fleet: PASSKEYS });
    await settle();
    expect(second.view.container.querySelector('[data-passkey-nudge]')).toBeNull();
    await second.view.unmount();
  });

  it('replaces the page with one sentence and Pair again when the machine no longer accepts this browser', async () => {
    // Arrange — the router has learned a 4403. Only that one read is substituted; the rest is real.
    const carrierSeam: MeasuredCarrierSeam = {
      publish: () => undefined,
      wrap: router =>
        new Proxy(router, {
          get(target, property) {
            if (property === 'deviceRefused') return () => true;
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? (value as (...args: never[]) => unknown).bind(target) : value;
          },
        }),
    };
    const { view } = await renderShell(`/d/${ALPHA}/projects`, [alpha.daemonId], { carrierSeam });
    await settle();

    // Assert — ONE sentence, not one "could not reach" per panel.
    const notice = must(view.container.querySelector('[data-device-refused]'), 'the refused-device notice');
    expect(notice.querySelector('[role="alert"]')?.textContent).toBe(DEVICE_NOT_ACCEPTED_SENTENCE);
    expect(view.container.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(view.container.textContent).not.toContain('could not reach');

    // Act — the person pairs again.
    await interact(() =>
      must(view.container.querySelector<HTMLButtonElement>('[data-device-refused-pair]'), 'Pair again').click(),
    );
    await settle();

    // Assert — on the pairing step of the guide, not its first question.
    expect(window.location.pathname).toBe('/setup');
    expect(JSON.parse(localStorage.getItem('fy-onboarding-v4') ?? '{}')).toMatchObject({
      stage: 'walk',
      route: 'add-client',
      current: 'scan',
    });
    expect(stepOfSetup(view.container)).toBe('scan');
    await view.unmount();
  });

  it('brings the page back once the refusal is gone', async () => {
    let refused = true;
    const listeners = new Set<() => void>();
    const carrierSeam: MeasuredCarrierSeam = {
      publish: () => {
        for (const listener of [...listeners]) listener();
      },
      wrap: router =>
        new Proxy(router, {
          get(target, property) {
            if (property === 'deviceRefused') return () => refused;
            if (property === 'subscribe')
              return (listener: () => void) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
              };
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? (value as (...args: never[]) => unknown).bind(target) : value;
          },
        }),
    };
    const { view } = await renderShell(`/d/${ALPHA}/projects`, [alpha.daemonId], { carrierSeam });
    await settle();
    expect(view.container.querySelector('[data-device-refused]')).not.toBeNull();

    refused = false;
    await interact(() => carrierSeam.publish(undefined as never));
    await settle();

    expect(view.container.querySelector('[data-device-refused]')).toBeNull();
    await view.unmount();
  });

  it('mounts the daemon-scoped projects registry from its routed destination', async () => {
    const { view } = await renderShell(`/d/${ALPHA}/projects`, [alpha.daemonId]);
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
    const { view } = await renderShell(`/d/${ALPHA}/projects/${projectId}`, [alpha.daemonId], {
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

  it('walks from the registry to one project without leaving the app', async () => {
    // Arrange
    const projectId = '11111111-1111-4111-8111-111111111111';
    const { view } = await renderShell(`/d/${ALPHA}/projects`, [alpha.daemonId], {
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
    const link = view.container.querySelector<HTMLAnchorElement>('[data-registered-project] a');
    expect(link?.getAttribute('href')).toBe(`/d/${ALPHA}/projects/${projectId}`);

    // Act — an ordinary primary click.
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    await interact(() => link?.dispatchEvent(click));
    await settle();

    // Assert — the SAME mounted tree is now the detail screen. A raw anchor
    // would have left through the document instead, which in this environment
    // means the tree would still be showing the registry.
    expect(click.defaultPrevented).toBe(true);
    expect(window.location.pathname).toBe(`/d/${ALPHA}/projects/${projectId}`);
    expect(view.container.querySelector(`[data-project-detail="${projectId}"]`)).not.toBeNull();
    expect(view.container.querySelector('#projects-heading')).toBeNull();
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
    await pairedInGuide(view.container);

    // Finishes in the guide, keeps the daemon this browser already had, and
    // leaves only when the reader says so.
    expect(view.container.querySelector('[data-onboarding="setup"]')?.getAttribute('data-onboarding-screen')).toBe(
      'done',
    );
    const snapshot = store.connections.getSnapshot();
    expect(snapshot.connections.map(one => String(one.daemonId))).toEqual([GAMMA_ID, ALPHA]);
    expect(String(snapshot.selectedDaemonId)).toBe(GAMMA_ID);
    expect(window.location.pathname).toBe('/pair');

    await interact(() =>
      must(view.container.querySelector<HTMLButtonElement>('[data-onboarding-open-fleet]'), 'the fleet action').click(),
    );
    await landed(`/d/${GAMMA_ID}`);
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
    await pairedInGuide(view.container);
    await interact(() =>
      must(view.container.querySelector<HTMLButtonElement>('[data-onboarding-open-fleet]'), 'the fleet action').click(),
    );
    await landed(`/d/${GAMMA_ID}`);
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

    expect(window.location.pathname).toBe(`/d/${ALPHA}`);
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
    const { reads, view } = await renderShell(`/d/${ALPHA}/session/shared`, [alpha.daemonId, beta.daemonId]);
    await settle();

    const session = view.container.querySelector('[data-session="shared"]');
    expect(session?.getAttribute('data-daemon')).toBe(ALPHA);
    expect(session?.textContent).toContain('Alpha Agent');
    expect(session?.textContent).not.toContain('Beta Agent');
    expect(reads).toEqual([`${ALPHA}:shared`]);
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
    const { view } = await renderShell(`/d/${ALPHA}/session/shared`, [alpha.daemonId]);
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
    const { liveFeeds, reads, store, transcriptReads, view } = await renderShell(`/d/${ALPHA}/session/shared`, [
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
    // The refresh an event asks for waits out the burst it may be part of, on the real browser clock.
    expect(reads.length).toBe(sessionReads);
    await interact(() => new Promise(resolve => setTimeout(resolve, NUDGE_SETTLE_MS + 20)));
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

  it('starts the live feed where the session journal stood rather than replaying its history', async () => {
    const { liveFeeds, store, view } = await renderShell(`/d/${ALPHA}/session/shared`, [alpha.daemonId], {
      journalSequence: 2_000,
    });
    await settle();
    await interact(async () => {
      await store.carrier.send(alpha, `${alpha.baseUrl}/v1/health`);
    });
    await settle();

    // No replay of the whole history: the transcript and the surfaces are read directly.
    const feed = must(liveFeeds.at(-1), 'the live event subscription');
    expect(feed.after).toBe(2_000);
    const session = must(view.container.querySelector('[data-session="shared"]'), 'the mounted session route');
    // Nothing has ARRIVED yet: the cursor a harness reads still says so.
    expect(session.getAttribute('data-live-events')).toBe('0');
    await view.unmount();
  });

  /**
   * THE OTHER WAY A PAGE CAN GO ON CLAIMING TO BE LIVE, which is not a stream failure at all.
   *
   * The effect below only subscribes while there is a client AND a measured, reachable carrier. When
   * that stops being true — the client is replaced with `null`, or a later carrier walk answers
   * `ok: false` for a daemon that was reachable a minute ago — React runs the cleanup and the effect
   * RETURNS EARLY. The subscription is gone and no status is ever published, so a `useState` holding
   * the last reported value simply kept saying `live`: the same "a dead stream looks alive" defect
   * this route was changed to end, arrived at from the opposite direction and invisible to every
   * assertion about the stream itself, because the stream is not the thing that broke.
   *
   * IT HAPPENS IN TWO STEPS AND BOTH ARE ASSERTED, because the router does not go straight to a
   * verdict. A remembered winner that stops carrying is FORGOTTEN — `choice` becomes `undefined` and
   * the next request walks again — and only that later walk, having failed every carrier the daemon
   * publishes, publishes `ok: false`. So the page passes through "nothing is measured" on its way to
   * "this daemon cannot be reached", and it must not claim to be live in either.
   */
  it('stops claiming a live feed the moment its carrier stops carrying', async () => {
    let reachable = true;
    const { liveFeeds, store, view } = await renderShell(`/d/${ALPHA}/session/shared`, [alpha.daemonId], {
      carrierDown: () => !reachable,
    });
    await settle();
    const region = () => must(view.container.querySelector('[data-live-stream]'), 'the live-stream region');
    const walk = async (): Promise<void> => {
      await interact(async () => {
        // The request itself rejects — every carrier failed, which is the point. What matters is the
        // choice the router publishes on its way out. A WRITE, because a read whose winner dies walks
        // again inside the same call, and this test is about the moment between the two. A PROBE, because
        // after the first failure only the connection model's own attempt may dial (this suite never runs one).
        await store.carrier.probe(alpha, `${alpha.baseUrl}/v1/health`, { method: 'POST' }).catch(() => undefined);
      });
      await settle();
    };

    await interact(() => must(liveFeeds[0], 'the live event subscription').emit(liveEvent(4)));
    await settle();
    expect(region().getAttribute('data-live-stream')).toBe('live');

    // Act I — the daemon stops answering, so the remembered carrier is forgotten.
    reachable = false;
    await walk();

    // Assert I — this is the transition that used to leave `Live` on screen with nothing behind it:
    // the effect's guard stopped holding, React ran the cleanup, and the effect returned early
    // without ever publishing a status. Nothing is measured now, and the app walks again on its next
    // request, so `connecting` is the honest reading — but `live` is the one it must never be.
    expect(store.carrier.choice(alpha.daemonId)).toBeUndefined();
    expect(region().getAttribute('data-live-stream')).toBe('connecting');
    // AND THE OLD FEED IS ALREADY GONE, HERE, at the exact moment the remembered carrier cleared —
    // not eventually, by the time the walk below reaches its verdict. A route that held the dead
    // subscription open through this interval and only dropped it at the final refusal would satisfy
    // every OTHER assertion in this test: the count is the same either way, and so is the chip. What
    // it would actually be doing is keeping a socket on a carrier the router has forgotten, for as
    // long as the next walk takes.
    expect(must(liveFeeds[0], 'the original subscription').aborted()).toBe(true);
    expect(must(liveFeeds[0], 'the original subscription').settled()).toBe(true);
    expect(liveFeeds).toHaveLength(1);

    // Act II — that next walk tries every carrier the daemon publishes and reaches a verdict.
    await walk();

    // Assert II
    expect(store.carrier.choice(alpha.daemonId)?.ok).toBe(false);
    expect(region().getAttribute('data-live-stream')).toBe('unavailable');
    const sentence = must(region().querySelector('.sr-only'), 'the announced sentence').textContent ?? '';
    expect(sentence).toContain('cannot be reached');
    // NOT a promise of a timer refresh, and that is not pedantry: the poll underneath takes the same
    // carrier that just failed, so it is not refreshing anything either.
    expect(sentence).not.toContain('timer');
    // AND NO CONTROL THAT WOULD DO NOTHING. The route tore its model down, so a Reconnect button here
    // would be wired to a null control — an affordance that looks like a remedy and is a no-op.
    expect(region().querySelector('button[data-live-stream-reconnect]')).toBeNull();
    // The subscription is gone because the ROUTE CANCELLED IT, not because nothing reopened one, and
    // it is STILL gone — the verdict did not quietly reopen anything on the way to saying so.
    // `liveFeeds.length` counts opens and would read exactly the same with the cleanup deleted.
    expect(must(liveFeeds[0], 'the original subscription').aborted()).toBe(true);
    expect(must(liveFeeds[0], 'the original subscription').settled()).toBe(true);
    expect(liveFeeds).toHaveLength(1);

    await view.unmount();
  });

  /**
   * THE REPLACEMENT RACE, WATCHED AT EVERY COMMIT RATHER THAN AFTER THE DUST SETTLES.
   *
   * Reading the DOM once React has finished cannot see this defect at all. Both the broken and the
   * fixed route settle on the same final attribute; what differed was a frame in between. On the
   * render where a carrier walk SUCCEEDS after a failure, the host facts already permit a
   * subscription while the replacement model does not exist yet — it is built by a passive effect
   * after the commit — so React painted the previous owner's `live` over a session with nothing
   * behind it, and a previous `disconnected` painted a Reconnect button whose callback had a null
   * control. A MutationObserver records every committed value, which is the only way to assert about
   * a frame that is immediately overwritten.
   *
   * The teardown assertions are here for the same reason as above: `liveFeeds.length` counts opens,
   * so only the signal can say whether the old stream is actually gone.
   */
  it('never commits the previous owner‘s state when a carrier becomes reachable again', async () => {
    let reachable = true;
    const { liveFeeds, store, view } = await renderShell(`/d/${ALPHA}/session/shared`, [alpha.daemonId], {
      carrierDown: () => !reachable,
    });
    await settle();
    const region = () => must(view.container.querySelector('[data-live-stream]'), 'the live-stream region');
    const walk = async (): Promise<void> => {
      await interact(async () => {
        // A write, so the dead winner is forgotten without a second walk inside the same call; a probe,
        // because once the daemon is reconnecting only the model's attempt may dial.
        await store.carrier.probe(alpha, `${alpha.baseUrl}/v1/health`, { method: 'POST' }).catch(() => undefined);
      });
      await settle();
    };

    await interact(() => must(liveFeeds[0], 'the live event subscription').emit(liveEvent(4)));
    await settle();
    expect(region().getAttribute('data-live-stream')).toBe('live');

    // The daemon goes away and a walk reaches the `ok: false` verdict.
    reachable = false;
    await walk();
    await walk();
    expect(region().getAttribute('data-live-stream')).toBe('unavailable');
    const original = must(liveFeeds[0], 'the original subscription');
    expect(original.aborted()).toBe(true);

    // A LATE DAEMON CANNOT REACH THE PAGE THROUGH A CANCELLED SOCKET. Delivered after the route let
    // go of it, these must move nothing: not the cursor, not the state, not the budget.
    await interact(() => {
      original.emit(liveEvent(99));
      original.idle({ kind: 'idle', idleSeconds: 30, scope: { kind: 'session', sessionId: 'shared', after: 99 } });
    });
    await settle();
    const session = must(view.container.querySelector('[data-session="shared"]'), 'the mounted session route');
    expect(session.getAttribute('data-live-events')).toBe('4');
    expect(region().getAttribute('data-live-stream')).toBe('unavailable');

    // Act — every committed value from here on, not just the last one.
    const committed: Array<string | null> = [];
    const observer = new MutationObserver(records => {
      for (const record of records) committed.push((record.target as HTMLElement).getAttribute('data-live-stream'));
    });
    observer.observe(view.container, { attributes: true, attributeFilter: ['data-live-stream'], subtree: true });
    reachable = true;
    await walk();
    observer.disconnect();

    // Assert — the page recovers, and NOT ONE committed frame in between claimed the old owner's
    // state. `live` is the unacceptable one; `disconnected` would have carried a dead button.
    expect(store.carrier.choice(alpha.daemonId)?.ok).toBe(true);
    expect(committed.length).toBeGreaterThan(0);
    expect(committed).not.toContain('live');
    expect(committed).not.toContain('disconnected');
    expect(committed.at(-1)).toBe('connecting');
    expect(region().getAttribute('data-live-stream')).toBe('connecting');
    expect(region().querySelector('button[data-live-stream-reconnect]')).toBeNull();

    // Exactly ONE replacement, and it resumes at the cursor the page is still showing rather than
    // replaying the tail — the late `99` above must not have moved it.
    expect(liveFeeds).toHaveLength(2);
    expect(must(liveFeeds[1], 'the replacement subscription').after).toBe(4);
    expect(must(liveFeeds[1], 'the replacement subscription').aborted()).toBe(false);

    // And the recovered feed is a working one.
    await interact(() => must(liveFeeds[1], 'the replacement subscription').emit(liveEvent(7)));
    await settle();
    expect(region().getAttribute('data-live-stream')).toBe('live');
    expect(session.getAttribute('data-live-events')).toBe('7');

    await view.unmount();
  });

  /**
   * THE SAME RACE WITHOUT THE GAP: one measured carrier REPLACED BY ANOTHER OF THE SAME KIND.
   *
   * The restoration case above goes through `undefined`, so a route that keyed its owner on the
   * carrier's KIND still survives it — `direct` becomes `none` becomes `direct`, and the kind moved.
   * Relay A becoming relay B does not move it. Neither does a direct address being replaced by
   * another direct address, which is this test: the winner is a different object naming a different
   * machine, and every derived boolean about it is identical. A route keyed on the kind therefore
   * changes NOTHING — it keeps the old model, on a carrier the router has already replaced, and goes
   * on reporting that model's `live` for the life of the session. There is no later transition to
   * catch it, which is what makes this the worse half of the defect rather than the exotic one.
   *
   * WHY IT NEEDS A SEAM AND WHAT THE SEAM IS NOT: {@link MeasuredCarrierSeam}. Short version —
   * today's router only ever replaces a winner by way of `undefined`, that is a property of one call
   * site rather than of this route, and the owner identity must not be built on it. Everything else
   * here is the production composition: the same hook, the same memo, the same effect, the same
   * client, the same feed.
   */
  it('never commits the previous owner‘s state when the measured carrier is replaced by its own kind', async () => {
    const carrierSeam = measuredCarrierSeam();
    const { liveFeeds, store, view } = await renderShell(`/d/${ALPHA}/session/shared`, [alpha.daemonId], {
      carrierSeam,
    });
    await settle();
    const region = () => must(view.container.querySelector('[data-live-stream]'), 'the live-stream region');
    const session = must(view.container.querySelector('[data-session="shared"]'), 'the mounted session route');

    await interact(() => must(liveFeeds[0], 'the live event subscription').emit(liveEvent(4)));
    await settle();
    expect(region().getAttribute('data-live-stream')).toBe('live');

    /*
     * The replacement, built by the router's OWN chooser from the router's own probe so that it is
     * the shape a walk really publishes rather than a literal shaped like one — and asserted to be
     * what this test claims it is: a different object, the same kind. If those two facts were not
     * both true the test would be proving something else entirely.
     */
    const measured = store.carrier.choice(alpha.daemonId);
    if (measured?.ok !== true) throw new Error('the mounted route has not measured a carrier to replace');
    const replacement = chooseCarrier([
      carrierProbe(
        { kind: 'direct', daemonUrl: 'https://alpha-moved.example.test' },
        { kind: 'answered', status: 200 },
      ),
    ]);
    if (!replacement.ok) throw new Error('the chooser refused a probe it was told had answered');
    expect(replacement).not.toBe(measured);
    expect(replacement.method.kind).toBe(measured.method.kind);
    expect(replacement.method).not.toEqual(measured.method);

    // Act — every committed value, because the broken and the fixed route agree on the last one.
    const committed: Array<string | null> = [];
    const observer = new MutationObserver(records => {
      for (const record of records) committed.push((record.target as HTMLElement).getAttribute('data-live-stream'));
    });
    observer.observe(view.container, { attributes: true, attributeFilter: ['data-live-stream'], subtree: true });
    await interact(() => carrierSeam.publish(replacement));
    await settle();
    observer.disconnect();

    // Assert — the kind did not move, and the route noticed anyway.
    expect(session.getAttribute('data-carrier-kind')).toBe('direct');
    expect(committed.length).toBeGreaterThan(0);
    expect(committed).not.toContain('live');
    expect(committed).not.toContain('disconnected');
    expect(committed.at(-1)).toBe('connecting');
    expect(region().getAttribute('data-live-stream')).toBe('connecting');
    // The old owner's control would be wired to a model this render has let go of.
    expect(region().querySelector('button[data-live-stream-reconnect]')).toBeNull();

    // The old feed is actually gone, and exactly ONE opened in its place — at the cursor the page is
    // still showing, on the client that never changed.
    expect(must(liveFeeds[0], 'the original subscription').aborted()).toBe(true);
    expect(must(liveFeeds[0], 'the original subscription').settled()).toBe(true);
    expect(liveFeeds).toHaveLength(2);
    expect(must(liveFeeds[1], 'the replacement subscription').after).toBe(4);
    expect(must(liveFeeds[1], 'the replacement subscription').aborted()).toBe(false);
    expect(must(liveFeeds[1], 'the replacement subscription').client).toBe(
      must(liveFeeds[0], 'the original subscription').client,
    );

    // And the replacement is a working feed rather than a reopened socket.
    await interact(() => must(liveFeeds[1], 'the replacement subscription').emit(liveEvent(7)));
    await settle();
    expect(region().getAttribute('data-live-stream')).toBe('live');
    expect(session.getAttribute('data-live-events')).toBe('7');

    await view.unmount();
  });

  /**
   * THE THIRD OF THE OWNER NOTHING ELSE IN THIS FILE MOVES: the CLIENT, replaced under a session
   * that never closes.
   *
   * It is not a hypothetical and it is not a re-pair. A daemon's first answer is routinely followed
   * by `GET /v1/carriers`, whose set REPLACES the cached one — same daemon, same address, same grant,
   * a new connection object — and `DaemonApiPool` fences its clients on exactly that value, so the
   * typed client is rebuilt while the daemon, the carrier, its kind and the session all stay put.
   * Every fact this route derives from the host is unchanged across that moment. The only thing that
   * moved is the object the subscription is made ON, and a feed left on the previous client is a feed
   * whose transport the route has already discarded.
   *
   * So this is the case that fails if the client is left OUT of the owner key. There is no state
   * transition to notice, no kind to compare and no count to be wrong: the old model keeps reporting
   * `live` on a client nobody holds any more, and the attribute never changes at all — which is why
   * the ledger below asserts that something WAS committed before it asserts what.
   */
  it('never commits the previous owner‘s state when the typed client is replaced under the session', async () => {
    const { clients, liveFeeds, store, view } = await renderShell(`/d/${ALPHA}/session/shared`, [alpha.daemonId]);
    await settle();
    const region = () => must(view.container.querySelector('[data-live-stream]'), 'the live-stream region');
    const session = must(view.container.querySelector('[data-session="shared"]'), 'the mounted session route');

    await interact(() => must(liveFeeds[0], 'the live event subscription').emit(liveEvent(4)));
    await settle();
    expect(region().getAttribute('data-live-stream')).toBe('live');
    const measured = store.carrier.choice(alpha.daemonId);
    expect(measured?.ok).toBe(true);
    expect(clients).toHaveLength(1);

    // Act — the daemon republishes the set it can be reached on, which is the ordinary sequel to its
    // first answer and is authoritative over the cache. Same address, same grant, new connection.
    // EVERY STATE THE REGION PAINTS: an attribute that changes in place, AND a region that arrives
    // already carrying one — the session bar is rebuilt with the page when the client is replaced, and a
    // fresh region claiming `live` would be the same lie as an old one keeping it.
    const committed: Array<string | null> = [];
    const collect = (records: readonly MutationRecord[]): void => {
      for (const record of records) {
        if (record.type === 'attributes') {
          committed.push((record.target as HTMLElement).getAttribute('data-live-stream'));
          continue;
        }
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          const arrived = node.matches('[data-live-stream]')
            ? [node]
            : [...node.querySelectorAll('[data-live-stream]')];
          for (const region of arrived) committed.push(region.getAttribute('data-live-stream'));
        }
      }
    };
    const observer = new MutationObserver(collect);
    observer.observe(view.container, {
      attributes: true,
      attributeFilter: ['data-live-stream'],
      childList: true,
      subtree: true,
    });
    await interact(() => {
      store.connections.replaceCarriers(alpha, alphaRelayed.carriers);
    });
    await settle();
    // Anything still queued is a frame that was painted; disconnecting would discard it unread.
    collect(observer.takeRecords());
    observer.disconnect();

    // THE OTHER TWO THIRDS OF THE OWNER DID NOT MOVE, and saying so is what makes this a test about
    // the client: the measured carrier is the same OBJECT, its kind is the same word, and the route
    // is still mounted on the same session.
    expect(store.carrier.choice(alpha.daemonId)).toBe(measured);
    expect(session.getAttribute('data-carrier-kind')).toBe('direct');
    expect(session.getAttribute('data-session')).toBe('shared');

    // Assert — a new client exists, and no frame in between claimed the old one's state.
    expect(clients).toHaveLength(2);
    expect(committed.length).toBeGreaterThan(0);
    expect(committed).not.toContain('live');
    expect(committed).not.toContain('disconnected');
    expect(committed.at(-1)).toBe('connecting');
    expect(region().getAttribute('data-live-stream')).toBe('connecting');
    expect(region().querySelector('button[data-live-stream-reconnect]')).toBeNull();

    // Exactly one replacement, at the held cursor, ON THE NEW CLIENT — which is the assertion a
    // count cannot make and the one that fails if the owner key forgets the client.
    expect(must(liveFeeds[0], 'the original subscription').aborted()).toBe(true);
    expect(must(liveFeeds[0], 'the original subscription').settled()).toBe(true);
    expect(liveFeeds).toHaveLength(2);
    expect(must(liveFeeds[1], 'the replacement subscription').after).toBe(4);
    expect(must(liveFeeds[1], 'the replacement subscription').aborted()).toBe(false);
    expect(must(liveFeeds[0], 'the original subscription').client).toBe(must(clients[0], 'the original client'));
    expect(must(liveFeeds[1], 'the replacement subscription').client).toBe(must(clients[1], 'the replacement client'));

    // A LATE FRAME FROM THE DISCARDED CLIENT MOVES NOTHING, which is the same fence the restoration
    // case proves and is worth proving here too: this is the transition where the two feeds are most
    // alike, because nothing about the carrier or the session distinguishes them.
    await interact(() => must(liveFeeds[0], 'the original subscription').emit(liveEvent(99)));
    await settle();
    expect(session.getAttribute('data-live-events')).toBe('4');
    expect(region().getAttribute('data-live-stream')).toBe('connecting');

    // And the replacement is a working feed.
    await interact(() => must(liveFeeds[1], 'the replacement subscription').emit(liveEvent(7)));
    await settle();
    expect(region().getAttribute('data-live-stream')).toBe('live');
    expect(session.getAttribute('data-live-events')).toBe('7');

    await view.unmount();
  });

  /**
   * WHAT THE READER IS SHOWN WHEN THE FEED STOPS, driven through the real route.
   *
   * This is the defect the whole PR exists for, and it was invisible precisely BECAUSE every other
   * assertion in this file still passed after it happened: the transcript kept refreshing on its
   * three-second poll, the session stayed `connected`, the carrier stayed `direct`, and the page
   * went on looking live forever. Nothing rendered by this route distinguished "the daemon has said
   * nothing because nothing has happened" from "the socket died and nobody noticed".
   *
   * So the assertions here are the ones that could not have been made before: a stopped feed is a
   * VISIBLE state, and the reader's way out of it is a real control wired to a real resubscription.
   * The route's own state — the model's schedule, its jitter and its budget — belongs to
   * `session-event-stream-model.test.ts`; what this proves is that the composition root actually
   * connected the three of them.
   */
  it('shows the reader a stopped live feed and reconnects it on demand', async () => {
    const { liveFeeds, view } = await renderShell(`/d/${ALPHA}/session/shared`, [alpha.daemonId]);
    await settle();
    const session = must(view.container.querySelector('[data-session="shared"]'), 'the mounted session route');
    const region = () => must(view.container.querySelector('[data-live-stream]'), 'the live-stream region');

    // A subscription exists but nothing has proved it: constructing a socket is not evidence a daemon
    // is on the other end, and the route says the honest one of the two.
    expect(liveFeeds).toHaveLength(1);
    expect(region().getAttribute('data-live-stream')).toBe('connecting');

    await interact(() => must(liveFeeds[0], 'the live event subscription').emit(liveEvent(3)));
    await settle();
    expect(region().getAttribute('data-live-stream')).toBe('live');
    expect(region().querySelector('button[data-live-stream-reconnect]')).toBeNull();

    // The daemon goes away. Before this PR the route swallowed exactly this and changed nothing.
    await interact(() => must(liveFeeds[0], 'the live event subscription').end());
    await settle();
    // A drop is not news until it outlasts the quiet window (a blip back inside it is never said),
    // which here is waited out on the real browser clock.
    expect(region().getAttribute('data-live-stream')).toBe('live');
    await interact(() => new Promise(resolve => setTimeout(resolve, SESSION_EVENT_STREAM_QUIET_MS + 50)));
    await settle();

    expect(region().getAttribute('data-live-stream')).toBe('reconnecting');
    expect(must(region().querySelector('.sr-only'), 'the announced sentence').textContent).toContain(
      'still refreshes on a timer',
    );
    // The first backoff window is shorter than the quiet window, so its retry has opened a second
    // subscription by now, and nothing has proved it yet: still reconnecting, and the control is offered.
    expect(liveFeeds).toHaveLength(2);

    const reconnect = must(
      region().querySelector<HTMLButtonElement>('button[data-live-stream-reconnect]'),
      'the reconnect button',
    );
    await interact(() => reconnect.click());
    await settle();

    // ONE new subscription, resuming at the cursor the old one reached rather than replaying the
    // tail — and the route is back to an honest unproved state rather than claiming to be live.
    expect(liveFeeds).toHaveLength(3);
    expect(must(liveFeeds[2], 'the resumed subscription').after).toBe(3);
    expect(session.getAttribute('data-live-events')).toBe('3');
    expect(region().getAttribute('data-live-stream')).toBe('connecting');

    await interact(() => must(liveFeeds[2], 'the resumed subscription').emit(liveEvent(11)));
    await settle();

    // RECOVERED: the resubscription is a working feed, not just a reopened socket.
    expect(region().getAttribute('data-live-stream')).toBe('live');
    expect(session.getAttribute('data-live-events')).toBe('11');
    await view.unmount();
  });

  /**
   * THE ROOT'S OWN TERMINAL DECK, through the real pane, on the real carrier router.
   *
   * No deck test can see the composition root's wiring — the deck is always handed a fake — and a
   * root that wired the deck to the wrong opener would ship a terminal that never attaches. So this
   * drives the production deck end to end: the listing goes over the daemon's request session, and
   * the terminal opens as its OWN stream session on the daemon the route named, for the terminal the
   * daemon listed. That stream record is the assertion, because it is the far end of the whole chain.
   */
  it('opens the production terminal deck as a stream session on the daemon the route named', async () => {
    // THE EMULATOR IS LOADED FIRST, AND ITS FAILURE IS REPORTED RATHER THAN SWALLOWED.
    //
    // The deck loads `@xterm/xterm` through a dynamic `import()` inside an effect and, if that
    // rejects, deliberately has nowhere to go: "The emulator could not be loaded at all. There is
    // nothing to retry into", so it sets `refused` and drops the reason on the floor. Correct for a
    // reader, blinding for a test — CI showed exactly that state (one canvas mounted, lamp `refused`,
    // the terminal listing sent and no stream ever opened) with no way to see why.
    //
    // Awaiting the same modules here answers it: the module registry is per process, so the deck's
    // own `loadXterm` resolves from what this line loaded, and a rejection fails the test with the
    // real reason instead of a silent `refused`. What the test is about — the ROOT passing the
    // measured-carrier getter its direct attach is gated on — is untouched; this only stops a module
    // load from being measured as part of the attach.
    //
    // The load is only half of it. That `.catch` sits on the END of the chain, so it also swallows
    // anything the `.then` throws — `new Terminal(...)`, `loadAddon`, `open(host)` — and CI proved the
    // modules themselves import cleanly, which leaves the construction. So both halves are exercised
    // here, and each reports its own reason.
    const emulator = await (async () => {
      try {
        return await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
      } catch (cause) {
        throw new Error(`the terminal emulator modules could not be loaded in this environment: ${String(cause)}`, {
          cause,
        });
      }
    })();
    const probeHost = document.createElement('div');
    document.body.appendChild(probeHost);
    try {
      const probe = new emulator[0].Terminal();
      probe.loadAddon(new emulator[1].FitAddon());
      probe.open(probeHost);
      probe.dispose();
    } catch (cause) {
      throw new Error(`the terminal emulator could not be constructed in this environment: ${String(cause)}`, {
        cause,
      });
    } finally {
      probeHost.remove();
    }
    const streamsOpened = (): { t: string; path?: string }[] =>
      (daemonNetwork?.requests('alpha.example.test') ?? []) as { t: string; path?: string }[];
    const { carrierRequests, store, view } = await renderShell(`/d/${ALPHA}/session/shared`, [alpha.daemonId]);
    try {
      await settle();
      // No terminal tab is open yet, so no shell is attached — the page reads the LISTING only, to
      // prove `%terminal:` chips in the transcript.
      expect(streamsOpened().some(record => record.t === 'stream')).toBe(false);

      // A terminal tab in this agent's workspace — as a chip click or a remembered layout opens it —
      // attaches that one shell.
      await interact(() => {
        store.workspaceLayouts.update(daemonSessionScope(alpha, 'shared'), layout =>
          openWorkspaceTab(layout, workspaceTab('terminal', TERMINAL_ID, { label: 'dev' })),
        );
      });
      // ACROSS REAL TASK BOUNDARIES, not just microtasks. The chain is module load → listing →
      // stream session, with a task between the links; `settle` flushes two microtasks, which is
      // right for everything else in this file and is not enough for this. The socket is what the
      // assertions below are about, so it is what the wait is gated on — and if it never opens, THIS
      // line says so rather than leaving the next assertion to report an absent URL.
      //
      // WHICH of those links the carrier was asked for is the diagnosis, so the expiry carries it:
      // nothing at all means the deck never listed; a listing without a stream puts the stall at the
      // emulator, because the attach effect only runs once `loadXterm` has produced one; a stream
      // without a socket is the attach itself. An expiry that only said "no socket" leaves that to be
      // guessed on a runner nobody can attach a debugger to — which cost two CI rounds before it said
      // this much.
      await settleUntil(
        () => streamsOpened().some(record => record.t === 'stream'),
        () =>
          [
            'the terminal deck to open its stream session',
            `(terminal requests reached: ${JSON.stringify(carrierRequests.filter(url => url.includes('/terminals')))}`,
            // The deck's own lamp is the state machine's answer: `idle` means the attach effect found
            // no emulator, so `loadXterm` has not resolved; `refused` means it or the attach rejected
            // and no retry is coming; `connecting` means the stream session is opening. Without it
            // a missing stream cannot tell "still loading" from "gave up".
            `link lamps: ${JSON.stringify(
              [...view.container.querySelectorAll<HTMLElement>('.kt-webterm__lamp')].map(lamp => lamp.dataset.state),
            )}`,
            `canvases: ${view.container.querySelectorAll('[data-terminal-canvas]').length})`,
          ].join(', '),
        interact,
      );

      expect(carrierRequests).toContain('https://alpha.example.test/v1/sessions/shared/terminals');
      expect(
        streamsOpened()
          .filter(record => record.t === 'stream')
          .map(record => record.path),
      ).toEqual([`/v1/sessions/shared/terminals/${TERMINAL_ID}/stream`]);
      // No ticket exists to be asked for, on any route.
      expect(carrierRequests.some(url => url.includes('ticket'))).toBe(false);
    } finally {
      // Unmounted and restored even when an assertion above threw: a retained deck keeps its refresh
      // interval, and a leaked real `WebSocket` fails a later test rather than this one.
      await view.unmount();
    }
  });

  it('applies the persisted chat measure to the real session surface', async () => {
    const { store, view } = await renderShell(`/d/${ALPHA}/session/shared`, [alpha.daemonId]);
    await settle();
    const surface = must(view.container.querySelector('[data-chat-width]'), 'the chat-width surface');
    // Comfortable is the shipped default.
    expect(surface.getAttribute('data-chat-width')).toBe('readable');

    await interact(() => store.controls.setDeviceControls({ chatWidth: 'full' }));

    expect(view.container.querySelector('[data-chat-width]')).toBe(surface);
    expect(surface.getAttribute('data-chat-width')).toBe('full');

    // Settings › Appearance › Motion › Reduced marks the document; System clears it again.
    await interact(() => store.controls.setDeviceControls({ motion: 'reduced' }));
    expect(document.documentElement.dataset.motion).toBe('reduced');
    await interact(() => store.controls.setDeviceControls({ motion: 'system' }));
    expect(document.documentElement.dataset.motion).toBeUndefined();
    await view.unmount();
  });

  it('never crosses two daemons that own the same session id', async () => {
    const { reads, transcriptReads, view } = await renderShell(
      `/d/${ALPHA}/session/shared`,
      [alpha.daemonId, beta.daemonId],
      { transcript: daemon => `assistant/message: ${daemon} transcript` },
    );
    await settle();
    expect(view.container.querySelector('[data-session="shared"]')?.textContent).toContain('Alpha Agent');
    expect(view.container.querySelector('[role="log"]')?.textContent).toContain(`${ALPHA} transcript`);

    await popTo(`/d/${BETA}/session/shared`);
    await settle();

    const session = view.container.querySelector('[data-session="shared"]');
    expect(session?.getAttribute('data-daemon')).toBe(BETA);
    expect(session?.textContent).toContain('Beta Agent');
    expect(session?.textContent).not.toContain('Alpha Agent');
    expect(view.container.querySelector('[role="log"]')?.textContent).toContain(`${BETA} transcript`);
    expect(view.container.querySelector('[role="log"]')?.textContent).not.toContain(`${ALPHA} transcript`);
    expect(reads).toEqual([`${ALPHA}:shared`, `${BETA}:shared`]);
    expect(transcriptReads).toEqual([`${ALPHA}:shared`, `${BETA}:shared`]);
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
      const { store, view } = await renderShell(`/d/${ALPHA}/session/shared`, [alpha.daemonId], {
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
        // The first board read is a fetch through the mounted shell: wait for it, not for a fixed number of turns.
        await settleUntil(() => store.attention.store.status(scope) === 'ready', 'the first board read', interact);
        expect(store.attention.store.status(scope)).toBe('ready');
        expect(store.attention.store.count(scope)).toBe(0);
        // Nothing waiting: no pinned "Needs you" block.
        expect(view.container.querySelector('[data-attention-card]')).toBeNull();
        expect(view.container.querySelector('button[data-needs-you]')).toBeNull();
        expect(view.container.querySelector('[data-fy-reference="attention:A3"]')).toBeNull();

        const initialAttentionReads = attentionReads;
        items = [externalAttentionItem];
        await interact(() => refresh?.());
        await settle();
        expect(attentionReads).toBeGreaterThan(initialAttentionReads);
        expect(store.attention.store.count(scope)).toBe(1);

        // The item is pinned above the composer, never a second chip in the header.
        const pinned = must(
          view.container.querySelector<HTMLElement>('[data-attention-panel] [data-attention-card]'),
          'the refreshed pinned "Needs you" item',
        );
        expect(pinned.getAttribute('data-pinned')).toBe('true');
        expect(view.container.querySelector('section[aria-label="Needs you"][data-attention-panel]')).not.toBeNull();
        expect(view.container.querySelector('button[data-needs-you]')).toBeNull();
        expect(view.container.querySelector('[data-fy-reference="attention:A3"]')?.textContent).toBe('!A3');
      } finally {
        await view.unmount();
      }
    } finally {
      restoreClearInterval();
      restoreInterval();
    }
  });

  it('mounts the selected item as its card beside the inbox, with no chat around it', async () => {
    const posts: string[] = [];
    const todo = { ...externalAttentionItem, ask: { kind: 'task' }, steps: ['Plug the key in', 'Approve it'] };
    const { view } = await renderShell(`/d/${ALPHA}/attention`, [alpha.daemonId], {
      sessions: ['shared'],
      listedAttention: { open: 1, first: 'A3', ask: 'task', latestAt: '2026-07-31T11:30:00.000Z' },
      sessionState: { attention: { open: 1, first: 'A3', ask: 'task', latestAt: '2026-07-31T11:30:00.000Z' } },
      attention: sessionId => attentionSnapshot(sessionId, [todo as typeof externalAttentionItem]),
      attentionPosts: posts,
      messages: () => [
        { role: 'assistant', text: 'Paired the laptop.' },
        { role: 'user', text: 'ok' },
        { role: 'assistant', text: 'Raised !A3 for the key.' },
      ],
    });
    try {
      for (let turn = 0; turn < 6; turn += 1) await settle();
      const pane = must(view.container.querySelector<HTMLElement>('[data-attention-pane]'), 'the card pane');
      expect(pane.querySelector('[data-attention-card]')?.getAttribute('data-attention-card')).toBe('A3');
      expect(view.container.querySelector('[data-attention-chat]')).toBeNull();
      // The fold reads the ferret's own words through the session messages route.
      await interact(() =>
        must(pane.querySelector<HTMLButtonElement>('[data-attention-recent-toggle]'), 'the fold').click(),
      );
      for (let turn = 0; turn < 4; turn += 1) await settle();
      expect([...pane.querySelectorAll('[data-attention-recent-message]')].map(message => message.textContent)).toEqual(
        ['Paired the laptop.', 'Raised !A3 for the key.'],
      );
      // A step ticks on the machine the card came from.
      await interact(() =>
        must(pane.querySelector<HTMLInputElement>('input[type="checkbox"]'), 'the first step').click(),
      );
      for (let turn = 0; turn < 4; turn += 1) await settle();
      expect(posts.some(post => post.startsWith('shared:') && post.includes('"progress"'))).toBe(true);
    } finally {
      await view.unmount();
    }
  });

  it('publishes a lifecycle result and immediately refreshes its daemon-scoped evidence', async () => {
    const { reads, transcriptReads, view } = await renderShell(`/d/${ALPHA}/session/shared`, [alpha.daemonId]);
    try {
      await settle();
      // Interrupt is on the session bar at every width, so this transport test does not depend on the
      // process-global viewport.
      const interrupt = view.container.querySelector<HTMLButtonElement>('button[aria-label="Interrupt turn"]');
      await interact(() => must(interrupt, 'the interrupt control').click());
      await settle();

      expect(reads).toEqual([`${ALPHA}:shared`, `${ALPHA}:shared`]);
      expect(transcriptReads).toEqual([`${ALPHA}:shared`, `${ALPHA}:shared`]);
    } finally {
      await view.unmount();
    }
  });

  it('mounts every daemon-qualified destination through its own slot', async () => {
    const { view } = await renderShell(`/d/${ALPHA}`, [alpha.daemonId], { sessions: ['one'] });
    await settle();
    const announced = () => must(view.container.querySelector('[data-route]'), 'the route announcer').textContent;

    expect(announced()).toBe('Sessions');

    for (const [path, expected] of [
      [`/d/${ALPHA}/new`, 'Sessions, New'],
      [`/d/${ALPHA}/settings`, 'Sessions, Settings'],
      // No `/d/${ALPHA}/accounts` row: Accounts is Fleet's child panel inside Settings now, so it has no
      // address and no crumb of its own. The scope comes from the path taken to it, which is the
      // defect this replaced — the crumb it used to have named the page and never the machine.
      [`/d/${ALPHA}/warden`, 'Sessions, Warden'],
      [`/d/${ALPHA}/analytics`, 'Sessions, Analytics'],
      [`/d/${ALPHA}/learning`, 'Sessions, Learning'],
      [`/d/${ALPHA}/attention`, 'Sessions, Attention'],
      [`/d/${ALPHA}/history`, 'Sessions, Imported history'],
      [`/d/${ALPHA}/session/one`, 'Sessions, one'],
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

  /**
   * A NEW-SESSION PAGE LOAD READS THE STORED VERDICTS AND TRIGGERS NO CHECK.
   *
   * The page hydrates the runtimes and every login's stored status (`GET /v1/fleet/credentials`, a store
   * read the daemon answers without calling a provider), so each row shows its health without anybody
   * pressing anything. What it must never do on mount is CHECK: `POST /v1/fleet/credentials/:id/check`
   * is reached only from the Check now control.
   *
   * WHAT THIS TEST CANNOT PROVE: it observes HTTP only, so it is not the guard against a spend
   * regression. That guard is `packages/daemon/tests/integration/runtime/boot-lifecycle.test.ts`.
   */
  it('mounts the runtime field and the folder picker for a new session, reading stored health and checking nothing', async () => {
    const { healthReads, view } = await renderShell(`/d/${ALPHA}/new`, [alpha.daemonId]);
    try {
      await settle();
      // This harness publishes no runtimes, so the roster read fails and the runtime is typed; the buttons
      // themselves are exercised by the Launch-link tests below and by new-session-page.test.tsx.
      expect(view.container.querySelector('#fy-new-session-agent')?.getAttribute('role')).toBeNull();
      expect(view.container.querySelector('#fy-new-session-cwd')?.getAttribute('role')).toBe('combobox');
      const paths = healthReads.map(read => read.path);
      expect(paths).toContain('/v1/fleet/runtimes');
      expect(paths).toContain('/v1/fleet/credentials');
      expect(paths.filter(path => path.endsWith('/check'))).toEqual([]);
    } finally {
      await view.unmount();
    }
  });

  describe('a Launch link to the New session page', () => {
    const pickerAccount = (wrapper: string, available = true) => ({
      id: `${wrapper}-id`,
      name: wrapper,
      wrapper,
      harness: 'claude',
      credential: { id: `login-${wrapper}`, store: 'host' },
      profile: 'Default',
      agent: true,
      stack: {
        harness: 'claude',
        available: { available: true },
        applied: [],
        skipped: [],
        conflicts: [],
        partial: [],
      },
      modelSet: { source: 'harness-default' },
      launch: available ? { available: true } : { available: false, reason: 'Sign in to launch' },
      sameAs: [],
    });
    const roster = [pickerAccount('claude-auto-first'), pickerAccount('claude-auto-named')];
    const chosenRuntime = (container: HTMLElement): string | undefined =>
      [...container.querySelectorAll<HTMLInputElement>('input[name="fy-new-session-runtime"]')].find(
        radio => radio.checked,
      )?.value;

    afterEach(() => setPath('/'));

    it('selects the runtime named by ?agent= on its button, and starts nothing', async () => {
      const { view } = await renderShell(`/d/${ALPHA}/new?agent=claude-auto-named`, [alpha.daemonId], {
        accounts: roster,
      });
      try {
        await settle();
        expect(chosenRuntime(view.container)).toBe('claude-auto-named');
        expect(view.container.querySelector('[data-route]')?.textContent).toBe('Sessions, New');
      } finally {
        await view.unmount();
      }
    });

    it('falls back to the first usable runtime when there is no hint, an empty one, or one it cannot use', async () => {
      const accounts = [pickerAccount('claude-auto-first'), pickerAccount('claude-auto-down', false)];
      for (const search of ['', '?agent=', '?agent=claude-auto-down', '?agent=claude-auto-nobody']) {
        const { view } = await renderShell(`/d/${ALPHA}/new${search}`, [alpha.daemonId], { accounts });
        try {
          await settle();
          expect(chosenRuntime(view.container)).toBe('claude-auto-first');
        } finally {
          await view.unmount();
        }
      }
    });
  });

  it('opens a finished investigation’s complete report through the daemon that ran it', async () => {
    // Arrange
    const { view } = await renderShell(`/d/${ALPHA}/warden`, [alpha.daemonId], {
      wardenStatus: async () =>
        wardenStatus({
          lastSweepAt: '2026-07-31T11:59:00.000Z',
          investigations: [
            wardenInvestigation({
              id: 'warden-a',
              state: 'done',
              targetSession: 'session-a',
              verdict: 'needs_human',
              reportPath: '/state/warden/reports/session-a.md',
            }),
          ],
        }),
    });
    try {
      await settle();
      const report = must(
        [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(
          button => button.textContent === 'Report',
        ),
        'the investigation’s Report button',
      );

      // Act
      await interact(() => report.click());
      await settle();

      // Assert
      expect(view.container.textContent).toContain(`Evidence from /state/warden/reports/session-a.md on ${ALPHA}`);
    } finally {
      await view.unmount();
    }
  });

  it('keeps who needs you after a failed refresh, but calls it stale rather than an all-clear', async () => {
    // Arrange
    let reads = 0;
    // EVERY half-minute refresh on the page, run together: the sessions bar keeps its own list fresh on
    // an interval too, and which of the Warden page's own timers registers last is a mount-order detail
    // this test is not about.
    const halfMinute: (() => void)[] = [];
    const poll = (): void => {
      for (const callback of halfMinute) callback();
    };
    const restoreInterval = patchGlobal(globalThis, 'setInterval', (callback: () => void, milliseconds?: number) => {
      if (milliseconds === WARDEN_REFRESH_MS) halfMinute.push(callback);
      return 1;
    });
    const restoreClearInterval = patchGlobal(globalThis, 'clearInterval', () => {});
    const attention = async (): Promise<WardenAttentionView> => {
      reads += 1;
      if (reads > 1) throw new Error('the feed is temporarily unavailable');
      return wardenAttention({ outcome: 'items', items: [attentionItem({ sessionId: 'session-a' })] });
    };

    try {
      const { view } = await renderShell(`/d/${ALPHA}/warden`, [alpha.daemonId], { wardenAttention: attention });
      try {
        await settle();
        expect(view.container.textContent).toContain('Which relay? — Waiting for your answer.');

        // Act
        await interact(() => poll());
        await settle();

        // Assert
        expect(view.container.textContent).toContain(
          'Can’t refresh who needs you (the feed is temporarily unavailable)',
        );
        expect(view.container.textContent).toContain('Which relay? — Waiting for your answer.');
        expect(view.container.textContent).not.toContain('Nothing is waiting on you right now.');
      } finally {
        await view.unmount();
      }
    } finally {
      restoreClearInterval();
      restoreInterval();
    }
  });
});

/* ---------- F5: route changes are announced and take focus ---------------- */

describe('route change accessibility', () => {
  it('leaves the load-time focus alone and still names the page it opened on', async () => {
    const { view } = await renderShell(`/d/${ALPHA}`, [alpha.daemonId]);
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
    setPath(`/d/${ALPHA}`);
    const view = await mountShell(
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

    await popTo(`/d/${ALPHA}/settings`);
    await settle();
    expect(document.activeElement).toBe(announcer);
    await view.unmount();
  });

  it('moves focus to the announcer on an in-app navigation and renames it', async () => {
    const { view } = await renderShell(`/d/${ALPHA}`, [alpha.daemonId]);
    await settle();
    const announcer = must(view.container.querySelector('[data-route]'), 'the route announcer');

    await popTo(`/d/${ALPHA}/settings`);
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
    const { view } = await renderShell(`/d/${ALPHA}/session/shared`, [alpha.daemonId], { sessionGate: gate });
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

  it('carries the stream’s live samples to the working line of the session it belongs to', async () => {
    const turn = '2026-08-01T09:59:00.000Z';
    const { liveFeeds, view } = await renderShell(`/d/${ALPHA}/session/shared`, [alpha.daemonId], {
      sessionState: { status: 'running', turn: 2, turnState: 'working', turnStateAt: turn },
    });
    await settle();
    const feed = must(liveFeeds[0], 'the live event subscription');
    expect(feed.asksForLive).toBe(true);
    const figures = () => view.container.querySelector('.fy-live-activity-detail');
    expect(figures()?.getAttribute('data-live-input')).toBeNull();

    await interact(() =>
      feed.live({ sessionId: 'shared', at: '2026-08-01T10:00:00.000Z', turnStartedAt: turn, inputTokens: 48_000 }),
    );
    await settle();

    expect(figures()?.getAttribute('data-live-input')).toBe('48000');
    expect(figures()?.textContent).toContain('↑ 48k');

    await view.unmount();
  });

  it('reports a failed open in the alert region without unmounting either one', async () => {
    const { view } = await renderShell(`/d/${ALPHA}/session/shared`, [alpha.daemonId], {
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
    const { view } = await renderShell(`/d/${ALPHA}/session/shared`, [alpha.daemonId], {
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
    const { view } = await renderShell(`/d/${ALPHA}/session/s1`, [alpha.daemonId]);
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

  /**
   * THE WHOLE-SHELL REQUEST LEDGER for one real session route.
   *
   * The focused provider tests count requests around a provider mounted by hand.
   * This counts them around the app the reader actually loads, which is the only
   * place a second dial from some other surface would show up: `/v1/sessions/:id/tasks`
   * is reached from exactly one place in the PWA, so these counts are exact
   * rather than lower bounds.
   */
  it('reads one board and one file index for the session route, and neither fan-out returns', async () => {
    const { carrierRequests, view } = await renderShell(`/d/${ALPHA}/session/s1`, [alpha.daemonId]);
    await settle();
    // Counted on the CARRIER: these reads used to dial the daemon's address directly.
    const mine = carrierRequests
      .map(raw => new URL(raw, 'https://fixture.example.test'))
      .filter(url => url.pathname.startsWith('/v1/sessions/s1/'));

    expect(mine.filter(url => url.pathname.endsWith('/tasks') && !url.searchParams.has('q'))).toHaveLength(1);
    expect(mine.filter(url => url.pathname.endsWith('/fs/index'))).toHaveLength(1);
    // The N+1 detail fan-out and the browser-side breadth-first crawl.
    expect(mine.filter(url => /\/tasks\/[^/]+$/u.test(url.pathname))).toHaveLength(0);
    expect(mine.filter(url => url.pathname.endsWith('/fs'))).toHaveLength(0);
    // Nothing was typed, so no narrowing was earned.
    expect(mine.filter(url => url.searchParams.has('q'))).toHaveLength(0);

    await view.unmount();
  });

  it('reaches the search from inside the composer, which is where a session reader stands', async () => {
    const { view } = await renderShell(`/d/${ALPHA}/session/s1`, [alpha.daemonId]);
    await settle();
    const search = must(
      view.container.querySelector<HTMLInputElement>('[data-current-session-search] input'),
      'the current-session search input',
    );

    // The REAL COMPOSER field (the live editor, in the default editor style),
    // not an unrelated element appended by the test: session search
    // deliberately claims this editable context and no other one.
    const composer = must(
      view.container.querySelector<HTMLElement>('form.fy-composer [data-live-editor]'),
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
    const { view } = await renderShell(`/d/${ALPHA}/session/s1`, [alpha.daemonId]);
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
    const { view } = await renderShell(`/d/${ALPHA}/session/s1`, [alpha.daemonId]);
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

    // A keyboard-owning surface (the remote browser view) gets Cmd+K for the page it shows.
    const surface = document.createElement('div');
    surface.setAttribute('data-keyboard-capture', '');
    surface.tabIndex = -1;
    document.body.appendChild(surface);
    surface.focus();
    const captured = new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true });
    await interact(() => surface.dispatchEvent(captured));
    expect(captured.defaultPrevented).toBe(false);
    expect(search.getAttribute('aria-expanded')).toBe('false');
    surface.remove();

    rename.remove();
    dialog.remove();
    await view.unmount();
  });

  it('opens from a keystroke that belongs to no field', async () => {
    const { view } = await renderShell(`/d/${ALPHA}`, [alpha.daemonId]);
    await settle();
    expect(paletteOpen(view.container)).toBe(false);

    await interact(() => pressKey(document.body, 'k', { ctrlKey: true }));

    expect(paletteOpen(view.container)).toBe(true);
    await view.unmount();
  });

  it('accepts the platform modifier in either spelling and either case', async () => {
    const { view } = await renderShell(`/d/${ALPHA}`, [alpha.daemonId]);
    await settle();

    await interact(() => pressKey(document.body, 'K', { metaKey: true }));

    expect(paletteOpen(view.container)).toBe(true);
    await view.unmount();
  });

  it('leaves the keystroke to the field the reader is typing in', async () => {
    const { view } = await renderShell(`/d/${ALPHA}`, [alpha.daemonId]);
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
    const { view } = await renderShell(`/d/${ALPHA}`, [alpha.daemonId]);
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
    const { view } = await renderShell(`/d/${ALPHA}`, [alpha.daemonId]);
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

/**
 * The finder, or a failure that says WHY it is not there.
 *
 * "expected the destination finder to be present" is true and useless: the button is absent from a
 * shell that rendered the not-paired fallback instead of the workspace, and absent again from a
 * workspace whose app bar decided it was on a phone — `AppBar` only lays out the destination row when
 * `useLayoutMode` reads a viewport at least 768px wide. Those are opposite defects with one symptom, so
 * the absence reports the measured viewport, whether the app bar rendered at all, whether the
 * destination row did, and what the shell actually says. It was the SECOND of those that turned out to
 * be true, and reading it off a CI log took one push.
 */
const finderButton = (container: HTMLElement): HTMLButtonElement =>
  must(
    container.querySelector<HTMLButtonElement>('[data-app-bar-destination-search]'),
    `the destination finder (window.innerWidth ${window.innerWidth}, app bar ${
      container.querySelector('header') === null ? 'absent' : 'present'
    }, destination row ${
      container.querySelector('[data-app-bar-destination-row]') === null ? 'absent' : 'present'
    }, shell reads ${JSON.stringify(container.textContent?.slice(0, 160) ?? '')})`,
  );

describe('the global destination and settings finder', () => {
  it('finds an individual setting by a keyword that is in neither its label nor its description', async () => {
    const { view } = await renderShell(`/d/${ALPHA}`, [alpha.daemonId]);
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
    const { view } = await renderShell(`/d/${ALPHA}`, [alpha.daemonId]);
    await settle();
    await interact(() => pressKey(document.body, 'k', { ctrlKey: true }));
    await searchPalette('preferences');

    await pressPaletteRow('open-settings');

    expect(window.location.pathname).toBe(`/d/${ALPHA}/settings`);
    expect(window.location.hash).toBe('');
    await view.unmount();
  });

  it('reaches an app destination through the same search', async () => {
    const { view } = await renderShell(`/d/${ALPHA}`, [alpha.daemonId]);
    await settle();
    await interact(() => pressKey(document.body, 'k', { ctrlKey: true }));
    await searchPalette('warden');

    await pressPaletteRow('destination-warden');

    expect(window.location.pathname).toBe(`/d/${ALPHA}/warden`);
    await view.unmount();
  });

  it('stops promising Cmd/Ctrl+K once a session owns it', async () => {
    const { view } = await renderShell(`/d/${ALPHA}/session/s1`, [alpha.daemonId]);
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
    const { view } = await renderShell(`/d/${ALPHA}`, [alpha.daemonId]);
    await settle();

    expect(finderButton(view.container).getAttribute('aria-keyshortcuts')).not.toBeNull();
    await view.unmount();
  });

  it('opens from a pull on a destination that carries no pull marker at all', async () => {
    // Settings names nothing about this gesture, which is the point: the region
    // finds the page's scroll port from the touch, so a destination added later
    // is reachable without being listed anywhere.
    const { view } = await renderShell(`/d/${ALPHA}/settings`, [alpha.daemonId]);
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
    const { view } = await renderShell(`/d/${ALPHA}/session/s1`, [alpha.daemonId]);
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
    const { view } = await renderShell(`/d/${ALPHA}`, [alpha.daemonId], { sessions: ['s1'] });
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
    const notification = showOnPage('Alpha stopped', {
      ...notificationBrand(),
      body: 'body',
      tag: 'tag',
      renotify: false,
    });

    expect(FakeNotification.shown).toEqual(['Alpha stopped']);
    surface.navigate(`/d/${ALPHA}/session/one`);
    expect(navigated).toEqual([`/d/${ALPHA}/session/one`]);
    expect(notification).toBeDefined();
  });
});

describe('browserPushEnrolment', () => {
  const undo: (() => void)[] = [];
  afterEach(() => {
    while (undo.length > 0) undo.pop()?.();
  });

  const supportPush = (container: Record<string, unknown>): void => {
    undo.push(patchGlobal(globalThis, 'isSecureContext', true));
    undo.push(patchGlobal(navigator, 'serviceWorker', container));
    undo.push(patchGlobal(window, 'PushManager', class {}));
  };

  it('declines where this browser cannot do Web Push at all', () => {
    // No secure context, no container, no PushManager: the ordinary state of
    // this suite's document, and of any plain-HTTP page.
    expect(browserPushEnrolment(String)).toBeNull();
  });

  it('declines in a secure context that still has no push manager', () => {
    undo.push(patchGlobal(globalThis, 'isSecureContext', true));
    undo.push(patchGlobal(navigator, 'serviceWorker', { getRegistrations: async () => [] }));

    expect(browserPushEnrolment(String)).toBeNull();
  });

  it('registers the signed worker once per daemon, at that daemon’s scope, under the reader’s label', async () => {
    const registered: { url: string; scope: string }[] = [];
    const registration = {
      scope: `${window.location.origin}/push/alpha/`,
      active: { state: 'activated', scriptURL: '' },
      installing: null,
      waiting: null,
      pushManager: { getSubscription: async () => null, subscribe: async () => ({}) },
      unregister: async () => true,
    };
    supportPush({
      register: async (url: string, options: { scope: string }) => {
        registered.push({ url, scope: options.scope });
        return registration;
      },
      getRegistrations: async () => [registration],
    });

    const enrolment = must(
      browserPushEnrolment(daemon => `label for ${daemon}`),
      'the push enrolment',
    );

    expect(await enrolment.register(daemonId('alpha'))).toBe(registration as never);
    expect(registered).toEqual([{ url: '/sw.verified.js?machine=label%20for%20alpha', scope: '/push/alpha/' }]);
    expect(await enrolment.existing(daemonId('alpha'))).toBe(registration as never);
    // The name is what a reader revokes by, on the daemon's device list.
    expect(enrolment.deviceName()).toBe('Ferretry PWA');
  });
});

describe('one push worker per paired machine', () => {
  const undo: (() => void)[] = [];
  afterEach(() => {
    while (undo.length > 0) undo.pop()?.();
  });

  const records = [
    { ...alpha, label: 'Work laptop', pairedAt: 1, lastSelectedAt: 1 },
    { ...beta, pairedAt: 2, lastSelectedAt: 2 },
  ];

  it('titles a machine’s worker with the reader’s label, else its id — never the address it chose itself', () => {
    const betaName = `Machine ${String(beta.daemonId).slice(0, 12)}`;
    expect(pushMachineLabel(records, alpha.daemonId)).toBe('Work laptop');
    expect(pushMachineLabel(records, beta.daemonId)).toBe(betaName);
    expect(pushMachineLabel(records, beta.daemonId)).not.toContain(beta.baseUrl);
    expect(pushMachineLabel([{ ...records[0], label: '   ' } as never], alpha.daemonId)).toBe(
      `Machine ${String(alpha.daemonId).slice(0, 12)}`,
    );
    expect(pushMachineLabel(records, daemonId('gone'))).toBe('Machine gone');
    expect(pairedPushMachines(records)).toEqual([
      { daemonId: alpha.daemonId, label: 'Work laptop' },
      { daemonId: beta.daemonId, label: betaName },
    ]);
  });

  it('reconciles the push workers against what this browser pairs with, on open', async () => {
    const listed: string[] = [];
    undo.push(patchGlobal(globalThis, 'isSecureContext', true));
    undo.push(
      patchGlobal(navigator, 'serviceWorker', {
        // The release checker and the update chip share this container; neither gets a worker here.
        controller: null,
        ready: new Promise(() => undefined),
        getRegistration: async () => undefined,
        addEventListener: () => undefined,
        // The notification-tap listener (`useNotificationOpen`) is removed again when the shell unmounts.
        removeEventListener: () => undefined,
        register: async () => {
          throw new Error('no worker in this suite');
        },
        getRegistrations: async () => {
          listed.push('listed');
          return [];
        },
      }),
    );
    undo.push(patchGlobal(window, 'PushManager', class {}));

    const { view } = await renderShell('/', [alpha.daemonId]);
    try {
      await settle();
      expect(listed.length).toBeGreaterThan(0);
    } finally {
      await view.unmount();
    }
  });
});

/* ---------- the picker, the settings host, and the public root ------------ */

describe('the settings route composition', () => {
  /** One of the Machine tab's connection and security rows. `#daemons` lands on that tab. */
  const openPanel = async (view: { readonly container: HTMLElement }, id: string, what = `the ${id} panel row`) => {
    await interact(() =>
      must(view.container.querySelector<HTMLButtonElement>(`[data-daemon-panel="${id}"]`), what).click(),
    );
    await settle();
  };

  /**
   * The panel the icon table can most easily be missing an entry for, through the REAL composition.
   *
   * Model pricing does not come from the frame's own tab list — the composition root passes it in
   * `additionalTabs` — so it is the row that regresses when somebody adds a panel and not its glyph.
   * This assertion used to be `toBeNull()`, back when three of the ten rows had an icon and the rest
   * were called deliberately iconless; a row without one does not indent its label, so the rail's left
   * edge alternated between two x positions and the list read as unfinished. All of them or none.
   */
  it('mounts the Model pricing tab, with its icon, through the production Settings composition', async () => {
    const { view } = await renderShell(`/d/${ALPHA}/settings#daemons`, [alpha.daemonId], SET_UP_SHELL);
    await settle();

    const tab = must(
      view.container.querySelector<HTMLButtonElement>('[data-daemon-panel="model-pricing"]'),
      'Model pricing tab',
    );

    expect(tab.textContent).toContain('Model pricing');
    expect(tab.querySelector('svg')).not.toBeNull();
    // Its OWN glyph, not the fallback the rail draws for an id the table does not name.
    expect(tab.querySelector('svg')?.getAttribute('class')).toContain('lucide-circle-dollar-sign');
    await view.unmount();
  });

  /**
   * Opens the Connection panel with a measured answer already on it.
   *
   * The fallback sentence exists only once something has been carried — before the
   * first request the panel honestly says nothing has — so the router is driven for
   * real rather than handed a fabricated choice.
   */
  const carrierPanelText = async (connection: DaemonConnection): Promise<string> => {
    const { store, view } = await renderShell(
      `/d/${String(connection.daemonId)}/settings#daemons`,
      [connection],
      SET_UP_SHELL,
    );
    await settle();
    await interact(async () => {
      // A pairing no session can address is unreachable on every carrier now, so this read is allowed
      // to fail: what is under test is what the panel PROMISES, not whether the read was carried.
      await store.carrier.send(connection, `${connection.baseUrl}/v1/health`).catch(() => undefined);
    });
    await openPanel(view, 'carrier', 'the Connection panel tab');
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
  /**
   * §15 "The choice", through the real composition: the same per-machine value is offered beside the
   * machine's Connection status and under This device › Connection, and a pick in either is this
   * device's preference for that machine.
   */
  it('keeps this device’s connection preference from the Connection panel and from This device', async () => {
    const { store, view } = await renderShell(`/d/${ALPHA}/settings#daemons`, [alpha.daemonId], SET_UP_SHELL);
    await settle();
    await openPanel(view, 'carrier', 'the Connection panel tab');

    const relayOnly = must(
      view.container.querySelector<HTMLInputElement>('[data-carrier-preference-control] input[value="relay"]'),
      'Relay only on the Connection panel',
    );
    await interact(() => relayOnly.click());
    await settle();
    expect(store.carrierPreferences.preference(alpha.daemonId)).toBe('relay');
    // This suite's build has no relay directory, so "Tunnel only" says the operator has not set it up.
    expect(view.container.textContent).toContain('Not set up by the operator.');
    await view.unmount();

    const device = await renderShell(`/d/${ALPHA}/settings#device`, [alpha.daemonId], SET_UP_SHELL);
    await settle();
    const preferences = must(
      device.view.container.querySelector<HTMLElement>('[data-setting-id="connection-preference"]'),
      'This device › Connection',
    );
    const tunnelOnly = must(
      preferences.querySelector<HTMLInputElement>('input[value="tunnel"]'),
      'Tunnel only under This device',
    );
    await interact(() => tunnelOnly.click());
    await settle();
    expect(device.store.carrierPreferences.preference(alpha.daemonId)).toBe('tunnel');
    await device.view.unmount();
  });

  /**
   * A tunnel is opt-in (§15), so a preference that walks one is OFFERED a switch under the group — and the
   * machine, not this browser, is what is switched: the request is the daemon's own `PUT /v1/tunnel`.
   */
  it('turns the machine’s tunnel on from the offer under its Connection preference', async () => {
    let enabled = false;
    const changes: boolean[] = [];
    const tunnelSwitch = (change: boolean | undefined): TunnelStatusView => {
      if (change !== undefined) {
        changes.push(change);
        enabled = change;
      }
      return enabled
        ? {
            enabled,
            explicit: true,
            state: 'up',
            tunnelUrl: 'https://alpha-tunnel.example.test',
            sentence: 'Tunnel: up',
          }
        : { enabled, explicit: false, state: 'off', tunnelUrl: null, sentence: TUNNEL_OFF_SENTENCE };
    };
    const { view } = await renderShell(`/d/${ALPHA}/settings#daemons`, [alpha.daemonId], {
      ...SET_UP_SHELL,
      tunnelSwitch,
    });
    try {
      await settle();
      await openPanel(view, 'carrier', 'the Connection panel tab');
      const tunnelOnly = must(
        view.container.querySelector<HTMLInputElement>('[data-carrier-preference-control] input[value="tunnel"]'),
        'Tunnel only on the Connection panel',
      );
      await interact(() => tunnelOnly.click());
      await settle();
      const offer = must(view.container.querySelector<HTMLElement>('[data-tunnel-offer]'), 'the tunnel offer');
      expect(offer.textContent).toContain('Turn on a Cloudflare tunnel for this machine?');
      expect(changes).toEqual([]);

      await interact(() =>
        must(
          [...offer.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Turn on'),
          'the offer’s Turn on button',
        ).click(),
      );
      await settle();

      expect(changes).toEqual([true]);
      expect(view.container.querySelector('[data-tunnel-offer]')).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  /**
   * Only WebRTC measures its own path, and the number is read from THIS machine's pairing: the panel
   * asks the store for the round trip of the daemon it is showing and prints what comes back.
   */
  it('shows the round trip the store measures for this machine when a WebRTC carrier is live', async () => {
    const carrierSeam = measuredCarrierSeam();
    const asked: DaemonId[] = [];
    const { view } = await renderShell(`/d/${ALPHA}/settings#daemons`, [alpha.daemonId], {
      ...SET_UP_SHELL,
      carrierSeam,
      webrtcRttMs: async daemonId => {
        asked.push(daemonId);
        return daemonId === alpha.daemonId ? 23 : undefined;
      },
    });
    try {
      await settle();
      await interact(() => carrierSeam.publish(chooseCarrier([{ method: { kind: 'webrtc' }, reachable: true }])));
      await openPanel(view, 'carrier', 'the Connection panel tab');

      expect(asked).toContain(alpha.daemonId);
      expect(view.container.querySelector('[data-carrier-rtt]')?.textContent).toBe('Round trip: 23 ms');
    } finally {
      await view.unmount();
    }
  });

  it('names the missing fallback when the router would strip this pairing’s relay', async () => {
    expect(await carrierPanelText(alphaRelayed)).toContain(CARRIER_NO_FALLBACK);
  });

  it('stays silent about a fallback the router would actually dial', async () => {
    expect(await carrierPanelText(gammaRelayed)).not.toContain(CARRIER_NO_FALLBACK);
  });

  it('binds the Doctor tab to the selected daemon through the typed diagnostic endpoint', async () => {
    const { healthReads, view } = await renderShell(`/d/${ALPHA}/settings#daemons`, [alpha.daemonId], SET_UP_SHELL);
    await settle();

    await openPanel(view, 'doctor', 'Doctor tab');

    const doctorRead = healthReads.find(read => read.path === '/v1/doctor');
    expect(doctorRead?.daemonId).toBe(alpha.daemonId);
    expect(doctorRead?.schema).toBe(DoctorReportSchema);
    expect(view.container.textContent).toContain('Required dependencies are present.');
    await view.unmount();
  });

  it('mounts Settings › Learning for the selected machine, reading through its carrier', async () => {
    const { carrierRequests, view } = await renderShell(`/d/${ALPHA}/settings#daemons`, [alpha.daemonId], SET_UP_SHELL);
    await settle();

    await openPanel(view, 'learning', 'Learning tab');

    expect(view.container.textContent).toContain('Passive learning for new ferrets');
    expect(carrierRequests).toContain('https://alpha.example.test/v1/learning/config');
    await view.unmount();
  });

  it('probes each selected machine’s Host checks through the carrier-aware typed health endpoint, then routes switch and add', async () => {
    const { healthReads, store, view } = await renderShell(
      `/d/${ALPHA}/settings#daemons`,
      [alpha.daemonId, beta.daemonId],
      SET_UP_SHELL,
    );
    await settle();
    // The new-device notice reads every paired machine's device list in the background, by design;
    // its own suite proves that is the ONLY thing it reads, so dropping it here hides nothing else.
    // Settings also asks every paired machine once whether it answers (`/v1/fleet/machine`), so the
    // sidebar can show each one's status, and a machine's tabs read its setup (`/v1/fleet/...`). Those are
    // the account model's reads, proved in their own suites; this test is about the health probe. The
    // shell also asks the machine on screen whether it may offer "Pair a phone" (`/v1/grants`), and the
    // machine list asks each machine once whether it — or an agent CLI it runs — has an update, for its dot
    // (`/v1/daemon/update`, `/v1/harnesses/update`), and the Machine tab reads machine.yaml (`/v1/config/file`).
    const probes = () =>
      healthReads.filter(
        read =>
          read.path !== '/v1/pair/devices' &&
          read.path !== '/v1/grants' &&
          read.path !== '/v1/daemon/update' &&
          read.path !== '/v1/harnesses/update' &&
          !read.path.startsWith('/v1/fleet/') &&
          !read.path.startsWith('/v1/config/file?'),
      );

    // A daemon tab does not read another daemon merely by being visible. Opening
    // Host checks is the explicit request, and it travels through the same typed
    // client (and therefore carrier router) as every other daemon read.
    expect(probes()).toEqual([]);
    await openPanel(view, 'host-checks', 'alpha host checks tab');
    expect(probes().map(read => String(read.daemonId))).toEqual([ALPHA]);
    for (const read of probes()) {
      expect(read.path).toBe('/v1/health');
      expect(read.schema).toBe(HealthViewSchema);
      expect(read.timeout).toBe(5_000);
    }
    expect(
      must(view.container.querySelector(`[data-settings-machine="${ALPHA}"]`), 'alpha sidebar row').getAttribute(
        'aria-current',
      ),
    ).toBe('page');

    await interact(() =>
      must(
        view.container.querySelector<HTMLButtonElement>(`[data-settings-machine="${BETA}"]`),
        'beta sidebar row',
      ).click(),
    );
    expect(store.connections.getSnapshot().selectedDaemonId).toBe(beta.daemonId);
    expect(window.location.pathname).toBe(`/d/${BETA}/settings`);
    expect(window.location.hash).toMatch(/^#machines\/[^/]+\/runtimes$/u);
    await settle();
    await interact(() =>
      must(view.container.querySelector<HTMLButtonElement>('[data-machine-tab="machine"]'), 'beta Machine tab').click(),
    );
    await settle();
    await openPanel(view, 'host-checks', 'beta host checks tab');
    expect(
      probes()
        .map(read => String(read.daemonId))
        .sort(),
    ).toEqual([ALPHA, BETA].sort());

    await interact(() =>
      must(view.container.querySelector<HTMLButtonElement>('[data-machine-add]'), 'add a machine').click(),
    );
    expect(window.location.pathname).toBe('/');
    expect(view.container.querySelector('h1')?.textContent).toBe('Your daemons');
    expect(view.container.textContent).toContain('Pair another daemon');
    await view.unmount();
  });

  it('persists a routed daemon rename and sends active removal to the selected fallback settings', async () => {
    const { store, view } = await renderShell(
      `/d/${ALPHA}/settings#daemons`,
      [alpha.daemonId, beta.daemonId],
      SET_UP_SHELL,
    );
    await settle();
    await openPanel(view, 'host-checks', 'alpha host checks tab');
    const alphaHostChecks = must(
      view.container.querySelector<HTMLElement>(`[data-daemon-host-checks="${ALPHA}"]`),
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
      must(view.container.querySelector<HTMLButtonElement>(`[data-remove-daemon="${ALPHA}"]`), 'remove alpha').click(),
    );
    expect(store.connections.get(alpha.daemonId)).toBeUndefined();
    expect(window.location.pathname).toBe(`/d/${BETA}/settings`);
    expect(window.location.hash).toBe('#machines');
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
    await landed(`/d/${GAMMA_ID}`);

    // The root must land on the daemon the exchange returned, not on whichever
    // pairing happened to be selected before.
    expect(window.location.pathname).toBe(`/d/${GAMMA_ID}`);
    // The new pairing joins the existing one and becomes the selected daemon.
    expect(store.connections.getSnapshot().connections.map(one => String(one.daemonId))).toEqual([GAMMA_ID, ALPHA]);
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
    await pairedInGuide(view.container);

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
    await landed(`/d/${GAMMA_ID}`);
    expect(window.location.pathname).toBe(`/d/${GAMMA_ID}`);
    await view.unmount();
  });

  it('opens the first run of a machine it just paired that is not set up, rather than its sessions', async () => {
    const { view } = await renderShell('/', [alpha.daemonId], { fleet: NOT_SET_UP });
    await popTo('/');
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
    await landed(`/d/${GAMMA_ID}/setup`);

    // The first run is a full screen of its own now, outside Settings.
    expect(window.location.pathname).toBe(`/d/${GAMMA_ID}/setup`);
    await view.unmount();
  });

  it('opens the first run from the guide’s last stage when the machine it paired is not set up', async () => {
    const { view } = await renderShell(`/pair#${GAMMA_FRAGMENT}`, [], { fleet: NOT_SET_UP });
    await interact(() =>
      must(
        [...view.container.querySelectorAll('button')].find(button => button.textContent?.includes('Pair this device')),
        'the confirmation control',
      ).click(),
    );
    await pairedInGuide(view.container);
    await interact(() =>
      must(view.container.querySelector<HTMLButtonElement>('[data-onboarding-open-fleet]'), 'the fleet action').click(),
    );
    await landed(`/d/${GAMMA_ID}/setup`);
    // The first run is a full screen of its own now, outside Settings.
    expect(window.location.pathname).toBe(`/d/${GAMMA_ID}/setup`);
    await view.unmount();
  });

  it('offers the camera only when the browser has both halves of a scan', async () => {
    const win = window as unknown as { BarcodeDetector?: unknown };
    // No camera API at all: no scan host, so the screen shows its paste field instead.
    expect(browserQrScan()).toBeNull();

    // WebKit: a camera but no `BarcodeDetector`. The software decoder gives it a host, which is what
    // lets a tap reach getUserMedia (and so the permission prompt).
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [] }) },
    });
    try {
      const webkit = must(browserQrScan(), 'the software scan host');
      expect(webkit.supported).toBe(true);
      const stop = new AbortController();
      const scanning = webkit.scan({ show: () => ({ videoWidth: 0, videoHeight: 0 }), clear: () => {} }, stop.signal);
      const outcome = scanning.then(
        () => 'resolved',
        (error: { code?: string }) => error.code,
      );
      await new Promise(resolve => setTimeout(resolve, 20));
      stop.abort();
      await expect(outcome).resolves.toBe('cancelled');
    } finally {
      delete (navigator as { mediaDevices?: unknown }).mediaDevices;
    }

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

    expect(window.location.pathname).toBe(`/d/${ALPHA}`);
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
    const { store, view } = await renderShell(`/d/${ALPHA}`, [alpha.daemonId], {
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

    await moveTo('failed');

    // Delivered, and named after the session rather than the daemon: this is the
    // only assertion in the file that proves the whole chain — fleet diff, the
    // preference read, the surface, and the page-level constructor.
    expect(FakeNotification.shown).toEqual(['Session one']);

    await view.unmount();
  });

  it('stays silent on the same transition while the reader is looking at the page', async () => {
    const { moveTo, view } = await watchingShell(false);

    await moveTo('failed');

    // Nothing about the transition changed — only `document.hidden`. So a
    // notification here would mean the watch is reading some other visibility,
    // or none at all.
    expect(FakeNotification.shown).toEqual([]);

    await view.unmount();
  });
});

describe('the notifications settings card', () => {
  /**
   * Every machine sends every event now (the daemon no longer stores a preference); this device's
   * own four category switches, quiet hours, and the per-machine list are the only filter left, and
   * they live in `NotificationFilterSettingsView`, stacked under the per-daemon Web Push card.
   */
  const open = async () => {
    const { store, view } = await renderShell(`/d/${ALPHA}/settings#behaviour`, [alpha.daemonId, beta.daemonId]);
    await settle();
    const card = must(
      view.container.querySelector<HTMLElement>('[data-setting-id="notifications"]'),
      'the notifications settings card',
    );
    return { store, view, card };
  };

  const switches = (card: HTMLElement): HTMLElement[] => [...card.querySelectorAll<HTMLElement>('[role="switch"]')];

  it('flips exactly the category switch pressed, leaving the others on', async () => {
    const { store, view, card } = await open();

    const failedSwitch = must(
      switches(card).find(toggle => toggle.textContent?.includes('Failed')),
      'the Failed category switch',
    );
    expect(failedSwitch.getAttribute('aria-checked')).toBe('true');

    await interact(() => failedSwitch.click());

    expect(store.notificationFilter.get().categories).toEqual({
      'needs-you': true,
      finished: true,
      failed: false,
      'new-device': true,
    });

    await view.unmount();
  });

  it('reveals the two time inputs only once quiet hours is on, and reports a parsed minute', async () => {
    const { store, view, card } = await open();

    expect(card.querySelectorAll('input[type="time"]')).toHaveLength(0);
    const quietSwitch = must(
      switches(card).find(toggle => toggle.textContent?.includes('Quiet hours')),
      'the quiet-hours switch',
    );

    await interact(() => quietSwitch.click());

    expect(store.notificationFilter.get().quietHours.enabled).toBe(true);
    const start = must(card.querySelector<HTMLInputElement>('input[type="time"]'), 'the quiet-hours start time input');
    const setter = must(Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set, 'input setter');

    await interact(() => {
      setter.call(start, '22:30');
      start.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(store.notificationFilter.get().quietHours.startMinute).toBe(22 * 60 + 30);

    await view.unmount();
  });

  it('mutes exactly the other paired machine pressed, through the local filter only', async () => {
    const { store, view, card } = await open();

    expect(store.notificationFilter.get().machines[beta.daemonId]).toBeUndefined();
    const betaRow = must(
      card.querySelector<HTMLElement>(`[data-machine-notification="${beta.daemonId}"]`),
      'the per-machine row for beta',
    );
    const machineSwitch = must(
      [...betaRow.querySelectorAll<HTMLElement>('[data-machine-mute]')][0],
      'the per-machine mute switch for beta',
    );
    expect(machineSwitch.getAttribute('aria-pressed')).toBe('false');

    await interact(() => machineSwitch.click());

    expect(store.notificationFilter.get().machines).toEqual({ [beta.daemonId]: false });
    // The active connection's own Web Push master switch — a different control entirely — is untouched.
    expect(store.notificationPreferences.get(alpha.daemonId).enabled).toBe(false);

    await view.unmount();
  });
});

describe('App', () => {
  it('mounts the public root with its own router and store', async () => {
    setPath('/');
    const view = await mountShell(<App />);
    await settle();

    expect(view.container.querySelector('h1')?.textContent).toBe('Set up Ferretry');
    // What a reader HEARS names the screen they are actually on.
    expect(must(view.container.querySelector('[data-route]'), 'the route announcer').textContent).toBe('Set up');
    await view.unmount();
  });

  it('registers the release checker and shows its notice when an update was refused', async () => {
    // Arrange: a secure page whose active worker answers every check with a refusal.
    const undo: (() => void)[] = [];
    // B7: the notice floated over the page and hid its first card at 390px. Its measured height is room
    // the shell keeps, so a dock this tall must publish exactly that.
    const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.hasAttribute('data-release-notice-dock') ? 132 : 0;
      },
    });
    undo.push(() => {
      if (offsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeight);
      else Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight');
    });
    const registered: string[] = [];
    const active = {
      scriptURL: '/sw.verified.js',
      postMessage: (message: { type?: string }, [port]: { postMessage?: never }[]) => {
        const reply =
          message.type === 'fy-release-check'
            ? { type: 'fy-release-outcome', outcome: { status: 'refused', refusal: 'bad-signature', hadRelease: true } }
            : null;
        queueMicrotask(() =>
          (port as unknown as { onmessage?: (event: { data: unknown }) => void }).onmessage?.({ data: reply }),
        );
      },
    };
    const registration = {
      active,
      installing: null,
      waiting: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      update: async () => undefined,
    };
    class Channel {
      readonly port1: { onmessage: ((event: { data: unknown }) => void) | null; close: () => void } = {
        onmessage: null,
        close: () => undefined,
      };
      get port2() {
        return this.port1;
      }
    }
    undo.push(patchGlobal(globalThis, 'isSecureContext', true));
    undo.push(patchGlobal(globalThis, 'MessageChannel', Channel));
    undo.push(
      patchGlobal(navigator, 'serviceWorker', {
        controller: {},
        ready: Promise.resolve(registration),
        register: async (url: string) => {
          registered.push(url);
          return registration;
        },
        getRegistration: async () => registration,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    );
    try {
      setPath('/');

      // Act
      const view = await mountShell(<App />);
      await settleUntil(
        () => view.container.querySelector('[data-release-notice]') !== null,
        'the release notice to appear',
        interact,
      );

      // Assert
      expect(registered).toEqual(['/sw.verified.js']);
      expect(must(view.container.querySelector('[data-release-notice]'), 'the release notice').textContent).toContain(
        'An update failed verification',
      );
      const inset = document.documentElement.style.getPropertyValue('--release-notice-h');
      await view.unmount();
      expect(inset).toBe('132px');
      expect(document.documentElement.style.getPropertyValue('--release-notice-h')).toBe('');
    } finally {
      while (undo.length > 0) undo.pop()?.();
    }
  });
});

describe('the full-screen machine setup route', () => {
  it('draws only the machine’s own setup at /d/<id>/setup, with no app bar and no tab bar', async () => {
    const { view } = await renderShell(`/d/${ALPHA}/setup`, [alpha.daemonId], { fleet: NOT_SET_UP });
    try {
      await settle();
      // A one-time guided job gets the whole screen: no level-one navigation of any kind.
      expect(view.container.querySelector(`[data-machine-setup="${ALPHA}"]`)).not.toBeNull();
      expect(view.container.querySelector('[data-density-region="app-bar"]')).toBeNull();
      expect(view.container.querySelector('[data-app-tab-bar]')).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('opens on the step named by the address hash, as Settings’ Import again does', async () => {
    const { view } = await renderShell(`/d/${ALPHA}/setup#claude`, [alpha.daemonId], { fleet: NOT_SET_UP });
    try {
      await settle();
      expect(view.container.querySelector('[data-onboarding-step-body="claude"]')).not.toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('ignores a hash that names no step and opens where the setup was', async () => {
    const { view } = await renderShell(`/d/${ALPHA}/setup#nowhere`, [alpha.daemonId], { fleet: NOT_SET_UP });
    try {
      await settle();
      expect(view.container.querySelector(`[data-machine-setup="${ALPHA}"]`)).not.toBeNull();
      expect(view.container.querySelector('[data-onboarding-step-body="claude"]')).toBeNull();
    } finally {
      await view.unmount();
    }
  });
});

/** The Warden page's refresh cadence. */
const WARDEN_REFRESH_MS = 30_000;

describe('the sessions bar', () => {
  it('words the reload offer as the app bar always has, warning only for a recovery', () => {
    expect(updateOffer('update')).toEqual({ ...UPDATE_CHIP.update, tone: 'accent' });
    expect(updateOffer('recovery')).toEqual({ ...UPDATE_CHIP.recovery, tone: 'warn' });
  });

  it('names the foot place every route belongs to', () => {
    const at = (kind: string) => sessionsBarPlace({ kind, daemonId: alpha.daemonId } as never);
    expect(
      ['projects', 'project-detail', 'analytics', 'warden', 'learning', 'settings', 'attention', 'sessions'].map(at),
    ).toEqual(['projects', 'projects', 'insights', 'insights', 'insights', 'settings', 'attention', null]);
  });

  it('opens the Sessions bar on Interactive for a device that never chose, and remembers the kind it picks', async () => {
    const { view, store } = await renderShell(`/d/${ALPHA}/settings`, [alpha.daemonId], {
      sessions: ['one'],
      sessionsMode: null,
    });
    try {
      await settle();
      const column = must(view.container.querySelector('[data-sessions-bar="column"]'), 'the sessions column');
      const pressed = (): string[] =>
        [...column.querySelectorAll('[data-sbar-filter][aria-pressed="true"]')].map(
          node => node.getAttribute('data-sbar-filter') as string,
        );
      expect(
        [...column.querySelectorAll('[data-sbar-filter]')].map(node => node.getAttribute('data-sbar-filter')),
      ).toEqual(['interactive', 'all', 'auto']);
      expect(pressed()).toEqual(['interactive']);
      expect(store.controls.snapshot().device.sessionsMode).toBeNull();

      await interact(() => (column.querySelector('[data-sbar-filter="auto"]') as HTMLElement).click());

      expect(pressed()).toEqual(['auto']);
      expect(store.controls.snapshot().device.sessionsMode).toBe('auto');
    } finally {
      await view.unmount();
    }
  });

  it('draws one-line rows until the reader picks Comfortable in the bar, and stores that device-wide', async () => {
    const { view, store } = await renderShell(`/d/${ALPHA}/settings`, [alpha.daemonId], { sessions: ['one'] });
    try {
      await settle();
      const column = must(view.container.querySelector('[data-sessions-bar="column"]'), 'the sessions column');
      expect(column.getAttribute('data-sbar-density')).toBe('compact');

      await interact(() => (column.querySelector('[data-sbar-options]') as HTMLElement).click());
      const comfortable = [...document.querySelectorAll('[role="menuitem"]')].find(node =>
        node.textContent?.includes('Comfortable'),
      );
      await interact(() => (must(comfortable ?? null, 'Comfortable') as HTMLElement).click());

      expect(store.controls.snapshot().device.density).toBe('full');
      expect(column.getAttribute('data-sbar-density')).toBe('comfortable');
    } finally {
      await view.unmount();
    }
  });

  it('lists every paired machine’s sessions, each read through its own pairing, unless the reader chose one', async () => {
    const { view, store } = await renderShell(`/d/${ALPHA}/settings`, [alpha.daemonId, beta.daemonId], {
      sessions: ['one'],
    });
    try {
      await settle();
      const column = must(view.container.querySelector('[data-sessions-bar="column"]'), 'the sessions column');
      // In the order they were paired; the same session id on both is two rows, each linking to its own machine.
      expect(
        [...column.querySelectorAll('[data-sbar-machine-group]')].map(node =>
          node.getAttribute('data-sbar-machine-group'),
        ),
      ).toEqual([ALPHA, BETA]);
      expect([...column.querySelectorAll('[data-sbar-session="one"]')].map(node => node.getAttribute('href'))).toEqual([
        `/d/${encodeURIComponent(ALPHA)}/session/one`,
        `/d/${encodeURIComponent(BETA)}/session/one`,
      ]);
      expect(store.fleet.fleet(beta.daemonId).sessions?.map(view => view.config.id)).toEqual(['one']);

      await interact(() => store.controls.setDeviceControls({ sessionsList: 'current' }));
      expect(view.container.querySelector('[data-sbar-machine-group]')).toBeNull();
      expect(view.container.querySelectorAll('[data-sessions-bar="column"] [data-sbar-session="one"]')).toHaveLength(1);
    } finally {
      await view.unmount();
    }
  });

  it('reorders the machines on this device from a heading menu, and the switcher and the list follow', async () => {
    const { view, store } = await renderShell(`/d/${ALPHA}/settings`, [alpha.daemonId, beta.daemonId], {
      sessions: ['one'],
    });
    try {
      await settle();
      const column = must(view.container.querySelector('[data-sessions-bar="column"]'), 'the sessions column');
      const groups = () =>
        [...column.querySelectorAll('[data-sbar-machine-group]')].map(node =>
          node.getAttribute('data-sbar-machine-group'),
        );
      expect(groups()).toEqual([ALPHA, BETA]);
      await interact(() =>
        must(
          column.querySelector<HTMLElement>(`[data-sbar-machine-group="${BETA}"] .fy-sbar__machine-more`),
          'the menu on the second machine',
        ).click(),
      );
      await interact(() =>
        must(
          [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === 'Move up'),
          'Move up',
        ).click(),
      );
      await settle();
      expect(groups()).toEqual([BETA, ALPHA]);
      expect(store.controls.snapshot().device.machineOrder).toEqual([BETA, ALPHA]);
      // The pairing record did not change: the order is this browser's preference alone.
      expect(store.connections.getSnapshot().connections.map(record => record.daemonId)).toContain(alpha.daemonId);
      await interact(() =>
        must(column.querySelector<HTMLElement>('[data-sbar-machine]'), 'the machine switcher').click(),
      );
      const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(item => item.textContent);
      expect(items.indexOf(items.find(text => text?.includes('beta')) ?? '')).toBeLessThan(
        items.indexOf(items.find(text => text?.includes('alpha')) ?? ''),
      );
    } finally {
      await view.unmount();
    }
  });

  it('opens another machine’s row as THAT machine, holds the list still, and marks every machine’s learners', async () => {
    // Both machines run a session called "one" and one called "two"; each machine says a different one learns.
    const { view, store } = await renderShell(`/d/${ALPHA}/settings`, [alpha.daemonId, beta.daemonId], {
      sessions: ['one', 'two'],
      learners: { 'alpha.example.test': ['one'], 'beta.example.test': ['two'] },
    });
    try {
      await settle();
      const column = must(view.container.querySelector('[data-sessions-bar="column"]'), 'the sessions column');
      const groups = () =>
        [...column.querySelectorAll('[data-sbar-machine-group]')].map(node =>
          node.getAttribute('data-sbar-machine-group'),
        );
      const row = (daemon: string, id: string) =>
        must(
          column.querySelector<HTMLElement>(`[data-sbar-machine-group="${daemon}"] [data-sbar-session="${id}"]`),
          `${id} on ${daemon}`,
        );
      const learns = (daemon: string, id: string) => row(daemon, id).querySelector('[data-learning-passive]') !== null;
      const switcher = () => column.querySelector('[data-sbar-machine] .fy-sbar__machine-name')?.textContent;
      const betaName = column.querySelector(`[data-sbar-machine-group="${BETA}"] .fy-sbar__machine-label`)?.textContent;
      expect(groups()).toEqual([ALPHA, BETA]);
      // The machine on screen is the selected one, though beta was paired last.
      expect(store.connections.getSnapshot().selectedDaemonId).toBe(alpha.daemonId);
      // Each machine's rows carry ITS learners — never the machine on screen's, by a colliding id.
      expect([learns(ALPHA, 'one'), learns(ALPHA, 'two'), learns(BETA, 'one'), learns(BETA, 'two')]).toEqual([
        true,
        false,
        false,
        true,
      ]);

      await interact(() => row(BETA, 'one').click());
      await settle();

      expect(window.location.pathname).toBe(`/d/${encodeURIComponent(BETA)}/session/one`);
      // The list did not move under the pointer: the machine just opened is not hoisted to the top.
      expect(groups()).toEqual([ALPHA, BETA]);
      expect(row(BETA, 'one').getAttribute('aria-current')).toBe('page');
      expect(row(ALPHA, 'one').getAttribute('aria-current')).toBeNull();
      expect(switcher()).toBe(betaName);
      expect(store.connections.getSnapshot().selectedDaemonId).toBe(beta.daemonId);
      expect([learns(ALPHA, 'one'), learns(BETA, 'two')]).toEqual([true, true]);
    } finally {
      await view.unmount();
    }
  });

  it('stands on every machine page as a column the reader can fold to a rail and back', async () => {
    const { view } = await renderShell(`/d/${ALPHA}/settings`, [alpha.daemonId], { sessions: ['one'] });
    try {
      await settle();
      // No top navigation row any more: the bar is the app's navigation.
      expect(view.container.querySelector('[data-app-bar-destination-row]')).toBeNull();
      const column = must(view.container.querySelector('[data-sessions-bar="column"]'), 'the sessions column');
      expect(column.querySelector('[data-sbar-place="settings"]')?.getAttribute('aria-current')).toBe('page');
      expect(column.querySelector('[data-sbar-session="one"]')).not.toBeNull();

      await interact(() => must(column.querySelector<HTMLButtonElement>('[data-sbar-collapse]'), 'Collapse').click());
      const rail = must(view.container.querySelector('[data-sessions-bar="rail"]'), 'the folded rail');
      await interact(() => must(rail.querySelector<HTMLButtonElement>('[data-sbar-expand]'), 'Expand').click());
      expect(view.container.querySelector('[data-sessions-bar="column"]')).not.toBeNull();

      // Adding a machine goes to the machine picker, where pairing starts.
      await interact(() =>
        must(view.container.querySelector<HTMLButtonElement>('[data-sbar-machine]'), 'machine').click(),
      );
      await interact(() =>
        must(
          [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
            item => item.textContent === 'Add a machine…',
          ),
          'Add a machine',
        ).click(),
      );
      await settle();
      expect(window.location.pathname).toBe('/');
    } finally {
      await view.unmount();
    }
  });

  it('carries this session’s own search on a session page at every desktop width, and the finder once folded', async () => {
    const wide = await renderShell(`/d/${ALPHA}/session/shared`, [alpha.daemonId], { sessions: ['shared'] });
    try {
      await settle();
      expect(
        wide.view.container.querySelector('[data-sessions-bar="column"] [data-current-session-search]'),
      ).not.toBeNull();
    } finally {
      await wide.view.unmount();
    }

    const restore = patchGlobal(window, 'innerWidth', 900);
    try {
      const narrow = await renderShell(`/d/${ALPHA}/session/shared`, [alpha.daemonId], { sessions: ['shared'] });
      try {
        await settle();
        // A narrow window keeps the column EXPANDED — it folds only when the reader folds it.
        const column = must(narrow.view.container.querySelector('[data-sessions-bar="column"]'), 'the column');
        expect(column.querySelector('[data-current-session-search]')).not.toBeNull();
        await interact(() => (must(column.querySelector('[data-sbar-collapse]'), 'Collapse') as HTMLElement).click());
        const rail = must(narrow.view.container.querySelector('[data-sessions-bar="rail"]'), 'the folded rail');
        expect(rail.querySelector('[data-sbar-expand]')).not.toBeNull();
        expect(narrow.view.container.querySelector('[data-current-session-search]')).toBeNull();
        // With nowhere to focus this session's search, the chord opens the finder instead.
        await interact(() => pressKey(document.body, 'k', { ctrlKey: true }));
        expect(document.querySelector('[role="dialog"] [role="combobox"]')).not.toBeNull();
      } finally {
        await narrow.view.unmount();
      }
    } finally {
      restore();
    }
  });
});

describe('the phone tab bar', () => {
  const PHONE_WIDTH = 390;

  it('sits under every page but a session, whose own bar opens the sessions drawer and its finder', async () => {
    const restore = patchGlobal(window, 'innerWidth', PHONE_WIDTH);
    try {
      const sessions = await renderShell(`/d/${ALPHA}`, [alpha.daemonId]);
      try {
        await settle();
        const bar = must(sessions.view.container.querySelector<HTMLElement>('[data-app-tab-bar]'), 'the tab bar');
        expect(bar.querySelector('[data-app-tab="sessions"]')?.getAttribute('aria-current')).toBe('page');
        // The bar has its own Find, so the top bar does not repeat it.
        expect(sessions.view.container.querySelector('[data-app-bar-destination-search]')).toBeNull();
      } finally {
        await sessions.view.unmount();
      }

      const session = await renderShell(`/d/${ALPHA}/session/shared`, [alpha.daemonId]);
      try {
        await settle();
        // A transcript needs the whole height: no tab bar and no top bar. The session's own bar is the
        // only chrome, and its ☰ opens the sessions drawer, which carries the finder.
        expect(session.view.container.querySelector('[data-app-tab-bar]')).toBeNull();
        expect(session.view.container.querySelector('[data-density-region="app-bar"]')).toBeNull();
        expect(session.view.container.querySelector('[data-app-bar-destination-search]')).toBeNull();
        await interact(() =>
          must(
            session.view.container.querySelector<HTMLButtonElement>('button[data-session-bar-sessions]'),
            'the session bar ☰',
          ).click(),
        );
        const drawer = must(
          session.view.container.querySelector<HTMLElement>('[data-sessions-bar="drawer"]'),
          'the sessions drawer',
        );
        expect(drawer.querySelector('[data-app-bar-destination-search]')).not.toBeNull();
        // Choosing a place closes the drawer over the page it opens.
        await interact(() =>
          must(drawer.querySelector<HTMLAnchorElement>('[data-sbar-place="settings"]'), 'Settings').click(),
        );
        expect(session.view.container.querySelector('[data-sessions-bar="drawer"]')).toBeNull();
      } finally {
        await session.view.unmount();
      }
    } finally {
      restore();
    }
  });

  it('is not drawn at desktop width, where the app bar carries the destinations', async () => {
    const { view } = await renderShell(`/d/${ALPHA}`, [alpha.daemonId]);
    try {
      await settle();
      expect(view.container.querySelector('[data-app-tab-bar]')).toBeNull();
    } finally {
      await view.unmount();
    }
  });
});

describe('pairing a phone from the machine menu and the finder', () => {
  /** This machine says the reader may pair a device once they confirm with a passkey. */
  const PAIRING_OPEN = {
    '/v1/grants': {
      capabilities: DAEMON_CAPABILITIES.map(capability => ({
        capability,
        use: capability !== 'pairing',
        configure: false,
        granted: { use: true, configure: false },
        mayGrant: false,
        useRefusal: capability === 'pairing' ? 'step-up-required' : 'granted',
        configureRefusal: 'not-granted',
        origin: 'default',
      })),
      governed: true,
      hostLocal: false,
      steppedUp: false,
    },
    '/v1/pair/devices': { devices: [], hostLocal: false, mayWiden: {} },
  } as const;

  const pairItem = (): HTMLButtonElement =>
    must(
      [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item =>
        item.textContent?.startsWith('Pair a phone with '),
      ),
      'Pair a phone',
    );

  it('opens the Add-a-device surface in a dialog from the switcher and from the finder', async () => {
    const { view } = await renderShell(`/d/${ALPHA}`, [alpha.daemonId], { fleet: PAIRING_OPEN });
    try {
      await settle();
      const machine = must(view.container.querySelector<HTMLButtonElement>('[data-sbar-machine]'), 'machine');
      await interact(() => machine.click());
      await interact(() => pairItem().click());
      await settle();
      const dialog = must(document.querySelector('[data-pair-phone="dialog"] [role="dialog"]'), 'the dialog');
      expect(dialog.textContent).toContain('No paired device can reach');
      await interact(() => pressKey(dialog, 'Escape'));
      expect(document.querySelector('[data-pair-phone]')).toBeNull();
      expect(document.activeElement).toBe(machine);

      // The finder offers the same act, and opens the same dialog.
      await interact(() => pressKey(document.body, 'k', { ctrlKey: true }));
      await interact(() =>
        must(document.getElementById('fy-palette-option-command-pair-phone'), 'the finder row').dispatchEvent(
          new Event('pointerdown', { bubbles: true, cancelable: true }),
        ),
      );
      await interact(() =>
        must(document.getElementById('fy-palette-option-command-pair-phone'), 'the finder row').dispatchEvent(
          new Event('pointerup', { bubbles: true, cancelable: true }),
        ),
      );
      await settle();
      expect(document.querySelector('[data-pair-phone="dialog"]')).not.toBeNull();
      await interact(() => must(document.querySelector<HTMLButtonElement>('[data-pair-phone-close]'), 'Close').click());
      expect(document.querySelector('[data-pair-phone]')).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('opens it as a bottom sheet on a phone, over the sessions drawer', async () => {
    const restore = patchGlobal(window, 'innerWidth', 390);
    try {
      const { view } = await renderShell(`/d/${ALPHA}`, [alpha.daemonId], { fleet: PAIRING_OPEN });
      try {
        await settle();
        await interact(() =>
          must(
            view.container.querySelector<HTMLButtonElement>('button[aria-label="Open the fleet sidebar"]'),
            'the drawer opener',
          ).click(),
        );
        const drawer = must(view.container.querySelector('[data-sessions-bar="drawer"]'), 'the drawer');
        await interact(() => must(drawer.querySelector<HTMLButtonElement>('[data-sbar-machine]'), 'machine').click());
        await interact(() => pairItem().click());
        await settle();
        expect(document.querySelector('[data-bottom-sheet="pair-phone"] [data-pair-phone-body]')).not.toBeNull();
        expect(view.container.querySelector('[data-sessions-bar="drawer"]')).not.toBeNull();
      } finally {
        await view.unmount();
      }
    } finally {
      restore();
    }
  });
});

/* ---------- the navigation cache: Back returns to a page as it was left ---- */

/** A session-cache backend that keeps its records in a map a test can read and pre-fill. */
class MemoryCacheBackend implements SessionCacheBackend {
  readonly records = new Map<string, unknown>();
  async get(key: string): Promise<unknown> {
    return this.records.get(key);
  }
  async put(key: string, value: unknown): Promise<void> {
    this.records.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.records.delete(key);
  }
  async keys(): Promise<readonly string[]> {
    return [...this.records.keys()];
  }
  async clear(): Promise<void> {
    this.records.clear();
  }
}

/** A `sessionStorage` stand-in for the scroll memory, readable by the test. */
class MemoryScrollStorage implements ScrollMemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

/** A `logs` gate a test opens and closes: while it is shut, only the cache can fill the transcript. */
const transcriptValve = () => {
  let release: (() => void) | undefined;
  let held: Promise<void> | undefined;
  return {
    gate: async (): Promise<void> => await held,
    shut: (): void => {
      held = new Promise(resolve => {
        release = resolve;
      });
    },
    open: (): void => {
      held = undefined;
      release?.();
    },
  };
};

/**
 * The browser's own Back/Forward to an entry the reader already visited: that entry's `history.state`
 * comes back with it, which is how the router knows it is the SAME entry and not a new visit.
 */
const returnTo = async (state: unknown, path: string): Promise<void> => {
  window.history.replaceState(state, '', path);
  await interact(() => window.dispatchEvent(new PopStateEvent('popstate')));
};

const transcriptText = (container: HTMLElement): string => container.querySelector('[role="log"]')?.textContent ?? '';
const updatingShown = (container: HTMLElement): boolean => container.querySelector('[data-cache-updating]') !== null;

describe('the navigation cache', () => {
  it('replaces the picker with the only machine’s sessions, so Back does not return to the picker', async () => {
    // Arrange
    setPath('/');

    // Act
    const { view } = await renderShell('/', [alpha.daemonId]);
    try {
      // Assert
      expect(window.location.pathname).toBe(`/d/${ALPHA}`);
      // The same entry the document opened on: a push would have put the picker behind it at index 0.
      expect((window.history.state as { fyIndex?: number }).fyIndex).toBe(0);
    } finally {
      await view.unmount();
    }
  });

  it('keeps the shell and draws the cached transcript at once when the reader returns to a session', async () => {
    // Arrange
    let live = 'assistant/message: First read of the conversation.';
    const valve = transcriptValve();
    const { view } = await renderShell(`/d/${ALPHA}`, [alpha.daemonId], {
      sessions: ['shared'],
      transcript: () => live,
      transcriptGate: valve.gate,
    });
    try {
      await settle();
      const shell = must(view.container.firstElementChild, 'the shell root');
      const region = must(view.container.querySelector('[data-page-scroll-region]'), 'the page scroll region');
      const sessionsEntry = window.history.state as unknown;
      const row = must(
        view.container.querySelector<HTMLAnchorElement>('main a[href$="/session/shared"]'),
        'the session row',
      );
      await interact(() => row.click());
      await settle();
      const sessionEntry = window.history.state as unknown;
      // A first visit has nothing cached: no "Updating…" over the live read.
      expect(updatingShown(view.container)).toBe(false);
      expect(transcriptText(view.container)).toContain('First read of the conversation.');

      // Act — Back to the list, then Forward into the chat while the daemon has not answered yet.
      await returnTo(sessionsEntry, `/d/${ALPHA}`);
      const shellAfterBack = view.container.firstElementChild;
      const regionAfterBack = view.container.querySelector('[data-page-scroll-region]');
      valve.shut();
      live = 'assistant/message: The live read that replaces it.';
      await returnTo(sessionEntry, `/d/${ALPHA}/session/shared`);
      const drawnBeforeLive = transcriptText(view.container);
      const updatingBeforeLive = updatingShown(view.container);
      valve.open();
      await settle();

      // Assert
      expect(shellAfterBack).toBe(shell);
      expect(regionAfterBack).toBe(region);
      expect(view.container.firstElementChild).toBe(shell);
      expect(drawnBeforeLive).toContain('First read of the conversation.');
      expect(updatingBeforeLive).toBe(true);
      expect(transcriptText(view.container)).toContain('The live read that replaces it.');
      expect(updatingShown(view.container)).toBe(false);
    } finally {
      valve.open();
      await view.unmount();
    }
  });

  it('reads a reloaded session’s transcript from storage until the daemon answers', async () => {
    // Arrange
    const scope = daemonSessionScope(alpha, 'shared');
    const backend = new MemoryCacheBackend();
    const seed = new SessionCache(backend);
    seed.saveTranscript(scope, { log: 'assistant/message: Kept on this device.' }, seed.generation(alpha.daemonId));
    await settleUntil(() => backend.records.size > 0, 'the seeded transcript to reach storage', interact);
    const valve = transcriptValve();
    valve.shut();

    // Act
    const { store, view } = await renderShell(`/d/${ALPHA}/session/shared`, [alpha.daemonId], {
      sessionCacheBackend: backend,
      transcript: 'assistant/message: Fresh from the daemon.',
      transcriptGate: valve.gate,
    });
    try {
      await settle();
      const drawnFromStorage = transcriptText(view.container);
      const updatingFromStorage = updatingShown(view.container);
      valve.open();
      await settle();

      // Assert
      expect(drawnFromStorage).toContain('Kept on this device.');
      expect(updatingFromStorage).toBe(true);
      expect(transcriptText(view.container)).toContain('Fresh from the daemon.');
      expect(transcriptText(view.container)).not.toContain('Kept on this device.');
      expect(updatingShown(view.container)).toBe(false);
      expect(store.sessionCache.peekTranscript(scope)?.log).toBe('assistant/message: Fresh from the daemon.');
    } finally {
      valve.open();
      await view.unmount();
    }
  });

  it('saves every live log and send-ledger read into the cache for the next open', async () => {
    // Arrange
    const scope = daemonSessionScope(alpha, 'shared');
    const sendRows = [{ sendId: 'unreadable-row' }];

    // Act
    const { store, view } = await renderShell(`/d/${ALPHA}/session/shared`, [alpha.daemonId], {
      transcript: 'assistant/message: Worth keeping.',
      sends: sendRows,
    });
    try {
      await settle();
      const cached = store.sessionCache.peekTranscript(scope);

      // Assert
      expect(cached?.log).toBe('assistant/message: Worth keeping.');
      expect(cached?.sends).toEqual(sendRows);
    } finally {
      await view.unmount();
    }
  });

  it('steps back to the sessions list from a failed session reached from it', async () => {
    // Arrange
    const backs: string[] = [];
    const { view } = await renderShell(`/d/${ALPHA}`, [alpha.daemonId], { sessionFailure: 'daemon refused the read' });
    const restoreBack = patchGlobal(window.history, 'back', () => backs.push(window.location.pathname));
    try {
      await settle();
      // Reached FROM the list (a notification tap, a link), so the list is the entry behind it.
      await popTo(`/d/${ALPHA}/session/shared`);
      await settle();
      const sessions = must(
        [...view.container.querySelectorAll('button')].find(button => button.textContent === '← Sessions'),
        'the error page’s way back',
      );

      // Act
      await interact(() => sessions.click());

      // Assert
      expect(backs).toEqual([`/d/${ALPHA}/session/shared`]);
    } finally {
      restoreBack();
      await view.unmount();
    }
  });

  it('pushes the sessions list from a failed session opened by a deep link', async () => {
    // Arrange
    const backs: string[] = [];
    const { view } = await renderShell(`/d/${ALPHA}/session/shared`, [alpha.daemonId], {
      sessionFailure: 'daemon refused the read',
    });
    const restoreBack = patchGlobal(window.history, 'back', () => backs.push(window.location.pathname));
    try {
      await settle();
      const sessions = must(
        [...view.container.querySelectorAll('button')].find(button => button.textContent === '← Sessions'),
        'the error page’s way back',
      );

      // Act
      await interact(() => sessions.click());

      // Assert
      expect(backs).toEqual([]);
      expect(window.location.pathname).toBe(`/d/${ALPHA}`);
    } finally {
      restoreBack();
      await view.unmount();
    }
  });

  /** Every Continue listing answers empty, whatever query it carries. */
  const EMPTY_CONTINUE_LISTINGS = new Proxy(
    {},
    {
      get: (_target, path) =>
        typeof path === 'string' && path.startsWith(CONVERSATION_IMPORT_PATH)
          ? { conversations: [], matched: 0 }
          : undefined,
    },
  ) as Readonly<Record<string, unknown>>;

  it('opens Continue from the #continue address and writes the choice into it in place', async () => {
    // Arrange
    const { view } = await renderShell(`/d/${ALPHA}/new?agent=claude-default#continue`, [alpha.daemonId], {
      fleet: EMPTY_CONTINUE_LISTINGS,
    });
    try {
      await settle();
      const entry = (window.history.state as { fyEntry?: string }).fyEntry;
      const choice = (kind: 'new' | 'continue'): HTMLButtonElement =>
        must(
          view.container.querySelector<HTMLButtonElement>(
            `[data-segmented="new-session-kind"] [data-segment="${kind}"]`,
          ),
          `the ${kind} choice`,
        );
      const openedOnContinue = choice('continue').getAttribute('aria-pressed');

      // Act
      await interact(() => choice('new').click());
      const afterNew = { hash: window.location.hash, search: window.location.search };
      await interact(() => choice('continue').click());

      // Assert
      expect(openedOnContinue).toBe('true');
      expect(afterNew).toEqual({ hash: '', search: '?agent=claude-default' });
      expect(window.location.hash).toBe('#continue');
      expect(window.location.pathname).toBe(`/d/${ALPHA}/new`);
      // Replaced in place: still the entry the page opened on.
      expect((window.history.state as { fyEntry?: string }).fyEntry).toBe(entry);
    } finally {
      await view.unmount();
    }
  });

  it('steps back to the sessions list from New session opened from it', async () => {
    // Arrange
    const backs: string[] = [];
    const { view } = await renderShell(`/d/${ALPHA}`, [alpha.daemonId]);
    const restoreBack = patchGlobal(window.history, 'back', () => backs.push(window.location.pathname));
    try {
      await settle();
      await interact(() =>
        must(view.container.querySelector<HTMLAnchorElement>('main a[href$="/new"]'), 'the New session link').click(),
      );
      await settle();
      const sessions = must(
        [...view.container.querySelectorAll('button')].find(button => button.textContent === '← Sessions'),
        'the New session page’s way back',
      );

      // Act
      await interact(() => sessions.click());

      // Assert
      expect(backs).toEqual([`/d/${ALPHA}/new`]);
    } finally {
      restoreBack();
      await view.unmount();
    }
  });

  it('clears the session cache and every remembered scroll position from Settings › This device', async () => {
    // Arrange
    const scope = daemonSessionScope(alpha, 'shared');
    const backend = new MemoryCacheBackend();
    const scrolls = new MemoryScrollStorage();
    const { store, view } = await renderShell(`/d/${ALPHA}/settings#device`, [alpha.daemonId], {
      sessionCacheBackend: backend,
      scrollMemoryStorage: scrolls,
    });
    try {
      store.sessionCache.saveTranscript(
        scope,
        { log: 'assistant/message: cached' },
        store.sessionCache.generation(alpha.daemonId),
      );
      store.scrollMemory.rememberPage('entry-somewhere', '', 240);
      await settle();
      const button = (label: string): HTMLButtonElement =>
        must(
          [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(
            candidate => candidate.textContent?.trim() === label,
          ),
          `the ${label} button`,
        );

      // Act
      await interact(() => button('Clear cached data').click());
      await interact(() => button('Clear').click());
      await settle();

      // Assert
      expect(store.sessionCache.peekTranscript(scope)).toBeUndefined();
      expect(backend.records.size).toBe(0);
      expect(scrolls.values.has(SCROLL_MEMORY_KEY)).toBe(false);
      expect(view.container.querySelector('[data-clear-cached-data="cleared"]')).not.toBeNull();
    } finally {
      await view.unmount();
    }
  });
});

/**
 * A NOTIFICATION TAP, AS THE SHELL RECEIVES IT (the worker's half and every window case are proved in a
 * real browser by `tests/integration/notification-open.test.ts`). The tap names a conversation on a
 * machine that may not be the one on screen, and may land before the shell has mounted at all.
 */
describe('a notification tap', () => {
  /** `navigator.serviceWorker`, holding a worker's message until something listens — as the browser does. */
  const worker = () => {
    const listeners = new Set<(event: MessageEvent) => void>();
    const held: unknown[] = [];
    const deliver = (listener: (event: MessageEvent) => void, data: unknown): void =>
      listener({ data, ports: [] } as unknown as MessageEvent);
    const restore = patchGlobal(navigator, 'serviceWorker', {
      addEventListener: (_type: string, listener: (event: MessageEvent) => void) => {
        listeners.add(listener);
        for (const data of held.splice(0)) deliver(listener, data);
      },
      removeEventListener: (_type: string, listener: (event: MessageEvent) => void) => listeners.delete(listener),
    });
    const tap = (url: string): void => {
      const data = { type: NOTIFICATION_OPEN_MESSAGE, url };
      if (listeners.size === 0) held.push(data);
      for (const listener of [...listeners]) deliver(listener, data);
    };
    return { tap, restore };
  };

  const shownSession = (container: Element): { daemon?: string; session?: string } | null => {
    const host = container.querySelector<HTMLElement>('[data-session][data-daemon]');
    return host === null ? null : { daemon: host.dataset.daemon, session: host.dataset.session };
  };

  it('switches to the machine the notification came from, and opens its conversation at the item', async () => {
    const browser = worker();
    try {
      const { reads, view } = await renderShell(daemonSessionPath(alpha.daemonId, 'here'), [
        alpha.daemonId,
        beta.daemonId,
      ]);
      await settle();
      expect(shownSession(view.container)).toEqual({ daemon: alpha.daemonId, session: 'here' });

      await interact(() => browser.tap(`${daemonSessionPath(beta.daemonId, 'there')}?attention=A3`));
      await settle();

      expect(`${window.location.pathname}${window.location.search}`).toBe(
        `${daemonSessionPath(beta.daemonId, 'there')}?attention=A3`,
      );
      // Beta's conversation, read through Beta's own pairing — not Alpha's session under Beta's address.
      expect(shownSession(view.container)).toEqual({ daemon: beta.daemonId, session: 'there' });
      expect(reads).toContain(`${beta.daemonId}:there`);
      await view.unmount();
    } finally {
      browser.restore();
    }
  });

  it('a tap the app was opened for wins over the start-up shortcut to the fleet', async () => {
    const browser = worker();
    try {
      // The tap reached the window before the shell mounted at `/` — the picker, which a paired
      // browser skips straight to its machine's sessions.
      browser.tap(daemonSessionPath(beta.daemonId, 'there'));
      const { view } = await renderShell('/', [alpha.daemonId, beta.daemonId]);
      await settle();

      expect(window.location.pathname).toBe(daemonSessionPath(beta.daemonId, 'there'));
      expect(shownSession(view.container)).toEqual({ daemon: beta.daemonId, session: 'there' });
      await view.unmount();
    } finally {
      browser.restore();
    }
  });
});
