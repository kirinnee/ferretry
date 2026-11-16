/**
 * The route-test harness: today's helpers by name, over the new handler map. A request is matched against the
 * manifest's own descriptors (the kernel's route table), admitted by Gate's stand-in admission with a Gate standing,
 * and handed to the handler, so a case still reads as today's: who calls, what they send, what comes back.
 *
 * A caller is a standing now, not headers: the owner's CLI and app hold the admin token, a ferret its own token, a
 * paired device its key. A case may still add real headers (`x-ferretry-…`) beside the caller.
 */
import {
  deviceStanding,
  ferretStanding,
  ownerStanding,
  StandInAdmission,
  wardenStanding,
} from '@ferretry/core-gate/contract/testing';
import {
  ApiError,
  type ApiRequest,
  type ApiResponse,
  type CallStanding,
  errorResponse,
  type FerretId,
  type RouteHandler,
} from '@ferretry/kernel/contract';
import { owner, RouteTable, testArrival } from '@ferretry/kernel/testing';
import {
  type AgendaLedger,
  type AgendaLedgerRepository,
  type AgendaMutation,
  type AgendaRepliesSubsystem,
  AgendaService,
} from '../../../../daemon/lib/agenda/index.ts';
import manifest from '../../../../manifest.ts';

const AT = '2024-05-01T10:00:00.000Z';
export const FERRET_SESSION = 'ferret-own';

/** The human's CLI: the admin token at the machine. */
export const human: CallStanding = ownerStanding('cli');
/** A ferret, on its own token. */
export const agentIn = (sessionId: string): CallStanding => ferretStanding(sessionId as FerretId);
/** The ferret whose own credential a case presents. */
export const ferretOwn: CallStanding = ferretStanding(FERRET_SESSION as FerretId);
/** A paired device. */
export const device = (id = 'phone'): CallStanding => deviceStanding(id);
/** The warden token. */
export const warden: CallStanding = wardenStanding('w1' as FerretId);

/** A ledger under the test's control: the domain rules are real, the storage is not. */
export class FakeLedgerRepository implements AgendaLedgerRepository {
  constructor(private ledger: AgendaLedger | null = null) {}

  async read(): Promise<AgendaLedger | null> {
    return this.ledger;
  }

  async transact(_sessionId: string, apply: (current: AgendaLedger | null) => AgendaMutation): Promise<AgendaMutation> {
    const mutation = apply(this.ledger);
    if (mutation.ok) this.ledger = mutation.ledger;
    return mutation;
  }
}

/** An agenda service over an in-memory ledger, with a fixed instant. */
export function agendaService(repository: AgendaLedgerRepository = new FakeLedgerRepository()): AgendaService {
  return new AgendaService(
    repository,
    { now: () => AT },
    { has: async sessionId => sessionId === 's1' || sessionId === FERRET_SESSION },
    { raised: async () => undefined },
  );
}

export const NO_HELD_REPLIES: AgendaRepliesSubsystem = {
  pending: async () => undefined,
  delivery: async () => undefined,
  sendNow: async () => undefined,
};

export interface RequestOverrides {
  readonly method?: string;
  readonly path?: string;
  /** Who calls (a standing), with any real request headers beside it. */
  readonly headers?: CallStanding | Readonly<Record<string, unknown>>;
  readonly body?: string;
  readonly query?: readonly (readonly [string, string])[];
}

const STANDING_KEYS = new Set([
  'actor',
  'credential',
  'presentation',
  'governance',
  'wardenRemedy',
  'spendStepUp',
  'spendFreshStepUp',
  'claimFreshStepUp',
  'claimStoredProof',
]);

/** Splits what a case passed as `headers` into the caller's standing and the real headers. */
function callerOf(given: RequestOverrides['headers']): {
  standing: CallStanding | undefined;
  headers: Map<string, string>;
} {
  const headers = new Map<string, string>();
  if (given === NO_CALLER) return { standing: undefined, headers };
  const standing: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(given ?? human)) {
    if (STANDING_KEYS.has(key)) standing[key] = value;
    else if (typeof value === 'string') headers.set(key.toLowerCase(), value);
  }
  return { standing: Object.keys(standing).length === 0 ? human : (standing as CallStanding), headers };
}

/** Dispatches requests to these handlers as the daemon would: route table, admission, handler, error answer. */
export function routeDispatcher(handlers: Readonly<Record<string, RouteHandler>>) {
  const declared = (manifest.actions?.routes ?? []).filter(route => handlers[route.key] !== undefined);
  const table = new RouteTable(declared);
  return async (overrides: RequestOverrides = {}): Promise<ApiResponse> => {
    const { standing, headers } = callerOf(overrides.headers);
    const query = new Map<string, string[]>();
    for (const [key, value] of overrides.query ?? []) query.set(key, [...(query.get(key) ?? []), value]);
    const request: ApiRequest = {
      method: overrides.method ?? 'GET',
      path: overrides.path ?? '/',
      query,
      headers,
      arrival: testArrival(owner()),
      text: async () => overrides.body ?? '',
    };
    const found = table.lookup(request.method, request.path);
    if (found.kind === 'not-found') return errorResponse(404, 'not found', 'not_found');
    if (found.kind === 'method-not-allowed') return errorResponse(405, 'method not allowed', 'method_not_allowed');
    const decision = new StandInAdmission(() => standing).admit({
      table: 'route',
      descriptor: found.route,
      request,
      params: found.params,
    });
    if (decision.outcome === 'refused') return decision.response;
    const handler = handlers[found.route.key];
    if (handler === undefined) return errorResponse(404, 'not found', 'not_found');
    let response: ApiResponse;
    try {
      response = await handler({ request, params: found.params, ...(standing ?? {}) });
    } catch (error) {
      // As the kernel's dispatcher: a refusal is answered as itself, anything else is the daemon's fault.
      response =
        error instanceof ApiError
          ? errorResponse(error.status, error.message, error.code, error.extra)
          : errorResponse(500, 'the daemon failed to handle this request', 'internal_error');
    }
    return found.route.noStore === true
      ? { ...response, headers: new Map([...response.headers, ['cache-control', 'no-store']]) }
      : response;
  };
}

export function jsonBody(response: ApiResponse): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

/** No credential at all: Gate answers 401. */
export const NO_CALLER = { [Symbol.for('no-caller')]: true } as const;
