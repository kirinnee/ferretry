/** Updates' route handlers: parse, ask the service, answer. Refusals are final sentences with a code. */
import {
  ApiError,
  type CallContext,
  errorResponse,
  jsonResponse,
  type PlainApiResponse,
  parseBody,
} from '@ferretry/kernel/contract';
import { claimOwnerOnly, isFerretCall } from '@ferretry/core-gate/contract';
import {
  DaemonUpdateSettingsPatchSchema,
  DaemonUpdateStartRequestSchema,
  type DaemonUpdateView,
  UPDATE_HOST_CODES,
  UPDATES_CONFIG,
} from '../../contract/index.ts';
import type { ConfigDoor } from './config-door.ts';
import { DaemonUpdateRefusal, type DaemonUpdateSubsystem } from './service.ts';

/**
 * The largest body these routes have a use for. Read through the kernel's `parseBody` (today's `api/body.ts`), so the
 * refusals are today's: `413 body_too_large`, `400 invalid_json`, `400 invalid_request`.
 */
const BODY_LIMIT = { maxBytes: 4 * 1024 } as const;

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
 * before these run; the handler adds today's `ownerOnly` gate (`runtime/mounts/daemon-update.ts`) through Gate's
 * {@link claimOwnerOnly}: an agent cannot update the machine (the owner does), and a governed device confirms with a
 * FRESH passkey that is CLAIMED before the act, so one proof admits one act and a failed act has used it up. Turning
 * automatic install OFF never needs one — the safe direction is never gated — but a ferret still may not change how
 * the machine updates.
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
      const request = await parseBody(call.request, DaemonUpdateStartRequestSchema, BODY_LIMIT);
      const refused = claimOwnerOnly(call, 'update this machine');
      if (refused !== undefined) return refused;
      if (!(await hostReady())) return hostUnavailable();
      let view: DaemonUpdateView;
      try {
        view = await subsystem.start(request);
      } catch (error) {
        return refuse(error);
      }
      return jsonResponse(view, 202);
    },

    'PATCH /v1/daemon/update/settings': async (call: CallContext) => {
      const patch = await parseBody(call.request, DaemonUpdateSettingsPatchSchema, BODY_LIMIT);
      if (patch.autoInstall) {
        const refused = claimOwnerOnly(call, 'turn on automatic updates');
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
      const view = await subsystem.view();
      return written.kind === 'held' ? jsonResponse({ held: written.sentences, view }, 202) : jsonResponse(view);
    },
  };
}
