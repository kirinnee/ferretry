/**
 * One place that says where each name the daemon half took from today's `@ferretry/protocol` and `daemon/src/lib/api`
 * lives in 5.0: Access's own contract, Gate's contract, the kernel leaf, Connections' contract or std. The copied
 * files import from here so the move changed one import line per file, not their bodies.
 */
export * from '../../contract/index.ts';
export {
  ApiError,
  type ApiRequest,
  type ApiResponse,

  arrivedOnHost,
  type CallContext,
  type CapabilityAxis,
  type CapabilityDemand,
  decodeParameter,
  errorResponse,
  jsonResponse,
} from '@ferretry/kernel/contract';
export {
  asksStepUpPerAction,
  type CallerGovernance,
  CAPABILITY_NAMES,
  CAPABILITY_NAMES as DAEMON_CAPABILITIES,
  type CapabilityGrant,
  type CapabilityGrants,
  CapabilityGrantsSchema,
  type CapabilityName,
  type CapabilityName as DaemonCapability,
  type CapabilityPresentation,
  DEVICE_ACTOR_PREFIX,
  type EveryCallerStepUpAct,
  FULL_DEVICE_GRANTS,
  type GrantDecision,
  type GrantRefusal,
  grantRefusalCode,
  isReservedActorPhrase,
  LIMITED_DEVICE_GRANTS,
  type MachineSkippableStepUpAct,
  ReadCapabilityGrantsSchema,
  SECURITY_SETTING_BOUNDS,
  type SecuritySettings,
  STEP_UP_ACTS,
  STEP_UP_REQUIRED_CODE,
  STEP_UP_SUBJECTS,
  type StepUpAct,
  type StepUpDemand,
  type StepUpRefusal,
  type StepUpRequiredBody,
  type StepUpSubjectOf,
  type StoredProofStepUpAct,
  UnlockGrantedSchema,
  stepUpKeepsProof,
  stepUpRefusalCode,
  stepUpSkippableAtMachine,
} from '@ferretry/core-gate/contract';
export {
  type PublishedCarrier as DaemonCarrier,
  type PublishedCarriers as DaemonCarriers,
  PublishedCarriersSchema,
} from '@ferretry/plugin-connections/contract';
export { type Instant, InstantSchema, instantFromEpochMs } from '@ferretry/std';
export type { CapabilityGuard } from './grants/types.ts';
export { parseBody, parseOptionalBody } from './body.ts';
export { DeviceKeySchema } from './proof/device-proof.ts';

/** Today's `RouteContext`: the call as a handler sees it (Gate fills the standing). */
export type RouteContext = import('@ferretry/kernel/contract').CallContext;

/** Today's `secretsMatch` (`daemon/src/lib/api/authentication.ts`), verbatim: a comparison that never short-circuits. */
export function secretsMatch(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    // charCodeAt is NaN past the end; `| 0` makes the out-of-range side a stable 0 so the loop
    // never short-circuits on the shorter string.
    difference |= (left.charCodeAt(index) | 0) ^ (right.charCodeAt(index) | 0);
  }
  return difference === 0;
}

/** Today's `UnlockGranted`: the answer to an unlock. */
export type UnlockGranted = import('zod').infer<typeof import('@ferretry/core-gate/contract').UnlockGrantedSchema>;
/** Today's `StoredStepUpProof` (the kept assertion, by device id), from Access's own schema. */
export type StoredStepUpProof = import('zod').infer<typeof import('../../contract/index.ts').StoredStepUpProofSchema>;

/**
 * One route as Access's tables list it (today's `ApiRoute`): the pattern and handler, with today's descriptor fields
 * kept beside it as written. The manifest's descriptor is the one the kernel enforces; `build` keys these by
 * `<METHOD> <path>` against it.
 */
export type ApiRoute = { readonly method: string; readonly path: string; readonly handle: RouteHandler } & Partial<
  Omit<import('@ferretry/kernel/contract').RouteDescriptor, 'method' | 'path'>
>;
type RouteHandler = import('@ferretry/kernel/contract').RouteHandler;

/** A capability name as a demand's ref (Gate's vocabulary: the ref IS the name). */
export const capabilityNamed = (name: import('@ferretry/core-gate/contract').CapabilityName) =>
  name as unknown as import('@ferretry/kernel/contract').PolicyRef<'capability'>;
/** The core capability a demand names (Gate's `coreCapabilityName`); every demand Access makes names one. */
export const nameOf = (ref: import('@ferretry/kernel/contract').PolicyRef<'capability'>) =>
  ref as unknown as import('@ferretry/core-gate/contract').CapabilityName;
