/** Updates' route handlers: parse, ask the service, answer. Refusals are final sentences with a code. */
import {
  ApiError,
  type ApiRequest,
  type CallContext,
  errorResponse,
  jsonResponse,
  type PlainApiResponse,
} from '@ferretry/kernel/contract';
import type { z } from 'zod';
import {
  DaemonUpdateSettingsPatchSchema,
  DaemonUpdateStartRequestSchema,
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
 * `GET`, `POST` and `PATCH /v1/daemon/update[/settings]` (docs/updating.md). Who may update, and whether a remote
 * device confirms with a passkey, is decided before these run: Gate demands `fleet.configure` of a person and the
 * step-up of the act (an agent cannot update the machine; the owner does).
 */
export function updateRoutes(subsystem: DaemonUpdateSubsystem | undefined, door: ConfigDoor | undefined) {
  return {
    'GET /v1/daemon/update': async () =>
      subsystem === undefined ? hostUnavailable() : jsonResponse(await subsystem.view()),

    'POST /v1/daemon/update': async (call: CallContext) => {
      const request = await bodyOf(call.request, DaemonUpdateStartRequestSchema);
      if (subsystem === undefined) return hostUnavailable();
      try {
        return jsonResponse(await subsystem.start(request), 202);
      } catch (error) {
        return refuse(error);
      }
    },

    'PATCH /v1/daemon/update/settings': async (call: CallContext) => {
      const patch = await bodyOf(call.request, DaemonUpdateSettingsPatchSchema);
      if (subsystem === undefined) return hostUnavailable();
      if (door === undefined)
        return errorResponse(503, 'this daemon cannot change its settings yet', UPDATE_HOST_CODES.configUnavailable);
      const written = await door.write(UPDATES_CONFIG, undefined, { patch });
      if (written.kind === 'refused')
        return errorResponse(422, `the setting was refused: ${written.reason}`, UPDATE_HOST_CODES.settingRefused, {
          issues: written.issues,
        });
      const view = await subsystem.view();
      return written.kind === 'held' ? jsonResponse({ held: written.sentences, view }, 202) : jsonResponse(view);
    },
  };
}
