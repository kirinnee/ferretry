/**
 * ONE LINK, AS THE REDUCER SEES IT.
 *
 * A bundle object holds exactly one link. It does not re-state the rules: it projects its row into the
 * reducer's state, runs the reducer on the event, and persists what comes back. So the rules that must
 * hold under a race — a one-time link is spent once, a wrong token never consumes, every failed fetch
 * is the one 410 — are the reducer's, proved once in `link-store-reducer.test.ts`, and the bundle object
 * cannot drift from them.
 *
 * What the bundle object does NOT judge is everything that spans links. Its projection relaxes those
 * limits (`bundleLimits`): the per-daemon and global quotas are the owner and control objects' to
 * enforce BEFORE they get here, and the per-IP window is the control object's.
 */
import { z } from 'zod';
import {
  initialLinkStoreState,
  type LinkStoreEvent,
  type LinkStoreLimits,
  type LinkStoreResponse,
  type LinkStoreState,
  LINK_GONE,
  linkBundleAlarmAt,
  reduceLinkStore,
  sweepLinkStore,
} from './link-store-reducer.ts';
import type { LinkUploadMetadata } from './link-store.ts';
import { bundleLimits, chunkEnvelope } from './link-store-shards.ts';

type Row = NonNullable<ReturnType<LinkStoreState['bundles']['get']>>;
/** The row as persisted: the envelope is chunked into rows of its own. */
type StoredRow = Omit<Row, 'envelope'>;

export interface BundleDoc {
  readonly row: StoredRow;
  /** Wrong-token times in the last minute, for this link alone. */
  readonly wrong: readonly number[];
  /** How many envelope rows are stored: zero unless the link is live. */
  readonly chunks: number;
  /** How many envelope bytes are stored, so a status can say so without reading them. */
  readonly bytes: number;
}

export type BundleEvent =
  | {
      readonly type: 'upload';
      readonly daemonId: string;
      readonly metadata: LinkUploadMetadata;
      readonly envelope: Uint8Array;
      readonly now: number;
    }
  | { readonly type: 'delete' | 'status'; readonly daemonId: string; readonly now: number }
  | { readonly type: 'peek' | 'fetch'; readonly tokenVerifier: string; readonly now: number }
  | { readonly type: 'alarm'; readonly now: number };

export interface BundleStep {
  /** What to persist, or null when nothing of this link remains. */
  readonly doc: BundleDoc | null;
  /** `keep` leaves the stored rows alone; null deletes them; bytes replace them. */
  readonly envelope: 'keep' | null | Uint8Array;
  readonly response: LinkStoreResponse;
  /** The link stopped being live in this step, so the quota it held is free. */
  readonly released: boolean;
  /** When the object next has something to do for this link. */
  readonly alarmAt: number | null;
}

/** Stands where bytes are not needed (a peek, a status, an upload that replaces what it never reads). */
const NO_BYTES = new Uint8Array(0);

function project(bundleId: string, doc: BundleDoc | null, stored: Uint8Array | null, limits: LinkStoreLimits) {
  const base = initialLinkStoreState(bundleLimits(limits));
  if (doc === null) return base;
  const live = doc.row.state === 'live';
  return {
    ...base,
    bundles: new Map([[bundleId, { ...doc.row, envelope: live ? (stored ?? NO_BYTES) : null }]]),
    wrongTokenTimes: new Map([[bundleId, doc.wrong]]),
  };
}

function settle(
  bundleId: string,
  previous: BundleDoc | null,
  state: LinkStoreState,
  response: LinkStoreResponse,
  written: Uint8Array | null,
): BundleStep {
  const wasLive = previous?.row.state === 'live';
  const row = state.bundles.get(bundleId);
  if (row === undefined) return { doc: null, envelope: null, response, released: wasLive, alarmAt: null };
  const { envelope: _bytes, ...stored } = row;
  const live = stored.state === 'live';
  const chunks = written !== null ? chunkEnvelope(written).length : live ? (previous?.chunks ?? 0) : 0;
  const bytes = written !== null ? written.length : live ? (previous?.bytes ?? 0) : 0;
  return {
    doc: { row: stored, wrong: state.wrongTokenTimes.get(bundleId) ?? [], chunks, bytes },
    envelope: written ?? (live ? 'keep' : null),
    response,
    released: wasLive && !live,
    alarmAt: linkBundleAlarmAt(state, bundleId),
  };
}

/**
 * Run one event over this link. `stored` is the envelope's bytes and is read only for a fetch of a live
 * link; every other event passes null. `limits` are the current per-link limits, handed in by the Worker.
 */
export function reduceBundle(
  bundleId: string,
  previous: BundleDoc | null,
  event: BundleEvent,
  stored: Uint8Array | null,
  limits: LinkStoreLimits,
): BundleStep {
  const state = project(bundleId, previous, stored, limits);
  if ((event.type === 'peek' || event.type === 'fetch') && previous === null) {
    return { doc: null, envelope: null, response: LINK_GONE, released: false, alarmAt: null };
  }
  if (event.type === 'alarm') {
    return settle(bundleId, previous, sweepLinkStore(state, event.now), { ok: true, kind: 'alarm' }, null);
  }
  const reducerEvent: LinkStoreEvent =
    event.type === 'upload'
      ? {
          type: 'upload',
          daemonId: event.daemonId,
          bundleId,
          metadata: event.metadata,
          envelope: event.envelope,
          now: event.now,
        }
      : 'tokenVerifier' in event
        ? { type: event.type, bundleId, tokenVerifier: event.tokenVerifier, ip: '-', now: event.now }
        : event.type === 'delete'
          ? { type: 'delete', daemonId: event.daemonId, bundleId, now: event.now }
          : { type: 'status', daemonId: event.daemonId, bundleIds: [bundleId], now: event.now };
  const [next, response] = reduceLinkStore(state, reducerEvent);
  const written = event.type === 'upload' && response.ok ? event.envelope : null;
  const step = settle(bundleId, previous, next, response, written);
  return event.type === 'status' && response.ok && response.kind === 'status'
    ? { ...step, response: withStoredBytes(response, previous) }
    : step;
}

/** What a bundle object reads back from its storage. A document that does not parse is damage, never a link. */
export const BundleDocSchema = z.strictObject({
  row: z.strictObject({
    owner: z.string().min(1),
    kind: z.enum(['one-time', 'public']),
    sequence: z.number().int().min(1),
    notAfter: z.string().min(1),
    expiresAt: z.string().min(1).or(z.undefined()),
    installCap: z.number().int().min(1).or(z.undefined()),
    opens: z.number().int().min(0),
    fetchVerifier: z.string().min(1),
    state: z.enum(['live', 'used', 'ended', 'lapsed']),
    fetchTimes: z.array(z.number()),
    fetchDay: z.strictObject({ day: z.number(), count: z.number() }),
    purgeAt: z.number().nullable(),
  }),
  wrong: z.array(z.number()),
  chunks: z.number().int().min(0),
  bytes: z.number().int().min(0),
});

/** The reducer sizes a link from the bytes it is handed, and a status is handed none: say the stored size instead. */
function withStoredBytes(
  response: Extract<LinkStoreResponse, { kind: 'status' }>,
  previous: BundleDoc | null,
): LinkStoreResponse {
  const bytes = previous?.row.state === 'live' ? previous.bytes : 0;
  return {
    ...response,
    status: {
      ...response.status,
      links: response.status.links.map(link => ('storedBytes' in link ? { ...link, storedBytes: bytes } : link)),
    },
  };
}
