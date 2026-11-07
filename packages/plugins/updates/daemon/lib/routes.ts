/** Updates' route handlers: parse, ask the service, answer. Refusals are final sentences with a code. */
import {
  ApiError,
  type ApiRequest,
  type CallContext,
  errorResponse,
  jsonResponse,
  type PlainApiResponse,
} from '@ferretry/kernel/contract';
import { isFerretCall, ownerOnly } from '@ferretry/core-gate/contract';
import type { z } from 'zod';
import {
  DaemonUpdateSettingsPatchSchema,
  DaemonUpdateStartRequestSchema,
  type DaemonUpdateView,
  UPDATE_HOST_CODES,
  UPDATES_CONFIG,
} from '../../contract/index.ts';
import type { ConfigDoor } from './config-door.ts';
import { DaemonUpdateRefusal, type DaemonUpdateSubsystem } from './service.ts';

const BODY_LIMIT = 4 * 1024;

async function bodyOf<S extends z.ZodType>(request: ApiRequest, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await request.text(BODY_LIMIT));
  } catch {
    throw new ApiError(400, 'the request body is not JSON', 'invalid_request');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new ApiError(
      422,
      'the request is not one this route takes',
      'invalid_request',
      parsed.error.issues.map(issue => ({ path: issue.path, message: issue.message })),
    );
  return parsed.data;
}

/** Restates a domain refusal as a 409 carrying its code, so the app can say the right sentence. */
function refuse(error: unknown): PlainApiResponse {
  if (!(error instanceof DaemonUpdateRefusal)) throw error;
  return errorResponse(409, error.message, error.code);
}

const hostUnavailable = (): PlainApiResponse =>
  errorResponse(
    503,
    'this daemon cannot read its own build yet, so it cannot tell whether it is behind',
    UPDATE_HOST_CODES.hostUnavailable,
  );

/**
 * `GET`, `POST` and `PATCH /v1/daemon/update[/settings]` (docs/updating.md). Gate demands `fleet.configure` of a person
 * before these run; the handler adds today's {@link ownerOnly} gate (`runtime/mounts/daemon-update.ts`): an agent
 * cannot update the machine (the owner does), a governed device confirms with a FRESH passkey, and that proof is
 * spent only once the act has been accepted. Turning automatic install OFF never needs one — the safe direction is
 * never gated — but a ferret still may not change how the machine updates.
 */
export function updateRoutes(
  subsystem: DaemonUpdateSubsystem,
  door: ConfigDoor | undefined,
  hostReady: () => Promise<boolean> = async () => true,
) {
  return {
    'GET /v1/daemon/update': async () =>
      !(await hostReady()) ? hostUnavailable() : jsonResponse(await subsystem.view()),

    'POST /v1/daemon/update': async (call: CallContext) => {
      const request = await bodyOf(call.request, DaemonUpdateStartRequestSchema);
      const refused = ownerOnly(call, 'update this machine');
      if (refused !== undefined) return refused;
      if (!(await hostReady())) return hostUnavailable();
      let view: DaemonUpdateView;
      try {
        view = await subsystem.start(request);
      } catch (error) {
        return refuse(error);
      }
      if (call.governance?.governed === true) call.spendFreshStepUp?.();
      return jsonResponse(view, 202);
    },

    'PATCH /v1/daemon/update/settings': async (call: CallContext) => {
      const patch = await bodyOf(call.request, DaemonUpdateSettingsPatchSchema);
      if (patch.autoInstall) {
        const refused = ownerOnly(call, 'turn on automatic updates');
        if (refused !== undefined) return refused;
      } else if (isFerretCall(call)) {
        throw new ApiError(403, 'a ferret cannot change how this machine updates; the owner does', 'forbidden');
      }
      if (!(await hostReady())) return hostUnavailable();
      if (door === undefined)
        return errorResponse(503, 'this daemon cannot change its settings yet', UPDATE_HOST_CODES.configUnavailable);
      const written = await door.write(UPDATES_CONFIG, undefined, { patch });
      if (written.kind === 'refused')
        return errorResponse(422, `the setting was refused: ${written.reason}`, UPDATE_HOST_CODES.settingRefused, {
          issues: written.issues,
        });
      // Accepted (applied, or held for the owner's confirmation): the proof that carried the request is spent.
      if (patch.autoInstall && call.governance?.governed === true) call.spendFreshStepUp?.();
      const view = await subsystem.view();
      return written.kind === 'held' ? jsonResponse({ held: written.sentences, view }, 202) : jsonResponse(view);
    },
  };
}
