/**
 * Drives a mount's route table the way the spine does: one `CallContext` made from Gate's test standings, the handler
 * called, and its answer (or the refusal it threw) read back as `{ status, code, body }`.
 */
import { ApiError, type ApiResponse, type CallContext, type CallStanding } from '@ferretry/kernel/contract';
import { deviceStanding, ownerStanding } from '@ferretry/core-gate/contract/testing';
import { owner, testArrival } from '@ferretry/kernel/testing';
import type { MountedRoute } from '../../../../daemon/lib/http/routes.ts';

export interface Answer {
  readonly status: number;
  readonly code?: string;
  readonly body: unknown;
}

export interface CallOptions {
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  /** Text sent as the body, taking precedence over `body`: for a body that is not JSON. */
  readonly raw?: string;
  readonly standing?: CallStanding;
}

type Governance = NonNullable<CallStanding['governance']>;

/** A paired device whose grants answer every demand with `decision`, recording the demands made. */
export function governedDevice(
  decision: ReturnType<Governance['decide']>,
  asked: unknown[] = [],
  claims: Partial<Pick<CallStanding, 'claimFreshStepUp' | 'claimStoredProof'>> = {},
  deviceId = 'phone-1',
): CallStanding {
  return {
    ...deviceStanding(deviceId),
    governance: {
      governed: true,
      decide: demand => {
        asked.push(demand);
        return decision;
      },
    } as Governance,
    ...claims,
  };
}

/** A paired device the grants allow everything. */
export const allowedDevice = (claims: Parameters<typeof governedDevice>[2] = {}, deviceId?: string): CallStanding =>
  governedDevice({ allowed: true, refusal: 'granted' }, [], claims, deviceId);

/** A paired device the grants allow everything but the named capabilities, which they refuse (`not-granted`). */
export const without = (
  denied: readonly string[],
  claims: Parameters<typeof governedDevice>[2] = {},
  deviceId?: string,
) =>
  ({
    ...allowedDevice(claims, deviceId),
    governance: {
      governed: true,
      decide: (demand: { capability: string }) =>
        denied.includes(demand.capability)
          ? { allowed: false, refusal: 'not-granted' as const }
          : { allowed: true, refusal: 'granted' as const },
    },
  }) as CallStanding;

/** The owner at the machine, with the step-up claims a test may need. */
export const machine = (claims: Partial<Pick<CallStanding, 'claimFreshStepUp' | 'claimStoredProof'>> = {}) => ({
  ...ownerStanding(),
  ...claims,
});

const parsed = (text: unknown): unknown => {
  try {
    return JSON.parse(String(text));
  } catch {
    return text;
  }
};

const answerOf = (response: ApiResponse): Answer => {
  const body = parsed(response.body);
  const code = typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : undefined;
  return { status: response.status, ...(typeof code === 'string' ? { code } : {}), body };
};

/** A route table's driver: `call('GET', '/v1/copy-rules')` finds the route and runs it as the standing says. */
export function driverOf(routes: readonly MountedRoute[]) {
  return async (method: MountedRoute['method'], path: string, options: CallOptions = {}): Promise<Answer> => {
    const route = routes.find(candidate => candidate.method === method && candidate.path === path);
    if (route === undefined) throw new Error(`no route ${method} ${path} is mounted`);
    const text = options.raw ?? (options.body === undefined ? '' : JSON.stringify(options.body));
    const context = {
      request: {
        method,
        path,
        query: new Map(Object.entries(options.query ?? {}).map(([key, value]) => [key, [value]])),
        headers: new Map(),
        arrival: testArrival(owner()),
        text: async () => text,
      },
      params: new Map(Object.entries(options.params ?? {})),
      ...(options.standing ?? ownerStanding()),
    } as unknown as CallContext;
    try {
      return answerOf(await route.handle(context));
    } catch (error) {
      if (error instanceof ApiError) return { status: error.status, code: error.code, body: error.message };
      throw error;
    }
  };
}
