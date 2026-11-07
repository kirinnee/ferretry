import type { ApiRequest, ApiResponse, CallContext } from '@ferretry/kernel/contract';
import { ApiError, queryFrom } from '@ferretry/kernel/contract';
import type { AuthenticatedCredential, CallerGovernance } from '@ferretry/core-gate/contract';
import type { GrantRefusal } from '@ferretry/core-gate/contract';
import type { RunManifest } from '../../contract/index.ts';
import { lessonsRoutes, type LessonsSubsystem } from '../../daemon/routes.ts';
import { SerialSection } from '../../daemon/lib/index.ts';
import manifest from '../../manifest.ts';
import { AT, type FakeLessonsStore, type LessonsWorld, LESSONS_CONFIG, lessonsWorld } from './support.ts';

/** The parsed JSON body of a response. */
export function jsonBody(response: ApiResponse): Record<string, unknown> {
  return JSON.parse(String(response.body)) as Record<string, unknown>;
}

/** The lessons subsystem the daemon half builds, over `world`'s in-memory ports (the REAL service). */
export function lessonsSubsystem(store: FakeLessonsStore, world: LessonsWorld = lessonsWorld(store)): LessonsSubsystem {
  return {
    store,
    lessons: world.service,
    serial: new SerialSection(),
    config: async () => world.config,
    // The kernel writer's plain outcome: the patch is in effect at once (its held and refused answers are driven on the
    // real writer in parity/routes.test.ts).
    writeConfig: async patch => {
      world.config = { ...world.config, ...patch };
      return { kind: 'written', etag: 'etag-1', loosened: [] };
    },
    configHeld: () => false,
    now: () => AT,
    changed: () => {},
    run: async (spawn): Promise<RunManifest> => ({
      runId: 'run-1',
      startedAt: AT,
      finishedAt: AT,
      ferretsScanned: 0,
      ferretsWithSignal: 0,
      minerFerrets: [],
      observationsProposed: 0,
      observationsVerified: 0,
      rejectedQuotes: 0,
      malformedFiles: 0,
      proposalsCreated: 0,
      proposalsStrengthened: 0,
      proposalsSuppressedByTombstone: 0,
      perHarness: { 'claude-code': 0, codex: 0 },
      message: spawn ? 'no new stopped ferrets to scan' : 'ingest-only run (no spawn requested)',
    }),
  };
}

export { LESSONS_CONFIG };

/** Who is calling. Handlers decide on governance, a fresh step-up and the caller's kind. */
export interface Caller {
  readonly kind: 'host' | 'device' | 'agent';
  /** `undefined` means the daemon could not say what this caller may do at all. */
  readonly governed?: boolean;
  /** What the grants answer for every demand; `granted` unless the case says otherwise. */
  readonly refusal?: GrantRefusal;
  readonly fresh?: boolean;
  /** The ferret an `agent` caller is. */
  readonly ferret?: string;
}

export interface Call {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT';
  readonly path: string;
  readonly query?: readonly (readonly [string, string])[];
  readonly body?: unknown;
}

export interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
  /** How many times the handler spent the caller's fresh proof. */
  readonly spent: number;
}

export const HOST: Caller = { kind: 'host', governed: false };
export const DEVICE: Caller = { kind: 'device', governed: true };
export const FRESH_DEVICE: Caller = { kind: 'device', governed: true, fresh: true };
export const AGENT: Caller = { kind: 'agent', governed: false, ferret: 'ferret-1' };

const CALLER_CREDENTIAL = (caller: Caller): AuthenticatedCredential => {
  switch (caller.kind) {
    case 'host':
      return { kind: 'authenticated', tokenClass: 'admin' };
    case 'device':
      return { kind: 'authenticated', tokenClass: 'device', principal: {} as never };
    case 'agent':
      return { kind: 'authenticated', tokenClass: 'ferret', ferret: (caller.ferret ?? 'ferret-1') as never };
  }
};
const CALLER_ACTOR = (caller: Caller): string =>
  ({ host: 'admin-cli', device: 'device:d1', agent: `ferret:${caller.ferret ?? 'ferret-1'}` })[caller.kind];

/** The manifest's route whose method and path pattern match, with its captured parameters. */
function lookup(method: string, path: string): { readonly key: string; readonly params: Map<string, string> } {
  for (const route of manifest.actions.routes) {
    if (route.method !== method) continue;
    const pattern = route.path.split('/');
    const actual = path.split('/');
    if (pattern.length !== actual.length) continue;
    const params = new Map<string, string>();
    const fits = pattern.every((part, index) => {
      if (part.startsWith(':')) {
        params.set(part.slice(1), actual[index] as string);
        return true;
      }
      return part === actual[index];
    });
    if (fits) return { key: route.key, params };
  }
  throw new Error(`no route ${method} ${path}`);
}

function requestOf(input: Call): ApiRequest {
  const body = input.body === undefined ? '' : JSON.stringify(input.body);
  return {
    method: input.method,
    path: input.path,
    query: queryFrom(input.query ?? []),
    headers: new Map([['content-type', ['application/json']]]),
    arrival: {} as never,
    text: async () => body,
  } as unknown as ApiRequest;
}

/** Drives one lesson route as `caller`; an `ApiError` is read back as the response the kernel would make. */
export async function drive(subsystem: LessonsSubsystem, input: Call, caller: Caller = HOST): Promise<Answer> {
  const found = lookup(input.method, input.path);
  let spent = 0;
  const refusal = caller.refusal ?? 'granted';
  const governance: CallerGovernance | undefined =
    caller.governed === undefined
      ? undefined
      : { governed: caller.governed, decide: () => ({ allowed: refusal === 'granted', refusal }) };
  const context = {
    request: requestOf(input),
    params: found.params,
    actor: CALLER_ACTOR(caller),
    credential: CALLER_CREDENTIAL(caller),
    ...(governance === undefined ? {} : { governance }),
    presentation: {
      local: caller.kind !== 'device',
      adminToken: caller.kind === 'host',
      actor: CALLER_ACTOR(caller),
      stepUp: caller.fresh === true,
      freshStepUp: caller.fresh === true,
    },
    spendFreshStepUp: () => {
      spent += 1;
    },
  } as unknown as CallContext;
  const handler = (lessonsRoutes(subsystem) as Record<string, (call: CallContext) => Promise<ApiResponse>>)[found.key];
  if (handler === undefined) throw new Error(`no handler for ${found.key}`);
  let response: ApiResponse;
  try {
    response = await handler(context);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { status: error.status, body: { error: error.message, code: error.code }, spent };
  }
  return { status: response.status, body: jsonBody(response), spent };
}
