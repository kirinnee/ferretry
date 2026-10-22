/**
 * SOLE OWNER of the `fy-carrier-drops-v1` browser-storage key: every held session this browser LOST, so
 * "it keeps reconnecting" arrives with evidence instead of an impression.
 *
 * A DROP IS A SESSION THAT WAS SERVING AND THEN ENDED without this browser asking — never a dial that
 * failed (that is the walk's own report) and never a close this app made on purpose. Each is kept with
 * what the browser could see at that moment: which carrier, the close code and reason, how long the
 * session had lived, how long before the end anything last arrived on it, whether the page was hidden
 * (and for how long), whether the device said it was online, its network type where the browser tells,
 * and — filled in once it happens — how long until the next session to the same machine opened.
 *
 * KEPT ACROSS RELOADS, BOUNDED, AND NEVER SENT. An installed app the phone killed in the background comes
 * back as a reload, which is exactly when the evidence matters, so the list lives in `localStorage`. It
 * holds the newest {@link CARRIER_DROP_LIMIT} entries and nothing else; it carries no key, token, address
 * or device id, only a machine's fingerprint (the same one every pairing link shows). A person copies it
 * from Settings › Machine › Performance; nothing reads it but that page.
 */

import { z } from 'zod';
import type { DaemonId } from './daemon-connection.ts';

/** The sole browser-storage key for the drop log. */
export const CARRIER_DROPS_KEY = 'fy-carrier-drops-v1';

/** The most drops kept, across every machine. Older ones are forgotten first. */
export const CARRIER_DROP_LIMIT = 100;

/**
 * How long after a drop the next opened session still counts as its reconnect. Past this, the session
 * that opened is a person coming back to the app, not the app recovering, and the drop keeps no figure.
 */
export const CARRIER_RECONNECT_WINDOW_MS = 10 * 60_000;

/** What a dropped session was for: the one that carries requests, or one live stream. */
export type CarrierDropPurpose = 'requests' | 'stream';

const CarrierDropSchema = z.object({
  /** Epoch ms. */
  at: z.number().finite(),
  daemonId: z.string().min(1).max(200),
  carrier: z.enum(['direct', 'webrtc', 'tunnel', 'relay']),
  purpose: z.enum(['requests', 'stream']),
  code: z.number().int(),
  reason: z.string().max(200),
  livedMs: z.number().finite().nonnegative(),
  /** How long before the end the last inbound message (a `fy-pong` counts) arrived. */
  lastHeardMs: z.number().finite().nonnegative(),
  hidden: z.boolean(),
  /** How long the page had been hidden when the session dropped; absent while it was visible. */
  hiddenMs: z.number().finite().nonnegative().optional(),
  online: z.boolean(),
  /** `navigator.connection`'s type or effective type, where the browser has it. */
  network: z.string().max(40).optional(),
  /** Until the next session to the same machine opened; absent until one has. */
  reconnectMs: z.number().finite().nonnegative().optional(),
});
export type CarrierDrop = z.infer<typeof CarrierDropSchema>;

/** What the session driver measured about one drop; the log adds what the page could see. */
export interface CarrierSessionEnd {
  readonly code: number;
  readonly reason: string;
  readonly livedMs: number;
  readonly lastHeardMs: number;
}

/** What the page can tell about itself at the moment of a drop. Injected so a suite needs no browser. */
export interface CarrierDropEnvironment {
  /** Epoch ms. */
  readonly now: () => number;
  /** How long the page has been hidden, or `undefined` while it is visible. */
  readonly hiddenFor: () => number | undefined;
  readonly online: () => boolean;
  readonly network: () => string | undefined;
}

export interface CarrierDropStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The slice of a browser the environment reads. Every part is optional: a missing one is "cannot tell". */
export interface CarrierDropGlobals {
  readonly document?: Pick<Document, 'addEventListener' | 'visibilityState'>;
  readonly navigator?: {
    readonly onLine?: boolean;
    readonly connection?: { readonly type?: string; readonly effectiveType?: string };
  };
}

/** The page's own view: visibility tracked from `visibilitychange`, the rest read when asked. */
export const browserCarrierDropEnvironment = (
  globals: CarrierDropGlobals = globalThis as unknown as CarrierDropGlobals,
): CarrierDropEnvironment => {
  let hiddenSince = globals.document?.visibilityState === 'hidden' ? Date.now() : undefined;
  globals.document?.addEventListener('visibilitychange', () => {
    if (globals.document?.visibilityState === 'hidden') hiddenSince ??= Date.now();
    else hiddenSince = undefined;
  });
  return {
    now: () => Date.now(),
    hiddenFor: () => (hiddenSince === undefined ? undefined : Date.now() - hiddenSince),
    online: () => globals.navigator?.onLine !== false,
    network: () => {
      const connection = globals.navigator?.connection;
      const kind = [connection?.type, connection?.effectiveType].filter(
        part => typeof part === 'string' && part !== '',
      );
      return kind.length === 0 ? undefined : kind.join('/');
    },
  };
};

const browserStorage = (): CarrierDropStorage | undefined => {
  try {
    const candidate = (globalThis as { localStorage?: CarrierDropStorage }).localStorage;
    return candidate && typeof candidate.getItem === 'function' && typeof candidate.setItem === 'function'
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
};

const StoredSchema = z.object({ version: z.literal(1), drops: z.array(z.unknown()) });

/** The stored list, keeping every entry that still parses and dropping the rest. */
const parseStored = (raw: string | null): readonly CarrierDrop[] => {
  if (raw === null) return [];
  try {
    const stored = StoredSchema.safeParse(JSON.parse(raw));
    if (!stored.success) return [];
    return stored.data.drops.flatMap(entry => {
      const parsed = CarrierDropSchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    });
  } catch {
    return [];
  }
};

/** Every drop this browser saw, newest last, shaped for `useSyncExternalStore`. */
export class CarrierDropLog {
  readonly #listeners = new Set<() => void>();
  #drops: readonly CarrierDrop[] | null = null;

  constructor(
    private readonly environment: CarrierDropEnvironment,
    private readonly storage: CarrierDropStorage | undefined = browserStorage(),
  ) {}

  /** Every drop kept, oldest first. Identity-stable until a change. */
  snapshot = (): readonly CarrierDrop[] => {
    this.#drops ??= this.#load();
    return this.#drops;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** One held session ended without this browser asking. */
  dropped(
    daemonId: DaemonId,
    carrier: CarrierDrop['carrier'],
    purpose: CarrierDropPurpose,
    end: CarrierSessionEnd,
  ): void {
    const hiddenMs = this.environment.hiddenFor();
    const network = this.environment.network();
    const drop: CarrierDrop = {
      at: this.environment.now(),
      daemonId,
      carrier,
      purpose,
      code: end.code,
      // A reason is the far end's or the browser's sentence; it is cut, never trusted to be short.
      reason: end.reason.slice(0, 200),
      livedMs: Math.max(0, Math.round(end.livedMs)),
      lastHeardMs: Math.max(0, Math.round(end.lastHeardMs)),
      hidden: hiddenMs !== undefined,
      ...(hiddenMs === undefined ? {} : { hiddenMs: Math.max(0, Math.round(hiddenMs)) }),
      online: this.environment.online(),
      ...(network === undefined ? {} : { network: network.slice(0, 40) }),
    };
    this.#replace([...this.snapshot(), drop].slice(-CARRIER_DROP_LIMIT));
  }

  /**
   * A session to this machine opened: the newest drop still waiting for one learns how long it waited.
   * Only one is filled — several sessions dropped by one outage come back with one reconnect.
   */
  reconnected(daemonId: DaemonId): void {
    const drops = this.snapshot();
    const now = this.environment.now();
    const index = drops.findLastIndex(drop => drop.daemonId === daemonId);
    const drop = drops[index];
    if (drop === undefined || drop.reconnectMs !== undefined || now - drop.at > CARRIER_RECONNECT_WINDOW_MS) return;
    // Every drop of this outage still waiting is the same outage, ending now.
    this.#replace(
      drops.map(entry =>
        entry.daemonId === daemonId && entry.reconnectMs === undefined && now - entry.at <= CARRIER_RECONNECT_WINDOW_MS
          ? { ...entry, reconnectMs: now - entry.at }
          : entry,
      ),
    );
  }

  /** Forget one machine's drops: it was unpaired, or the person cleared them. */
  clearDaemon(daemonId: DaemonId): void {
    const drops = this.snapshot();
    if (!drops.some(drop => drop.daemonId === daemonId)) return;
    this.#replace(drops.filter(drop => drop.daemonId !== daemonId));
  }

  #replace(next: readonly CarrierDrop[]): void {
    this.#drops = next;
    try {
      this.storage?.setItem(CARRIER_DROPS_KEY, JSON.stringify({ version: 1, drops: next }));
    } catch {
      // A full or denied storage keeps the log for this tab; the evidence is not worth an error.
    }
    for (const listener of [...this.#listeners]) listener();
  }

  #load(): readonly CarrierDrop[] {
    try {
      return parseStored(this.storage?.getItem(CARRIER_DROPS_KEY) ?? null).slice(-CARRIER_DROP_LIMIT);
    } catch {
      return [];
    }
  }
}

/* ---------- what a person reads and copies ---------------------------------- */

/** The words a close code means, for the codes a held session usually ends with. */
const CODE_WORDS: Readonly<Record<number, string>> = {
  1000: 'closed normally',
  1001: 'going away',
  1006: 'cut with no close frame',
  1011: 'far end failed',
  1012: 'far end restarting',
  4404: 'machine not on the relay',
  4408: 'no heartbeat answer',
  4429: 'too many sessions',
};

const seconds = (milliseconds: number): string =>
  milliseconds < 1_000 ? `${String(Math.round(milliseconds))} ms` : `${(milliseconds / 1_000).toFixed(1)} s`;

const lifetime = (milliseconds: number): string => {
  if (milliseconds < 60_000) return seconds(milliseconds);
  const minutes = Math.floor(milliseconds / 60_000);
  return minutes < 60 ? `${String(minutes)} min` : `${(minutes / 60).toFixed(1)} h`;
};

/** One drop as one line: what a person reads on the page and what Copy puts on the clipboard. */
export const describeCarrierDrop = (drop: CarrierDrop): string => {
  const words = CODE_WORDS[drop.code];
  const page = drop.hidden
    ? `page hidden ${drop.hiddenMs === undefined ? '' : `${lifetime(drop.hiddenMs)} `}`.trimEnd()
    : 'page visible';
  return [
    `${new Date(drop.at).toISOString()} ${drop.carrier} ${drop.purpose}`,
    `${String(drop.code)}${words === undefined ? '' : ` ${words}`}${drop.reason === '' ? '' : ` “${drop.reason}”`}`,
    `lived ${lifetime(drop.livedMs)}`,
    `last heard ${seconds(drop.lastHeardMs)} before`,
    page,
    drop.online ? 'online' : 'offline',
    ...(drop.network === undefined ? [] : [drop.network]),
    drop.reconnectMs === undefined ? 'not reconnected yet' : `back in ${seconds(drop.reconnectMs)}`,
  ].join(' · ');
};

/** The whole report for one machine, newest first, with a one-line tally per carrier on top. */
export const carrierDropsReport = (drops: readonly CarrierDrop[]): string => {
  if (drops.length === 0) return 'No connection drops recorded on this device.';
  const byCarrier = new Map<string, { count: number; codes: Map<number, number> }>();
  for (const drop of drops) {
    const tally = byCarrier.get(drop.carrier) ?? { count: 0, codes: new Map<number, number>() };
    tally.count += 1;
    tally.codes.set(drop.code, (tally.codes.get(drop.code) ?? 0) + 1);
    byCarrier.set(drop.carrier, tally);
  }
  const first = drops[0]?.at ?? 0;
  const last = drops.at(-1)?.at ?? first;
  const header = [
    `Connection drops: ${String(drops.length)} between ${new Date(first).toISOString()} and ${new Date(last).toISOString()}`,
    ...[...byCarrier].map(
      ([carrier, tally]) =>
        `  ${carrier}: ${String(tally.count)} (${[...tally.codes]
          .sort(([, left], [, right]) => right - left)
          .map(([code, count]) => `${String(code)}×${String(count)}`)
          .join(', ')})`,
    ),
  ];
  return [...header, '', ...[...drops].reverse().map(describeCarrierDrop)].join('\n');
};
