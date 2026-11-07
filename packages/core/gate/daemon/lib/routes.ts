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
  type CapabilityPresentation,
  GRANT_AUDIT_MAX_ENTRIES,
  GrantAuditViewSchema,
  grantRefusalCode,
  GrantsPatchSchema,
  GrantsViewSchema,
} from '../../contract/index.ts';
import type { AuditReading } from './audit/service.ts';
import type { SecurityCaller, SecuritySettingsService } from './security/service.ts';
import { GrantError, type GrantFailure, type GrantService } from './grants/service.ts';

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

/**
 * Who is asking: where they arrived and how they may TAKE a passkey proof for this change — the boundary's facts only.
 * The proof is passed as a claim, never as the admission snapshot's `freshStepUp`, so the service takes it inside its
 * queue and before its write.
 */
export const securityCallerOf = (call: CallContext): SecurityCaller => {
  const claim = call.claimFreshStepUp;
  return {
    hostLocal: arrivedOnHost(call.request, call.credential?.tokenClass === 'admin'),
    actor: call.actor ?? 'unknown',
    ...(claim === undefined ? {} : { claimFreshPasskey: () => claim() === true }),
  };
};

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
      if (outcome.ok)
        return jsonResponse({
          view: SecuritySettingsViewSchema.parse(outcome.change.view),
          devicesExpiring: outcome.change.devicesExpiring,
        });
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

const GRANT_REFUSALS: Readonly<Record<GrantFailure, { readonly status: number; readonly code: string }>> = {
  invalid: { status: 400, code: 'invalid_request' },
  forbidden: { status: 403, code: 'grant_forbidden' },
  'device-not-granted': { status: 403, code: grantRefusalCode('device-not-granted') },
  'step-up-required': { status: 403, code: STEP_UP_REQUIRED_CODE },
  // 503: the daemon is working, it has lost the ANSWER, and the remedy is to repair the document.
  unavailable: { status: 503, code: 'grants_undetermined' },
};

function refuseGrant(error: unknown): never {
  if (error instanceof GrantError) {
    const refusal = GRANT_REFUSALS[error.failure];
    throw new ApiError(refusal.status, error.message, refusal.code);
  }
  throw error;
}

/** Admission's own assembly; a call without one is a wiring mistake and is refused, never guessed at. */
function presentationOf(call: CallContext): CapabilityPresentation {
  if (call.presentation === undefined)
    throw new ApiError(500, 'this daemon cannot say who is asking, so it is refusing', 'internal_error');
  return call.presentation;
}

/** The handlers for `/v1/grants*` (today's `mounts/grants.ts`). */
export function grantRoutes(grants: GrantService) {
  return {
    'GET /v1/grants': async (call: CallContext): Promise<ApiResponse> =>
      jsonResponse(GrantsViewSchema.parse(grants.view(presentationOf(call)))),
    'GET /v1/grants/audit': async (): Promise<ApiResponse> =>
      jsonResponse(GrantAuditViewSchema.parse(await grants.history(GRANT_AUDIT_MAX_ENTRIES).catch(refuseGrant))),
    'PATCH /v1/grants': async (call: CallContext): Promise<ApiResponse> => {
      const patch = await parseBody(call, GrantsPatchSchema);
      const view = await grants.patch(patch, presentationOf(call)).catch(refuseGrant);
      // This route asks for its step-up itself, so it spends it itself (G97).
      call.spendStepUp?.();
      return jsonResponse(view);
    },
  } as const;
}
