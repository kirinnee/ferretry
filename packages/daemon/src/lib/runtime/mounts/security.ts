/**
 * THE MACHINE'S SECURITY SETTINGS (`docs/design/zero-trust.md` B6): read them, and change them.
 *
 * The read has no capability demand: every paired device may see how strict the machine it talks to
 * is, which is what lets the app say "this can only be loosened at the machine" before anybody tries.
 * The change demands `pairing.configure`, so a remote caller needs that grant AND a current passkey
 * confirmation (B1), and the service then refuses any field that would loosen the machine unless the
 * caller is AT the machine — or, for the few fields a device may raise with a passkey, unless it proved
 * one for THIS change (`loosen-security`), which this route then spends. Where the caller arrived and
 * whether it proved a passkey are the boundary's own facts, never the body's.
 */

import {
  SECURITY_WIDEN_REFUSED_CODE,
  SecuritySettingsChangeSchema,
  SecuritySettingsPatchSchema,
  SecuritySettingsViewSchema,
  STEP_UP_ACTS,
  STEP_UP_REQUIRED_CODE,
  type StepUpRequiredBody,
} from '@ferretry/protocol';
import { ApiError, type ApiRoute, arrivedOnHost, jsonResponse, parseBody, type RouteContext } from '../../api/index.ts';
import type { SecurityCaller, SecuritySettingsService } from '../../security/index.ts';

const callerOf = (context: RouteContext): SecurityCaller => ({
  hostLocal: arrivedOnHost(context.request, context.credential?.tokenClass === 'admin'),
  actor: context.actor ?? 'unknown',
  freshPasskey: context.presentation?.freshStepUp === true,
});

export function securityRoutes(service: SecuritySettingsService): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/security',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      // How strict the machine is, readable before a confirmation on opening, so the app can say why.
      unlockExempt: true,
      handle: async context => jsonResponse(SecuritySettingsViewSchema.parse(service.view(callerOf(context)))),
    },
    {
      method: 'PATCH',
      path: '/v1/security',
      minimum: 'operator',
      caller: 'person',
      noStore: true,
      capability: { capability: 'pairing', axis: 'configure' },
      handle: async context => {
        const patch = await parseBody(context.request, SecuritySettingsPatchSchema);
        const outcome = await service.patch(patch, callerOf(context));
        if (outcome.ok) {
          if (outcome.spentPasskey) context.spendFreshStepUp?.();
          return jsonResponse(SecuritySettingsChangeSchema.parse(outcome.change));
        }
        if (outcome.refusal === 'unavailable')
          throw new ApiError(
            503,
            'this machine could not read its security settings; fix or replace them at the machine first',
            'security_unavailable',
          );
        if (outcome.refusal === 'passkey-required')
          return jsonResponse(
            {
              error: `raising ${outcome.fields.join(', ')} from this device needs a passkey confirmation for this change`,
              code: STEP_UP_REQUIRED_CODE,
              demand: { capability: 'pairing', axis: 'configure', act: STEP_UP_ACTS.loosenSecurity },
            } satisfies StepUpRequiredBody,
            403,
          );
        throw new ApiError(
          403,
          `${outcome.fields.join(', ')} can only be loosened at the machine itself. Run \`${service.view(callerOf(context)).widenCommand}\` there.`,
          SECURITY_WIDEN_REFUSED_CODE,
        );
      },
    },
  ];
}
