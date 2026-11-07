import type {
  ApiRequest,
  Arrival,
  CarrierKey,
  FerretId,
  HolderId,
  LocalArrival,
  RouteDescriptor,
  ScopedRoute,
  SessionId,
  SessionPrincipal,
} from '@ferretry/kernel/contract';
import { addDuration, epochMs, type Instant, instantFromEpochMs, minutes } from '@ferretry/std';
import {
  type AuditDraft,
  type CapabilityGrants,
  cap,
  DEFAULT_GATE_CONFIG,
  FULL_DEVICE_GRANTS,
  type GateConfig,
} from '../../../contract/index.ts';
import {
  FakeDeviceProvider,
  FakeFerretBearers,
  FakeStepUpWitness,
  holder,
  T0,
} from '../../../contract/testing/index.ts';
import { GateAdmission } from '../../../daemon/lib/api/admission.ts';
import { bearerDigest } from '../../../daemon/lib/api/authentication.ts';
import { FailClosedStepUps } from '../../../daemon/lib/step-up/witness.ts';

/** Fixed, fake tokens: never a real credential. */
export const ADMIN = 'admin-token-for-tests-0000000000000000000000';
export const WARDEN = 'warden-token-for-tests-000000000000000000000';
export const FERRET_TOKEN = `fys_${'a'.repeat(43)}`;
export const FERRET = 'F12' as FerretId;

/** Only the kernel's listener makes a local arrival; tests stand in for it. */
export const local = (privileged = false): Arrival => ({ kind: 'local', privileged }) as LocalArrival;
export const carried = (carrier = 'relay'): Arrival => ({ kind: 'carried', carrier: carrier as CarrierKey });

export interface RequestOptions {
  readonly method?: string;
  readonly path?: string;
  readonly arrival?: Arrival;
  readonly bearer?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly device?: string;
  readonly member?: string;
  readonly clientAddress?: string;
}

/** A call; reading its body throws, so a test proves a refusal came before the body was read. */
export function request(options: RequestOptions = {}): ApiRequest & { bodyRead: () => boolean } {
  let read = false;
  const headers = new Map<string, string>(Object.entries(options.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  if (options.bearer !== undefined) headers.set('authorization', `Bearer ${options.bearer}`);
  const who = options.device ?? options.member;
  const principal: SessionPrincipal | undefined =
    who === undefined
      ? undefined
      : {
          kind: options.device === undefined ? 'member' : 'device',
          holder: who as HolderId,
          session: `s-${who}` as SessionId,
          leaseUntil: addDuration(T0, minutes(15)),
        };
  return {
    method: options.method ?? 'GET',
    path: options.path ?? '/v1/test',
    query: new Map(),
    headers,
    arrival: options.arrival ?? (principal === undefined ? local() : carried()),
    ...(principal === undefined ? {} : { principal }),
    ...(options.clientAddress === undefined ? {} : { clientAddress: options.clientAddress }),
    text: async () => {
      read = true;
      throw new Error('a refusal must come before the body is read');
    },
    bodyRead: () => read,
  };
}

/** A descriptor with today's defaults: operator, any caller, nothing else. */
export function descriptor(fields: Partial<RouteDescriptor> = {}): ScopedRoute {
  return {
    method: 'GET',
    path: '/v1/test',
    minimum: 'operator',
    caller: 'any',
    audit: { skip: 'test' },
    guard: { none: 'test' },
    ...fields,
  };
}

export const terminalUse = descriptor({ capability: cap('terminal', 'use') });
export const fleetUse = descriptor({ capability: cap('fleet', 'use') });
export const fleetConfigure = descriptor({ capability: cap('fleet', 'configure') });

export interface World {
  readonly gate: GateAdmission;
  readonly devices: FakeDeviceProvider;
  readonly members: FakeDeviceProvider;
  readonly ferrets: FakeFerretBearers;
  /** Access's `step-up:device` value, as a fake with today's answers. */
  readonly stepUps: FakeStepUpWitness;
  readonly audits: AuditDraft[];
  readonly recorded: AuditDraft[];
  policy: GateConfig | undefined;
  now: Instant;
  devicesOff: boolean;
  /** No `step-up:device` provider (Access off), or one that throws. */
  stepUpsOff: boolean | 'throwing';
  /** Enrols a device, unlocked for an hour unless told otherwise. */
  enrol(id: string, grants?: CapabilityGrants, unlocked?: boolean): void;
}

export function world(initial: Partial<Pick<World, 'policy'>> = {}): World {
  const devices = new FakeDeviceProvider();
  const members = new FakeDeviceProvider();
  const ferrets = new FakeFerretBearers();
  ferrets.issue(bearerDigest(FERRET_TOKEN), FERRET);
  const audits: AuditDraft[] = [];
  const recorded: AuditDraft[] = [];
  const state: World = {
    devices,
    members,
    ferrets,
    audits,
    recorded,
    policy: 'policy' in initial ? initial.policy : DEFAULT_GATE_CONFIG,
    now: T0,
    devicesOff: false,
    stepUpsOff: false,
    stepUps: undefined as never,
    gate: undefined as never,
    enrol(id, grants = FULL_DEVICE_GRANTS, unlocked = true) {
      devices.enrol(holder(id), grants, unlocked ? addDuration(state.now, minutes(60)) : undefined);
    },
  };
  const stepUps = new FakeStepUpWitness({
    nowMs: () => epochMs(state.now),
    settings: () => state.policy?.security,
    unlockedUntil: deviceId => {
      const standing = devices.standing(holder(deviceId));
      return typeof standing === 'object' && standing.unlockedUntil !== undefined
        ? epochMs(standing.unlockedUntil)
        : undefined;
    },
  });
  const gate = new GateAdmission({
    tokens: () => ({ admin: ADMIN, warden: WARDEN }),
    ferrets: () => ferrets,
    devices: () => (state.devicesOff ? undefined : devices),
    members: () => members as never,
    policy: () => state.policy,
    stepUps: new FailClosedStepUps(() => {
      if (state.stepUpsOff === 'throwing') throw new Error('the step-up provider failed');
      return state.stepUpsOff ? undefined : stepUps;
    }),
    now: () => state.now,
    refused: draft => audits.push(draft),
    recorded: draft => recorded.push(draft),
    clientName: 'fy',
  });
  Object.assign(state, { gate, stepUps });
  return state;
}

/** The status and code a decision answers with, or `admitted`. */
export function outcome(decision: ReturnType<GateAdmission['admit']>): string {
  if (decision.outcome === 'admitted') return 'admitted';
  const body = JSON.parse(String(decision.response.body)) as { code?: string };
  return `${decision.response.status} ${body.code ?? ''}`.trim();
}

export function admit(w: World, route: ScopedRoute, options: RequestOptions = {}) {
  const call = request({ method: route.method, path: route.path, ...options });
  const decision = w.gate.admit({ table: 'route', descriptor: route, request: call, params: new Map() });
  return { decision, outcome: outcome(decision), call };
}

export const later = (instant: Instant, ms: number): Instant => instantFromEpochMs(epochMs(instant) + ms);
