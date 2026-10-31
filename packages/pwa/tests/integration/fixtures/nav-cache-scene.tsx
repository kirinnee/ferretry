/**
 * The browser entry for the navigation + session-cache evidence: THE REAL SHELL — `RouterProvider >
 * StoreProvider > AppShell`, exactly as `App` composes it — over ONE FAKE DAEMON, with the browser's
 * own IndexedDB (the session cache) and `sessionStorage` (scroll memory) underneath.
 *
 * The daemon is the injected `connectClient` for the typed reads (list, get, logs) and a scripted
 * session network (`fetcherDaemons`) for everything else, so nothing leaves the page. Its identity is
 * derived from a fixed seed and its pairing is kept in `localStorage`, so a RELOAD comes back paired to
 * the same machine — which is what lets a reload find the cache the previous load saved.
 *
 * Controlled from the suite through `localStorage` (read once at boot) and `window.__navCache`:
 *   - `fy-nav-cache:hold` = '1'     the first `list` and `logs` answers wait for `__navCache.release()`;
 *   - `fy-nav-cache:renamed` = '1'  the live list names the first session differently, so a cached row
 *                                   and a live one can be told apart.
 * `__navCache.reads` records each typed read as it is asked, and `__navCache.daemonId` names the machine.
 *
 * Built by `scripts/build-composer-integration-fixture.ts --entry` in a child process, never inside the
 * test runner. Every name and session in it is fake.
 */

import type { SessionView } from '@ferretry/protocol';
import type { DaemonIdentity } from '@ferretry/relay';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppShell } from '../../../src/App.tsx';
import type { DaemonConnectionRepository } from '../../../src/lib/connections.ts';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { RouterProvider } from '../../../src/lib/router.tsx';
import { createAppStore, StoreProvider } from '../../../src/lib/store.tsx';
import { MemoryDeviceKeyStore } from '../../support/device-keys.ts';
import { fetcherDaemons, relayCrypto, testDevice } from '../../support/relay.ts';
import { schemaValidSessionView } from '../../support/schema-valid-sessions.ts';

const HOLD_KEY = 'fy-nav-cache:hold';
const RENAMED_KEY = 'fy-nav-cache:renamed';

/** How many sessions the machine lists: enough that the sessions list scrolls on a desktop. */
const SESSION_COUNT = 40;
/** How many exchanges each transcript holds: enough that the chat scrolls well past one screen. */
const EXCHANGES = 60;

/**
 * A FIXED daemon identity: an Ed25519 PKCS#8 key whose 32-byte seed is a constant, so every load of
 * this page — the reload included — is the same machine with the same fingerprint.
 */
const fixedIdentity = async (): Promise<DaemonIdentity> => {
  const prefix = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];
  const der = new Uint8Array([...prefix, ...new Uint8Array(32).fill(0x2a)]);
  const lines = btoa(String.fromCharCode(...der)).match(/.{1,64}/gu) ?? [];
  return await relayCrypto.importDaemonIdentity(
    ['-----BEGIN PRIVATE KEY-----', ...lines, '-----END PRIVATE KEY-----', ''].join('\n'),
  );
};

/** The pairing registry, kept in `localStorage` so a reload is still paired. */
class LocalStorageRepository implements DaemonConnectionRepository {
  async load(key: string): Promise<string | null> {
    return localStorage.getItem(`fy-nav-cache:repo:${key}`);
  }

  async save(key: string, value: string): Promise<void> {
    localStorage.setItem(`fy-nav-cache:repo:${key}`, value);
  }
}

interface NavCacheHooks {
  readonly daemonId: string;
  readonly reads: string[];
  readonly release: () => void;
  /** From now on no list read ever answers, so nothing can write the cache back in. */
  readonly stall: () => void;
}

const identity = await fixedIdentity();
const host = 'studio.example.test';
const connection = daemonConnection({
  daemonId: identity.daemonId,
  baseUrl: `https://${host}`,
  deviceId: 'fy_device_id_navCacheDevice0000001',
  daemonName: 'studio',
});

const holding = localStorage.getItem(HOLD_KEY) === '1';
const renamed = localStorage.getItem(RENAMED_KEY) === '1';
let release: () => void = () => undefined;
const gate: Promise<void> = holding
  ? new Promise<void>(resolve => {
      release = resolve;
    })
  : Promise.resolve();
let stalled = false;
const hooks: NavCacheHooks = {
  daemonId: identity.daemonId,
  reads: [],
  release: () => release(),
  stall: () => {
    stalled = true;
  },
};
(globalThis as { __navCache?: NavCacheHooks }).__navCache = hooks;

const TEAMMATES = ['ivo', 'hadi', 'lea', 'ora', 'noa', 'pim', 'rue', 'tam'];
const sessionId = (index: number): string => `s-${String(index).padStart(2, '0')}`;
const sessionName = (index: number): string =>
  index === 0 ? (renamed ? 'Renamed by the live read' : 'Cached relay bench') : `Fake task number ${index}`;

/**
 * One session as the daemon's protocol shapes it — SCHEMA-VALID, because the cache re-validates every
 * list it reads back and would rightly refuse anything less.
 */
const session = (index: number): SessionView => {
  const base = schemaValidSessionView(sessionId(index));
  const at = new Date(Date.UTC(2026, 9, 20, 11, 59 - index)).toISOString();
  return {
    ...base,
    config: {
      ...base.config,
      teammate: TEAMMATES[index % TEAMMATES.length] as string,
      name: sessionName(index),
      mode: 'interactive',
      updatedAt: at,
    },
    state: { ...base.state, lastActivityAt: at },
  };
};

const sessions = (): readonly SessionView[] => Array.from({ length: SESSION_COUNT }, (_, index) => session(index));

/** A long conversation; its last line differs when `renamed`, so a cached tail and a live one can be told apart. */
const transcript = (id: string, fresh: boolean): string =>
  [
    ...Array.from({ length: EXCHANGES }, (_, turn) => [
      `user/message: Question ${turn} about ${id}: what does the fake fixture do next?`,
      `assistant/message: Answer ${turn}. The fixture keeps going with a reasonably long paragraph so that every exchange takes up some height in the transcript, which is what makes the chat scroll.`,
    ]).flat(),
    `assistant/message: ${fresh ? 'Fresh tail' : 'Live tail'} of ${id}.`,
  ].join('\n');

/** The first read of each kind waits on the gate when holding; every later one answers at once. */
const heldOnce = new Set<string>();
const held = async (what: string): Promise<void> => {
  if (heldOnce.has(what)) return;
  heldOnce.add(what);
  await gate;
};

const daemonFetch = async (input: RequestInfo | URL): Promise<Response> => {
  const url = new URL(String(input));
  const agenda = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/attention$/u);
  if (agenda?.[1] !== undefined)
    return Response.json({
      v: 1,
      sessionId: decodeURIComponent(agenda[1]),
      items: [],
      resolved: [],
      count: 0,
      parseErrors: 0,
      updatedAt: '2026-10-20T12:00:00.000Z',
    });
  return Response.json({});
};

const network = fetcherDaemons([{ host, identity }], daemonFetch);
const deviceKeys = new MemoryDeviceKeyStore();
await deviceKeys.save(identity.daemonId, (await testDevice()).privateKey);

const never = async (_onFrame: unknown, signal?: AbortSignal): Promise<void> =>
  await new Promise<void>(resolve => {
    if (signal?.aborted === true) resolve();
    else signal?.addEventListener('abort', () => resolve(), { once: true });
  });

const store = await createAppStore({
  repository: new LocalStorageRepository(),
  connectionHealthEnvironment: {
    now: () => Date.now(),
    schedule: () => () => undefined,
    random: () => 0,
    isOnline: () => true,
  },
  connectionSignals: { listen: () => () => undefined },
  connectClient: async () =>
    ({
      list: async () => {
        hooks.reads.push('list');
        await held('list');
        if (stalled) await new Promise<never>(() => undefined);
        return sessions();
      },
      get: async (id: string) => {
        hooks.reads.push(`get:${id}`);
        return session(Number(id.slice(2)));
      },
      logs: async (id: string) => {
        hooks.reads.push(`logs:${id}`);
        await held('logs');
        return transcript(id, renamed);
      },
      // The chat reads its tail as a page (`log-page`): the same transcript and the same hold, from the file's start.
      logPage: async (id: string) => {
        hooks.reads.push(`logs:${id}`);
        await held('logs');
        return { v: 1, sessionId: id, log: transcript(id, renamed), start: 0, file: 'transcript' };
      },
      configChanges: never,
      stream: async (_sessionId: unknown, _after: unknown, _onEvent: unknown, signal?: AbortSignal): Promise<void> =>
        await never(undefined, signal),
      wardenStatus: async () => await Promise.reject(new Error('no warden in this scene')),
      wardenVerdicts: async () => [],
      wardenAgenda: async () => await Promise.reject(new Error('no warden in this scene')),
      foreignHistory: async () => ({ conversations: [], skipped: [] }),
      request: async () => ({}),
    }) as never,
  deviceKeys,
  relayCrypto,
  relayDial: network.dial,
  fetcher: daemonFetch,
});
// Paired once; a reload finds the pairing in the repository and must NOT re-pair (that clears the cache).
if (store.connections.get(connection.daemonId) === undefined) store.connections.add(connection, { pairedAt: 1 });

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <StrictMode>
      <RouterProvider>
        <StoreProvider store={store}>
          <AppShell />
        </StoreProvider>
      </RouterProvider>
    </StrictMode>,
  );
