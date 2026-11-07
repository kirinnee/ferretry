import {
  ApiError,
  type ApiResponse,
  decodeParameter,
  jsonResponse,
  type RouteHandler,
} from '@ferretry/kernel/contract';
import { ownerOnly } from '@ferretry/core-gate/contract';
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

/** The largest body the start route has a use for: a version and a yes (today's harness update route). */
const MAX_START_BODY_BYTES = 4 * 1024;

/**
 * The start request, parsed at the boundary as today's harness update route did: the read is bounded, a body that does
 * not satisfy the schema never becomes a domain value, and the caller is told which field was wrong without the
 * submitted values coming back.
 */
async function readStart(call: Parameters<RouteHandler>[0]): Promise<z.output<typeof HarnessUpdateStartRequestSchema>> {
  let text: string;
  try {
    text = await call.request.text(MAX_START_BODY_BYTES);
  } catch (error) {
    if (error instanceof Error && error.name === 'BodyTooLargeError')
      throw new ApiError(413, error.message, 'body_too_large');
    throw new ApiError(400, 'the request body could not be read', 'unreadable_body');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(400, 'the request body is not valid JSON', 'invalid_json');
  }
  const result = HarnessUpdateStartRequestSchema.safeParse(parsed);
  if (result.success) return result.data;
  const detail = result.error.issues
    .map(issue => `${issue.path.join('.') === '' ? 'body' : issue.path.join('.')}: ${issue.message}`)
    .join('; ');
  throw new ApiError(400, `the request body is invalid — ${detail}`, 'invalid_request', result.error.issues);
}

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
 * program it runs as), and a governed device confirms with a passkey first — the gate is Gate's {@link ownerOnly}, the
 * daemon update's own, so the acts can never be governed differently. The proof is spent only once the update has been
 * accepted.
 */
export function updateStartRoute(update: HarnessUpdateSubsystem): RouteHandler {
  return async call => {
    const request = await readStart(call);
    const refused = ownerOnly(call, 'update the agent CLIs on this machine');
    if (refused !== undefined) return refused;
    let view: Awaited<ReturnType<HarnessUpdateSubsystem['start']>>;
    try {
      view = await update.start(request);
    } catch (error) {
      return refuseStart(error);
    }
    if (call.governance?.governed === true) call.spendFreshStepUp?.();
    return jsonResponse(view, 202);
  };
}
