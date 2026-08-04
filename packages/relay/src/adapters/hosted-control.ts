/**
 * Cloudflare Durable Object adapter for hosted relay configuration, metering and admission.
 *
 * One globally named object serialises account-wide decisions. Per-daemon metric rows and socket
 * reservations are separate durable keys, so one daemon is never read as another and the global
 * document cannot grow past Durable Object value limits. Every mutation is a storage transaction:
 * a crash may over-refuse, but it cannot admit traffic whose accounting disappeared halfway
 * through a write.
 */

import { DaemonIdSchema } from '@ferretry/protocol';
import { z } from 'zod';
import {
  admitHostedRelayConnection,
  advertiseHostedRelay,
  configureHostedRelay,
  type HostedRelayConfiguration,
  HostedRelayConfigurationInputSchema,
  HostedRelayConfigurationSchema,
  type HostedRelayDaemonMetrics,
  HostedRelayDaemonMetricsSchema,
  type HostedRelayDecision,
  HostedRelayDecisionSchema,
  type HostedRelayGlobalMetrics,
  HostedRelayGlobalMetricsSchema,
  type HostedRelayReservation,
  HostedRelayReservationSchema,
  forgetHostedRelayDaemons,
  initialHostedRelayConfiguration,
  initialHostedRelayGlobalMetrics,
  inspectHostedRelayCapacity,
  meterHostedRelayRequest,
  RELAY_CLOSE_CODES,
  reclaimableHostedRelayDaemon,
  releaseHostedRelayConnection,
} from '../lib/index.ts';

export const HOSTED_RELAY_CONTROL_OBJECT_NAME = 'ferretry-relay-control/v1' as const;
export const HOSTED_RELAY_PUBLIC_PATH = '/v1/default-relay' as const;
export const HOSTED_RELAY_OPERATOR_CONFIG_PATH = '/v1/operator/config' as const;
export const HOSTED_RELAY_OPERATOR_METRICS_PATH = '/v1/operator/metrics' as const;

const INTERNAL_RESERVE_PATH = '/internal/reserve';
const INTERNAL_METER_PATH = '/internal/meter';
const INTERNAL_RELEASE_PATH = '/internal/release';
const INTERNAL_INSPECT_PATH = '/internal/inspect';
const CONFIGURATION_KEY = 'control:configuration';
const GLOBAL_METRICS_KEY = 'metrics:global';
const DAEMON_METRICS_PREFIX = 'metrics:daemon:';
const RESERVATION_PREFIX = 'reservation:';
const LIST_PAGE_SIZE = 1_000;

/**
 * How hard one admission is allowed to look for rows it may forget.
 *
 * Reclaiming runs only while the row census is full, and it runs inside the admission transaction,
 * so it has to be bounded rather than thorough. The budget covers more rows than the default census
 * holds, so an ordinary deployment proves its whole census in a single pass; a deployment whose
 * operator raised the ceiling past the budget relies on the cursor below instead. Forgetting a batch
 * rather than a single row means the next few first-time daemons are admitted without sweeping again.
 */
const RECLAIM_SCAN_PAGES = 12;
const RECLAIM_BATCH = 64;

/**
 * Where the next sweep resumes.
 *
 * A sweep that always restarted at the first key would only ever recover rows that sort early: if
 * the rows it can reach are all busy, every later admission re-reads the same prefix and a full
 * census stays full forever. Remembering how far the last pass got — and wrapping to the start once
 * the prefix runs out — turns a bounded pass into a cycle that eventually reaches every row, so the
 * ceiling is recoverable over the deployment's life rather than only near the front of the keyspace.
 */
const RECLAIM_CURSOR_KEY = 'control:reclaim-cursor';

const ReclaimCursorSchema = z.strictObject({
  /**
   * Checked as a key this object could actually have written, not merely as one with the right
   * prefix. A cursor is a position that decides which rows a sweep will never look at, so a value
   * nobody here could have produced is damaged control state rather than a harmless offset.
   */
  scannedThrough: z
    .string()
    .max(256)
    .refine(
      value =>
        value.startsWith(DAEMON_METRICS_PREFIX) &&
        DaemonIdSchema.safeParse(value.slice(DAEMON_METRICS_PREFIX.length)).success,
      'cursor is not a daemon metric key',
    )
    .nullable(),
});
type ReclaimCursor = z.infer<typeof ReclaimCursorSchema>;

interface ReclaimSweep {
  /** Rows this pass may delete, already validated, capped at {@link RECLAIM_BATCH}. */
  readonly keys: readonly string[];
  /** How many rows this pass actually read. */
  readonly observed: number;
  /** True when this pass read the entire prefix, so `observed` is the exact durable row count. */
  readonly proven: boolean;
  readonly cursor: ReclaimCursor;
}

const ReserveRequestSchema = z.strictObject({
  daemonId: DaemonIdSchema,
  reservationId: HostedRelayReservationSchema.shape.reservationId,
});
const MeterRequestSchema = z.strictObject({ daemonId: DaemonIdSchema, bytes: z.number().int().nonnegative() });
const ReleaseRequestSchema = z.strictObject({ reservationId: HostedRelayReservationSchema.shape.reservationId });
const InspectRequestSchema = z.strictObject({ daemonId: DaemonIdSchema });

export interface HostedRelayControlStorageRead {
  get<T>(key: string): Promise<T | undefined>;
  list<T>(options: {
    readonly prefix: string;
    readonly startAfter?: string;
    readonly limit: number;
  }): Promise<Map<string, T>>;
}

export interface HostedRelayControlStorageTransaction extends HostedRelayControlStorageRead {
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface HostedRelayControlStorage extends HostedRelayControlStorageTransaction {
  transaction<T>(closure: (transaction: HostedRelayControlStorageTransaction) => Promise<T>): Promise<T>;
}

export interface HostedRelayControlObjectState {
  readonly storage: HostedRelayControlStorage;
}

export interface HostedRelayControlRuntime {
  now(): number;
}

export interface HostedRelayControlNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

export const hostedRelayControlRuntime: HostedRelayControlRuntime = { now: () => Date.now() };

interface LoadedControl {
  readonly configured: boolean;
  readonly configuration: HostedRelayConfiguration;
  readonly global: HostedRelayGlobalMetrics;
}

type LoadResult =
  | { readonly ok: true; readonly value: LoadedControl }
  | { readonly ok: false; readonly reason: string };

/** The named stub every Worker and rendezvous uses; there is exactly one global meter per deployment. */
export function hostedRelayControlStub(namespace: HostedRelayControlNamespace) {
  return namespace.get(namespace.idFromName(HOSTED_RELAY_CONTROL_OBJECT_NAME));
}

/** Ask the global object for a typed permit/refusal. Any transport or parsing failure is unknown. */
export async function requestHostedRelayDecision(
  namespace: HostedRelayControlNamespace,
  path: 'reserve' | 'meter' | 'inspect',
  input: unknown,
): Promise<HostedRelayDecision | null> {
  const internalPath =
    path === 'reserve' ? INTERNAL_RESERVE_PATH : path === 'meter' ? INTERNAL_METER_PATH : INTERNAL_INSPECT_PATH;
  try {
    const response = await hostedRelayControlStub(namespace).fetch(
      new Request(`https://relay-control.invalid${internalPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
    );
    if (!response.ok) return null;
    const parsed = HostedRelayDecisionSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Release is idempotent because both close and error callbacks may describe the same socket. */
export async function releaseHostedRelayReservation(
  namespace: HostedRelayControlNamespace,
  reservationId: string,
): Promise<boolean> {
  try {
    const response = await hostedRelayControlStub(namespace).fetch(
      new Request(`https://relay-control.invalid${INTERNAL_RELEASE_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reservationId }),
      }),
    );
    if (!response.ok) return false;
    const parsed = HostedRelayDecisionSchema.safeParse(await response.json());
    return parsed.success && parsed.data.ok;
  } catch {
    return false;
  }
}

export class HostedRelayControlDurableObject {
  constructor(
    private readonly objectState: HostedRelayControlObjectState,
    _environment: unknown,
    private readonly runtime: HostedRelayControlRuntime = hostedRelayControlRuntime,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/public/configuration') return this.publicConfiguration();
    if (path === '/operator/configuration') {
      if (request.method === 'GET') return this.operatorConfiguration();
      if (request.method === 'PUT') return this.configure(request);
    }
    if (request.method === 'GET' && path === '/operator/metrics') return this.operatorMetrics();
    if (request.method !== 'POST') return textResponse('not found', 404);
    if (path === INTERNAL_RESERVE_PATH) return this.reserve(request);
    if (path === INTERNAL_METER_PATH) return this.meter(request);
    if (path === INTERNAL_RELEASE_PATH) return this.release(request);
    if (path === INTERNAL_INSPECT_PATH) return this.inspect(request);
    return textResponse('not found', 404);
  }

  private async publicConfiguration(): Promise<Response> {
    const loaded = await this.load(this.objectState.storage);
    if (!loaded.ok) return unavailable(loaded.reason, true);
    return jsonResponse(advertiseHostedRelay(loaded.value.configuration), 200, true);
  }

  private async operatorConfiguration(): Promise<Response> {
    const loaded = await this.load(this.objectState.storage);
    if (!loaded.ok) return unavailable(loaded.reason);
    return jsonResponse({
      configured: loaded.value.configured,
      configuration: loaded.value.configuration,
    });
  }

  private async configure(request: Request): Promise<Response> {
    const input = await parsedBody(request, HostedRelayConfigurationInputSchema);
    if (input === null) return jsonResponse({ error: 'invalid hosted relay configuration' }, 400);
    const now = this.runtime.now();
    const result = await this.objectState.storage.transaction(async transaction => {
      const loaded = await this.load(transaction);
      if (!loaded.ok) return loaded;
      const configuration = configureHostedRelay(input, now);
      const global = loaded.value.configured ? loaded.value.global : initialHostedRelayGlobalMetrics(now);
      await transaction.put(CONFIGURATION_KEY, configuration);
      await transaction.put(GLOBAL_METRICS_KEY, global);
      return { ok: true as const, value: { configured: true, configuration, global } };
    });
    if (!result.ok) return unavailable(result.reason);
    return jsonResponse({ configured: true, configuration: result.value.configuration });
  }

  private async reserve(request: Request): Promise<Response> {
    const input = await parsedBody(request, ReserveRequestSchema);
    if (input === null) return jsonResponse({ error: 'invalid relay reservation' }, 400);
    const now = this.runtime.now();
    const result = await this.objectState.storage.transaction(async transaction => {
      const loaded = await this.load(transaction);
      if (!loaded.ok) return loaded;
      if (!loaded.value.configured) {
        return {
          ok: true as const,
          value: { decision: disabledDecision('hosted relay is not configured') },
        };
      }
      const reservationKey = `${RESERVATION_PREFIX}${input.reservationId}`;
      if ((await transaction.get(reservationKey)) !== undefined) {
        return { ok: true as const, value: { decision: internalDecision('relay reservation already exists') } };
      }
      const daemonResult = await this.daemonMetrics(transaction, input.daemonId);
      if (!daemonResult.ok) return daemonResult;

      // A first-time daemon meeting a full row census gets one bounded attempt to reclaim rows that
      // finished their accounting day, so the ceiling stays a ceiling instead of becoming permanent.
      let global = loaded.value.global;
      if (daemonResult.value === null && global.trackedDaemons >= loaded.value.configuration.limits.maxTrackedDaemons) {
        const cursor = await readReclaimCursor(transaction);
        if (!cursor.ok) return cursor;
        const sweep = await sweepDaemonRows(transaction, cursor.value, now);
        if (!sweep.ok) return sweep;
        /**
         * A census that already disagrees with storage is damaged, and deleting rows would bury the
         * disagreement rather than settle it. A pass that read the whole prefix knows the exact row
         * count and demands it match; a partial pass can still prove damage by reading more rows
         * than the census claims exist in total.
         */
        if (
          sweep.value.proven
            ? sweep.value.observed !== global.trackedDaemons
            : sweep.value.observed > global.trackedDaemons
        ) {
          return { ok: false as const, reason: 'relay metrics and daemon rows disagree' };
        }
        // Recorded whether or not anything was reclaimed: a pass that found only busy rows still has
        // to hand the next one somewhere new to look.
        await transaction.put(RECLAIM_CURSOR_KEY, sweep.value.cursor);
        if (sweep.value.keys.length !== 0) {
          const forgotten = forgetHostedRelayDaemons(global, sweep.value.keys.length);
          if (forgotten === null) return { ok: false as const, reason: 'relay daemon census is damaged' };
          for (const key of sweep.value.keys) await transaction.delete(key);
          global = forgotten;
        }
      }

      const transition = admitHostedRelayConnection(
        loaded.value.configuration,
        global,
        daemonResult.value,
        input.daemonId,
        now,
      );
      await transaction.put(GLOBAL_METRICS_KEY, transition.global);
      if (transition.daemon !== null) await transaction.put(daemonKey(input.daemonId), transition.daemon);
      if (transition.decision.ok) {
        await transaction.put(reservationKey, {
          reservationId: input.reservationId,
          daemonId: input.daemonId,
          openedAt: now,
        } satisfies HostedRelayReservation);
      }
      return { ok: true as const, value: { decision: transition.decision } };
    });
    if (!result.ok) return unavailable(result.reason);
    return jsonResponse(result.value.decision);
  }

  private async meter(request: Request): Promise<Response> {
    const input = await parsedBody(request, MeterRequestSchema);
    if (input === null) return jsonResponse({ error: 'invalid relay meter event' }, 400);
    const now = this.runtime.now();
    const result = await this.objectState.storage.transaction(async transaction => {
      const loaded = await this.load(transaction);
      if (!loaded.ok) return loaded;
      if (!loaded.value.configured) {
        return {
          ok: true as const,
          value: { decision: disabledDecision('hosted relay is not configured') },
        };
      }
      const daemonResult = await this.daemonMetrics(transaction, input.daemonId);
      if (!daemonResult.ok) return daemonResult;
      if (daemonResult.value === null) {
        return { ok: true as const, value: { decision: internalDecision('daemon metrics are lost') } };
      }
      const transition = meterHostedRelayRequest(
        loaded.value.configuration,
        loaded.value.global,
        daemonResult.value,
        input.bytes,
        now,
      );
      await transaction.put(GLOBAL_METRICS_KEY, transition.global);
      if (transition.daemon !== null) await transaction.put(daemonKey(input.daemonId), transition.daemon);
      return { ok: true as const, value: { decision: transition.decision } };
    });
    if (!result.ok) return unavailable(result.reason);
    return jsonResponse(result.value.decision);
  }

  private async inspect(request: Request): Promise<Response> {
    const input = await parsedBody(request, InspectRequestSchema);
    if (input === null) return jsonResponse({ error: 'invalid relay inspection' }, 400);
    const loaded = await this.load(this.objectState.storage);
    if (!loaded.ok) return unavailable(loaded.reason);
    if (!loaded.value.configured) return jsonResponse(disabledDecision('hosted relay is not configured'));
    const daemonResult = await this.daemonMetrics(this.objectState.storage, input.daemonId);
    if (!daemonResult.ok) return unavailable(daemonResult.reason);
    return jsonResponse(
      inspectHostedRelayCapacity(
        loaded.value.configuration,
        loaded.value.global,
        daemonResult.value,
        this.runtime.now(),
      ),
    );
  }

  private async release(request: Request): Promise<Response> {
    const input = await parsedBody(request, ReleaseRequestSchema);
    if (input === null) return jsonResponse({ error: 'invalid relay release' }, 400);
    const now = this.runtime.now();
    const result = await this.objectState.storage.transaction(async transaction => {
      const loaded = await this.load(transaction);
      if (!loaded.ok) return loaded;
      const reservationKey = `${RESERVATION_PREFIX}${input.reservationId}`;
      const rawReservation = await transaction.get(reservationKey);
      if (rawReservation === undefined) return { ok: true as const, value: { decision: { ok: true as const } } };
      const parsedReservation = HostedRelayReservationSchema.safeParse(rawReservation);
      if (!parsedReservation.success) return { ok: false as const, reason: 'relay reservation state is damaged' };
      const daemonResult = await this.daemonMetrics(transaction, parsedReservation.data.daemonId);
      if (!daemonResult.ok) return daemonResult;
      if (daemonResult.value === null) return { ok: false as const, reason: 'daemon metrics are lost' };
      const transition = releaseHostedRelayConnection(loaded.value.global, daemonResult.value, now);
      if (!transition.decision.ok) {
        return { ok: false as const, reason: transition.decision.reason };
      }
      await transaction.put(GLOBAL_METRICS_KEY, transition.global);
      if (transition.daemon !== null) {
        await transaction.put(daemonKey(parsedReservation.data.daemonId), transition.daemon);
      }
      await transaction.delete(reservationKey);
      return { ok: true as const, value: { decision: transition.decision } };
    });
    if (!result.ok) return unavailable(result.reason);
    return jsonResponse(result.value.decision);
  }

  private async operatorMetrics(): Promise<Response> {
    const loaded = await this.load(this.objectState.storage);
    if (!loaded.ok) return unavailable(loaded.reason);
    const daemonEntries = await listAll(this.objectState.storage, DAEMON_METRICS_PREFIX);
    const reservationEntries = await listAll(this.objectState.storage, RESERVATION_PREFIX);
    const daemons: HostedRelayDaemonMetrics[] = [];
    const reservationCounts = new Map<string, number>();

    for (const [key, raw] of daemonEntries) {
      const parsed = HostedRelayDaemonMetricsSchema.safeParse(raw);
      if (!parsed.success || key !== daemonKey(parsed.data.daemonId)) {
        return unavailable('daemon metrics are damaged');
      }
      daemons.push(parsed.data);
    }
    for (const [key, raw] of reservationEntries) {
      const parsed = HostedRelayReservationSchema.safeParse(raw);
      if (!parsed.success || key !== `${RESERVATION_PREFIX}${parsed.data.reservationId}`) {
        return unavailable('relay reservation state is damaged');
      }
      reservationCounts.set(parsed.data.daemonId, (reservationCounts.get(parsed.data.daemonId) ?? 0) + 1);
    }
    if (
      loaded.value.global.trackedDaemons !== daemons.length ||
      loaded.value.global.concurrentConnections !== reservationEntries.length ||
      daemons.some(daemon => daemon.concurrentConnections !== (reservationCounts.get(daemon.daemonId) ?? 0)) ||
      [...reservationCounts.keys()].some(daemonId => !daemons.some(daemon => daemon.daemonId === daemonId))
    ) {
      return unavailable('relay metrics and reservations disagree');
    }
    daemons.sort((left, right) => left.daemonId.localeCompare(right.daemonId));
    return jsonResponse({
      configured: loaded.value.configured,
      configuration: loaded.value.configuration,
      global: loaded.value.global,
      daemons,
      observedAt: this.runtime.now(),
    });
  }

  private async load(storage: HostedRelayControlStorageRead): Promise<LoadResult> {
    const [rawConfiguration, rawGlobal] = await Promise.all([
      storage.get(CONFIGURATION_KEY),
      storage.get(GLOBAL_METRICS_KEY),
    ]);
    if (rawConfiguration === undefined && rawGlobal === undefined) {
      const [daemonEvidence, reservationEvidence] = await Promise.all([
        storage.list({ prefix: DAEMON_METRICS_PREFIX, limit: 1 }),
        storage.list({ prefix: RESERVATION_PREFIX, limit: 1 }),
      ]);
      if (daemonEvidence.size !== 0 || reservationEvidence.size !== 0) {
        return { ok: false, reason: 'relay control state is incomplete' };
      }
      const now = this.runtime.now();
      return {
        ok: true,
        value: {
          configured: false,
          configuration: initialHostedRelayConfiguration(now),
          global: initialHostedRelayGlobalMetrics(now),
        },
      };
    }
    if (rawConfiguration === undefined || rawGlobal === undefined) {
      return { ok: false, reason: 'relay control state is incomplete' };
    }
    const configuration = HostedRelayConfigurationSchema.safeParse(rawConfiguration);
    const global = HostedRelayGlobalMetricsSchema.safeParse(rawGlobal);
    if (!configuration.success || !global.success) return { ok: false, reason: 'relay control state is damaged' };
    return { ok: true, value: { configured: true, configuration: configuration.data, global: global.data } };
  }

  private async daemonMetrics(
    storage: HostedRelayControlStorageRead,
    daemonId: string,
  ): Promise<
    | { readonly ok: true; readonly value: HostedRelayDaemonMetrics | null }
    | { readonly ok: false; readonly reason: string }
  > {
    const raw = await storage.get(daemonKey(daemonId));
    if (raw === undefined) return { ok: true, value: null };
    const parsed = HostedRelayDaemonMetricsSchema.safeParse(raw);
    if (!parsed.success || parsed.data.daemonId !== daemonId) {
      return { ok: false, reason: 'daemon metrics are damaged' };
    }
    return { ok: true, value: parsed.data };
  }
}

function daemonKey(daemonId: string): string {
  return `${DAEMON_METRICS_PREFIX}${DaemonIdSchema.parse(daemonId)}`;
}

/** Where the last sweep stopped. An unreadable cursor is damaged state, not a fresh start. */
async function readReclaimCursor(
  storage: HostedRelayControlStorageRead,
): Promise<{ readonly ok: true; readonly value: ReclaimCursor } | { readonly ok: false; readonly reason: string }> {
  const raw = await storage.get(RECLAIM_CURSOR_KEY);
  if (raw === undefined) return { ok: true, value: { scannedThrough: null } };
  const parsed = ReclaimCursorSchema.safeParse(raw);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: 'relay reclaim cursor is damaged' };
}

/**
 * Read one bounded window of daemon rows and report which of them may be forgotten.
 *
 * Every row it reads is validated first. A row that will not parse, or whose key disagrees with the
 * fingerprint inside it, stops the sweep with an error: deleting evidence nobody can read is how a
 * live daemon loses the reservation that was holding its slot, so ambiguity fails closed here.
 *
 * The window always advances. Whether it fills its batch, runs out of budget or runs off the end of
 * the prefix, the returned cursor is somewhere the next pass has not already been.
 */
async function sweepDaemonRows(
  storage: HostedRelayControlStorageRead,
  cursor: ReclaimCursor,
  at: number,
): Promise<{ readonly ok: true; readonly value: ReclaimSweep } | { readonly ok: false; readonly reason: string }> {
  const keys: string[] = [];
  const fromStart = cursor.scannedThrough === null;
  let scannedThrough = cursor.scannedThrough;
  let observed = 0;
  let exhausted = false;
  let batched = false;

  for (let page = 0; page < RECLAIM_SCAN_PAGES && !exhausted && !batched; page += 1) {
    const rows = await storage.list<unknown>({
      prefix: DAEMON_METRICS_PREFIX,
      limit: LIST_PAGE_SIZE,
      ...(scannedThrough === null ? {} : { startAfter: scannedThrough }),
    });
    for (const [key, raw] of rows) {
      const parsed = HostedRelayDaemonMetricsSchema.safeParse(raw);
      if (!parsed.success || key !== daemonKey(parsed.data.daemonId)) {
        return { ok: false, reason: 'daemon metrics are damaged' };
      }
      observed += 1;
      scannedThrough = key;
      if (reclaimableHostedRelayDaemon(parsed.data, at)) keys.push(key);
      if (keys.length === RECLAIM_BATCH) {
        batched = true;
        break;
      }
    }
    // A short page means the end of the prefix only when the pass actually read all of it. Stopping
    // mid-page on a full batch leaves rows behind, and calling that a complete census would both
    // lose the cursor's place and let a partial count masquerade as the durable row total.
    if (!batched && rows.size < LIST_PAGE_SIZE) exhausted = true;
  }

  return {
    ok: true,
    value: {
      keys,
      observed,
      proven: fromStart && exhausted,
      cursor: { scannedThrough: exhausted ? null : scannedThrough },
    },
  };
}

async function listAll(storage: HostedRelayControlStorageRead, prefix: string): Promise<readonly [string, unknown][]> {
  const entries: [string, unknown][] = [];
  let startAfter: string | undefined;
  for (;;) {
    const page = await storage.list({
      prefix,
      limit: LIST_PAGE_SIZE,
      ...(startAfter === undefined ? {} : { startAfter }),
    });
    entries.push(...page.entries());
    if (page.size < LIST_PAGE_SIZE) return entries;
    startAfter = [...page.keys()].at(-1);
    if (startAfter === undefined) return entries;
  }
}

async function parsedBody<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T> | null> {
  try {
    const parsed = schema.safeParse(await request.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function disabledDecision(reason: string): HostedRelayDecision {
  return { ok: false, code: RELAY_CLOSE_CODES.hostedDisabled, reason };
}

function internalDecision(reason: string): HostedRelayDecision {
  return { ok: false, code: RELAY_CLOSE_CODES.relayInternal, reason };
}

function jsonResponse(value: unknown, status = 200, publicResponse = false): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      ...(publicResponse ? { 'Access-Control-Allow-Origin': '*' } : {}),
    },
  });
}

function textResponse(value: string, status: number): Response {
  return new Response(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

function unavailable(reason: string, publicResponse = false): Response {
  return jsonResponse({ error: reason }, 503, publicResponse);
}
