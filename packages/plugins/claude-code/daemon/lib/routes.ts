import {
  ApiError,
  type ApiResponse,
  decodeParameter,
  jsonResponse,
  parseBody,
  type RouteHandler,
} from '@ferretry/kernel/contract';
import { claimOwnerOnly, ferretOf } from '@ferretry/core-gate/contract';
import type { FerretId, FerretsApi } from '@ferretry/core-ferrets/contract';
import type { z } from 'zod';
import {
  HARNESS_UPDATE_CODES,
  HarnessDialogAnswerRequestSchema,
  HarnessUpdateStartRequestSchema,
  PermissionAnswerRequestSchema,
  type HarnessUpdateUnverifiedBodySchema,
} from '../../contract/index.ts';
import { DialogAnswerError, type DialogAnswerService } from './dialog/service.ts';
import { PermissionAnswerError, type PermissionAnswerService } from './permission/service.ts';
import { HarnessUpdateRefusal, type HarnessUpdateSubsystem } from './update/service.ts';

function ferretId(call: Parameters<RouteHandler>[0]): string {
  const decoded = decodeParameter(call.params.get('ferretId') ?? '');
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the ferret id in the path is not usable', 'invalid_ferret_id');
  return decoded;
}

/** The pane could not be found or read or typed into: the answer was not sent. */
function paneRefusal(error: unknown): never {
  if (error instanceof ApiError) throw error;
  if (error instanceof Error && error.name === 'PaneUnknown') throw new ApiError(409, error.message, 'pane_unknown');
  if (error instanceof Error) throw new ApiError(409, error.message, 'console_input_failed');
  throw error;
}

/**
 * What the ferret is stopped on: Ferrets' record of its pane (`FerretsApi.prompt`), served as it is — the permission
 * request and the harness dialog as data, every string masked by Ferrets inside one `Redaction.read`. The caller is
 * passed through, so a ferret reading another's prompt is refused 403 by Ferrets' own rule; a ferret this daemon does
 * not know is 404. A pane that records nothing is `{}`. It reads and answers nothing on the pane.
 */
export function promptRoute(ferrets: Pick<FerretsApi, 'prompt'>): RouteHandler {
  return async call => {
    const id = ferretId(call);
    if (ferrets.prompt === undefined)
      throw new ApiError(503, 'this daemon cannot say what a ferret is stopped on', 'plugin_unavailable');
    const found = await ferrets.prompt(id as FerretId, ferretOf(call));
    if (found === undefined) throw new ApiError(404, `no ferret ${id}`, 'not_found');
    return jsonResponse(found);
  };
}

/** Answering the permission prompt on one ferret's own pane. GOVERNED AS THE CONSOLE IS (G31): see the manifest. */
export function permissionRoute(permission: PermissionAnswerService): RouteHandler {
  return async call => {
    const id = ferretId(call);
    const request = await parseBody(call.request, PermissionAnswerRequestSchema);
    try {
      return jsonResponse(await permission.answer(id, request));
    } catch (error) {
      if (error instanceof PermissionAnswerError)
        throw error.refusal === 'gone'
          ? new ApiError(409, error.message, 'permission_prompt_gone')
          : error.refusal === 'cursor_unknown'
            ? new ApiError(409, error.message, 'permission_cursor_unknown')
            : new ApiError(400, error.message, 'invalid_permission_choice');
      return paneRefusal(error);
    }
  };
}

/** Answering the harness's own dialog on one ferret's own pane (G32). */
export function dialogRoute(dialog: DialogAnswerService): RouteHandler {
  return async call => {
    const id = ferretId(call);
    const request = await parseBody(call.request, HarnessDialogAnswerRequestSchema);
    try {
      return jsonResponse(await dialog.answer(id, request));
    } catch (error) {
      if (error instanceof DialogAnswerError)
        throw error.refusal === 'gone'
          ? new ApiError(409, error.message, 'harness_dialog_gone')
          : error.refusal === 'cursor_unknown'
            ? new ApiError(409, error.message, 'dialog_cursor_unknown')
            : new ApiError(400, error.message, 'invalid_dialog_choice');
      return paneRefusal(error);
    }
  };
}

export function updateViewRoute(update: HarnessUpdateSubsystem): RouteHandler {
  return async () => jsonResponse(await update.view());
}

/**
 * The largest body the start route has a use for: a version and a yes. Read through the kernel's `parseBody` (today's
 * `api/body.ts`), so the refusals are today's: `413 body_too_large`, `400 invalid_json`, `400 invalid_request`.
 */
const MAX_START_BODY_BYTES = 4 * 1024;

/** A domain refusal as a 409. The unverified one is an ANSWER, because its body carries both versions. */
function refuseStart(error: unknown): ApiResponse {
  if (!(error instanceof HarnessUpdateRefusal)) throw error;
  if (error.unverified !== undefined)
    return jsonResponse(
      { error: error.message, code: HARNESS_UPDATE_CODES.unverified, ...error.unverified } satisfies z.infer<
        typeof HarnessUpdateUnverifiedBodySchema
      >,
      409,
    );
  throw new ApiError(409, error.message, error.code);
}

/**
 * Starting an update: today's `harness-update.ts`. A ferret may never start one (it would be an agent replacing the
 * program it runs as), and a governed device confirms with a passkey first — the gate is Gate's {@link claimOwnerOnly},
 * the daemon update's own, so the acts can never be governed differently. The proof is claimed before the update
 * starts, so one proof admits one start and a refused start has used it up.
 */
export function updateStartRoute(update: HarnessUpdateSubsystem): RouteHandler {
  return async call => {
    const request = await parseBody(call.request, HarnessUpdateStartRequestSchema, {
      maxBytes: MAX_START_BODY_BYTES,
    });
    const refused = claimOwnerOnly(call, 'update the agent CLIs on this machine');
    if (refused !== undefined) return refused;
    let view: Awaited<ReturnType<HarnessUpdateSubsystem['start']>>;
    try {
      view = await update.start(request);
    } catch (error) {
      return refuseStart(error);
    }
    return jsonResponse(view, 202);
  };
}
