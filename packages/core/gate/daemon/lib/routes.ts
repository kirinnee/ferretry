import {
  ApiError,
  type ApiResponse,
  arrivedOnHost,
  type CallContext,
  jsonResponse,
  queryValue,
} from '@ferretry/kernel/contract';
import type { z } from 'zod';
import {
  AuditQuerySchema,
  AuditViewSchema,
  SECURITY_WIDEN_REFUSED_CODE,
  SecuritySettingsPatchSchema,
  SecuritySettingsViewSchema,
  STEP_UP_ACTS,
  STEP_UP_REQUIRED_CODE,
} from '../../contract/index.ts';
import type { AuditReading } from './audit/service.ts';
import type { SecurityCaller, SecuritySettingsService } from './security/service.ts';

/** The largest body Gate's own routes accept: a security patch is six fields. */
export const GATE_BODY_MAX_BYTES = 16 * 1024;

/** Parses a JSON body against a schema (today's `parseBody`): 413 past the bound, 400 for bad JSON, 422 for a misfit. */
export async function parseBody<S extends z.ZodType>(call: CallContext, schema: S): Promise<z.infer<S>> {
  let text: string;
  try {
    text = await call.request.text(GATE_BODY_MAX_BYTES);
  } catch {
    throw new ApiError(413, 'the request body is too large', 'body_too_large');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ApiError(400, 'the request body is not JSON', 'invalid_json');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new ApiError(
      422,
      'the request body does not match what this route accepts',
      'invalid_body',
      parsed.error.issues.map(issue => ({ path: issue.path, message: issue.message })),
    );
  return parsed.data;
}

/** Who is asking: where they arrived and whether they proved a passkey for this change — the boundary's facts only. */
export const securityCallerOf = (call: CallContext): SecurityCaller => ({
  hostLocal: arrivedOnHost(call.request, call.credential?.tokenClass === 'admin'),
  actor: call.actor ?? 'unknown',
  freshPasskey: call.presentation?.freshStepUp === true,
});

export interface GateRouteDeps {
  readonly audit: { recent(limit: number, keptOffset: number): Promise<AuditReading> };
  readonly security: SecuritySettingsService;
}

/** The handlers for Gate's three routes (today's `mounts/audit.ts` and `mounts/security.ts`). */
export function gateRoutes(deps: GateRouteDeps) {
  return {
    'GET /v1/audit': async (call: CallContext): Promise<ApiResponse> => {
      const query = AuditQuerySchema.safeParse({
        ...(queryValue(call.request, 'limit') === undefined ? {} : { limit: queryValue(call.request, 'limit') }),
        ...(queryValue(call.request, 'keptOffset') === undefined
          ? {}
          : { keptOffset: queryValue(call.request, 'keptOffset') }),
      });
      if (!query.success) throw new ApiError(400, 'limit and keptOffset are whole numbers in range', 'invalid_query');
      const reading = await deps.audit.recent(query.data.limit, query.data.keptOffset);
      return jsonResponse(
        AuditViewSchema.parse({
          records: reading.records.map(({ format: _format, ...record }) => record),
          kept: reading.kept.map(({ format: _format, ...record }) => record),
          keptTotal: reading.keptTotal,
          unreadable: reading.unreadable,
        }),
      );
    },

    'GET /v1/security': async (call: CallContext): Promise<ApiResponse> =>
      jsonResponse(SecuritySettingsViewSchema.parse(deps.security.view(securityCallerOf(call)))),

    'PATCH /v1/security': async (call: CallContext): Promise<ApiResponse> => {
      const patch = await parseBody(call, SecuritySettingsPatchSchema);
      const caller = securityCallerOf(call);
      const outcome = await deps.security.patch(patch, caller);
      if (outcome.ok) {
        if (outcome.spentPasskey) call.spendFreshStepUp?.();
        return jsonResponse({
          view: SecuritySettingsViewSchema.parse(outcome.change.view),
          devicesExpiring: outcome.change.devicesExpiring,
        });
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
            demand: { capability: 'pairing', axis: 'configure', act: STEP_UP_ACTS.loosenSecurity as string },
          },
          403,
        );
      throw new ApiError(
        403,
        `${outcome.fields.join(', ')} can only be loosened at the machine itself. Run \`${deps.security.view(caller).widenCommand}\` there.`,
        SECURITY_WIDEN_REFUSED_CODE,
      );
    },
  } as const;
}
