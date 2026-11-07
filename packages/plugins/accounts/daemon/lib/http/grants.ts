/**
 * THE EXTRA DEMANDS A ROUTE MAKES AFTER ITS OWN, and who the owner is on a call, copied from today's
 * `packages/daemon/src/lib/runtime/mounts/{secret-write-grant,input-requests}.ts` (bb89d054d).
 *
 * TODO(contract): these are the Vault's mount helpers today, read off Gate's standing (`governance`, `credential`);
 * neither the Vault's nor Gate's contract exports them.
 */
import {
  CAPABILITIES,
  type EveryCallerStepUpAct,
  type StepUpSubjectOf,
  grantRefusalCode,
  isFerretCall,
  OWNER_ONLY_CODE,
  ownerOnlyWords,
  STEP_UP_REQUIRED_CODE,
  type StepUpRequiredBody,
} from '@ferretry/core-gate/contract';
import { ApiError, type ApiResponse, type CallContext, jsonResponse } from '@ferretry/kernel/contract';
import type { InputActor } from '../vault-inputs.ts';

/** A route's call context: the request, its params and Gate's standing (today's `RouteContext`). */
export type RouteContext = CallContext;

/**
 * The owner behind a person route: a paired device by its id, or the machine. A ferret is refused before anything is
 * read, whatever header it sends.
 */
export function ownerActorOf(
  context: RouteContext,
  act = 'answers an input request',
): Extract<InputActor, { readonly kind: 'host' | 'device' }> {
  const credential = context.credential;
  if (isFerretCall(context)) throw new ApiError(403, ownerOnlyWords(act), OWNER_ONLY_CODE);
  return credential?.tokenClass === 'device'
    ? { kind: 'device', deviceId: credential.principal.holder }
    : { kind: 'host' };
}

/**
 * A WRITE INTO THE SECRET STORE REACHED THROUGH ANOTHER CAPABILITY'S ROUTE: allowing a paste into the store, adding a
 * paste rule or approving a paste plan also needs `secrets.configure`. The owner at the machine is ungoverned.
 */
export function refusedSecretWrite(context: RouteContext, act: string): ApiResponse | undefined {
  return refusedExtra(
    context,
    { capability: CAPABILITIES.secrets, axis: 'configure' },
    act,
    'that changes the secret store',
  );
}

/** A value into a PAGE through a `terminal` route also needs `browser.use`. */
export function refusedPageInput(context: RouteContext, act = 'allow a value into a page'): ApiResponse | undefined {
  return refusedExtra(
    context,
    { capability: CAPABILITIES.browser, axis: 'use' },
    act,
    'that needs the browser permission',
  );
}

/** A route that answers ACCOUNT NAMES through another capability's route also needs `secrets.use`. */
export function refusedAccountNames(
  context: RouteContext,
  act = 'read the accounts a task plan names',
): ApiResponse | undefined {
  return refusedExtra(
    context,
    { capability: CAPABILITIES.secrets, axis: 'use' },
    act,
    'that needs the secrets permission',
  );
}

/** One more demand behind a route that already passed its own: the refusal, or `undefined` when allowed. */
function refusedExtra(
  context: RouteContext,
  demand: { readonly capability: (typeof CAPABILITIES)['secrets' | 'browser']; readonly axis: 'use' | 'configure' },
  act: string,
  consequence: string,
): ApiResponse | undefined {
  const governance = context.governance;
  if (governance === undefined)
    return jsonResponse(
      { error: `this daemon cannot say whether this caller may ${act}, so it is refusing`, code: 'forbidden' },
      403,
    );
  const decision = governance.decide(demand);
  if (decision.allowed) return undefined;
  if (decision.refusal === 'step-up-required')
    return jsonResponse(
      {
        error: `${act} from this device needs a passkey confirmation`,
        code: STEP_UP_REQUIRED_CODE,
        demand,
      } satisfies StepUpRequiredBody,
      403,
    );
  return jsonResponse(
    { error: `this device may not ${act}: ${consequence}`, code: grantRefusalCode(decision.refusal) },
    403,
  );
}

/** After an allowed secret write: a governed caller's single-use step-up is spent. */
export function spentSecretWrite(context: RouteContext): void {
  if (context.governance?.governed === true) context.spendFreshStepUp?.();
}

/**
 * The subject a fresh every-caller proof is claimed for, as today's services derive it (`pasteRuleApprovalSubject`,
 * `taskPlanApprovalSubject`, …): a string bound to exactly what is approved.
 *
 * TODO(contract): Gate's `ClaimFreshStepUp` types the subject as the act's stage id (`StepUpSubjectOf<A>`); today's
 * `RouteContext.claimFreshStepUp` takes the derived subject string. Passed through unchanged until Gate agrees.
 */
export const freshSubject = <A extends EveryCallerStepUpAct>(_act: A, subject: string): StepUpSubjectOf<A> =>
  subject as StepUpSubjectOf<A>;
