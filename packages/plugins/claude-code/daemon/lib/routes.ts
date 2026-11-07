import { ApiError, decodeParameter, jsonResponse, type RouteHandler } from '@ferretry/kernel/contract';
import { isFerretCall, STEP_UP_REQUIRED_CODE, type StepUpRequiredBody } from '@ferretry/core-gate/contract';
import type { ZodType, z } from 'zod';
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

/** The first route-level fact: a body that is not the schema is a 400 naming what is wrong. */
async function parseBody<T>(call: Parameters<RouteHandler>[0], schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    const text = await call.request.text();
    raw = text === '' ? {} : JSON.parse(text);
  } catch {
    throw new ApiError(400, 'the request body is not JSON', 'invalid_body');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, 'the request body is not what this route takes', 'invalid_body');
  return parsed.data;
}

function ferretId(call: Parameters<RouteHandler>[0]): string {
  const decoded = decodeParameter(call.params.get('ferretId') ?? '');
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the ferret id in the path is not usable', 'invalid_ferret_id');
  return decoded;
}

/** The pane could not be found or read or typed into: the answer was not sent. */
function paneRefusal(error: unknown): never {
  if (error instanceof Error && error.name === 'PaneUnknown') throw new ApiError(409, error.message, 'pane_unknown');
  if (error instanceof Error) throw new ApiError(409, error.message, 'console_input_failed');
  throw error;
}

/** Answering the permission prompt on one ferret's own pane. GOVERNED AS THE CONSOLE IS (G31): see the manifest. */
export function permissionRoute(permission: PermissionAnswerService): RouteHandler {
  return async call => {
    const id = ferretId(call);
    const request = await parseBody(call, PermissionAnswerRequestSchema);
    try {
      return jsonResponse(await permission.answer(id, request));
    } catch (error) {
      if (error instanceof PermissionAnswerError)
        throw error.refusal === 'gone'
          ? new ApiError(409, error.message, 'permission_prompt_gone')
          : new ApiError(400, error.message, 'invalid_permission_choice');
      return paneRefusal(error);
    }
  };
}

/** Answering the harness's own dialog on one ferret's own pane (G32). */
export function dialogRoute(dialog: DialogAnswerService): RouteHandler {
  return async call => {
    const id = ferretId(call);
    const request = await parseBody(call, HarnessDialogAnswerRequestSchema);
    try {
      return jsonResponse(await dialog.answer(id, request));
    } catch (error) {
      if (error instanceof DialogAnswerError)
        throw error.refusal === 'gone'
          ? new ApiError(409, error.message, 'harness_dialog_gone')
          : new ApiError(400, error.message, 'invalid_dialog_choice');
      return paneRefusal(error);
    }
  };
}

export function updateViewRoute(update: HarnessUpdateSubsystem): RouteHandler {
  return async () => jsonResponse(await update.view());
}

const CONFIGURE = { capability: 'fleet', axis: 'configure' } as const;

/**
 * Starting an update. A ferret may never start one (it would be an agent replacing the program it runs as), and a
 * governed device confirms with a passkey first; the step-up is spent only once the update has been accepted.
 */
export function updateStartRoute(update: HarnessUpdateSubsystem): RouteHandler {
  return async call => {
    const request = await parseBody(call, HarnessUpdateStartRequestSchema);
    if (isFerretCall(call))
      throw new ApiError(403, 'a ferret cannot update Claude Code on this machine; the owner does', 'forbidden');
    if (call.governance?.governed === true && call.presentation?.freshStepUp !== true)
      return jsonResponse(
        {
          error: 'to update Claude Code on this machine from this device, confirm with a passkey',
          code: STEP_UP_REQUIRED_CODE,
          demand: CONFIGURE,
        } satisfies StepUpRequiredBody,
        403,
      );
    try {
      const view = await update.start(request);
      if (call.governance?.governed === true) call.spendFreshStepUp?.();
      return jsonResponse(view, 202);
    } catch (error) {
      if (!(error instanceof HarnessUpdateRefusal)) throw error;
      // The unverified refusal is an ANSWER, because its body carries both versions.
      if (error.unverified !== undefined)
        return jsonResponse(
          { error: error.message, code: HARNESS_UPDATE_CODES.unverified, ...error.unverified } satisfies z.infer<typeof HarnessUpdateUnverifiedBodySchema>,
          409,
        );
      throw new ApiError(409, error.message, error.code);
    }
  };
}
