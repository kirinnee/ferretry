import { STEP_UP_REQUIRED_CODE, type StepUpRequiredBody } from '@ferretry/protocol';
import { grantRefusalCode } from '../../api/capability.ts';
import type { ApiResponse } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { RouteContext } from '../../api/route.ts';

/**
 * A WRITE INTO THE SECRET STORE REACHED THROUGH ANOTHER CAPABILITY'S ROUTE (docs/secure-copy.md, docs/grants.md).
 *
 * Allowing a paste, adding a paste rule and approving a paste plan are `terminal` routes, but when the paste lands
 * in the secret store they change it, so they also need what `POST /v1/secrets` needs: `secrets.configure`. A
 * device paired without it (or with it switched off) must not overwrite a secret by allowing a paste instead.
 * Answers the refusal response, or `undefined` when allowed; a caller the grants cannot be read for is refused.
 * The owner at the machine is ungoverned and always allowed. A route that acts after an allowed answer spends a
 * single-use step-up as every other `configure` act does.
 */
export function refusedSecretWrite(context: RouteContext, act: string): ApiResponse | undefined {
  const governance = context.governance;
  if (governance === undefined)
    return jsonResponse(
      { error: `this daemon cannot say whether this caller may ${act}, so it is refusing`, code: 'forbidden' },
      403,
    );
  const decision = governance.decide({ capability: 'secrets', axis: 'configure' });
  if (decision.allowed) return undefined;
  if (decision.refusal === 'step-up-required')
    return jsonResponse(
      {
        error: `${act} from this device needs a passkey confirmation`,
        code: STEP_UP_REQUIRED_CODE,
        demand: { capability: 'secrets', axis: 'configure' },
      } satisfies StepUpRequiredBody,
      403,
    );
  return jsonResponse(
    { error: `this device may not ${act}: that changes the secret store`, code: grantRefusalCode(decision.refusal) },
    403,
  );
}

/** After an allowed secret write: a governed caller's single-use step-up is spent, as for `POST /v1/secrets`. */
export function spentSecretWrite(context: RouteContext): void {
  if (context.governance?.governed === true) context.spendFreshStepUp?.();
}
