import { AttachmentUnlockRequestSchema, AttachmentUploadRequestSchema, type AttachmentView } from '@ferretry/protocol';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { type ApiResponse, decodeParameter } from '../../api/http.ts';
import { jsonResponse, jsonTextResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { SessionAttachmentError } from '../../attachments/index.ts';

export interface SessionAttachmentSubsystem {
  upload(
    sessionId: string,
    request: { readonly filename: string; readonly mime: string; readonly bytes: Uint8Array },
  ): Promise<AttachmentView>;
  download(
    sessionId: string,
    attachmentId: string,
  ): Promise<{ readonly attachment: AttachmentView; readonly bytes: Uint8Array }>;
  unlock(sessionId: string, attachmentId: string, password: string): Promise<AttachmentView>;
  lock(sessionId: string, attachmentId: string): Promise<AttachmentView>;
}

const status: Readonly<Record<SessionAttachmentError['failure'], number>> = {
  invalid: 400,
  not_found: 404,
  corrupt: 500,
  too_large: 413,
  wrong_password: 409,
  locked: 409,
  decryption_failed: 422,
};

const sessionId = (context: RouteContext): string => {
  const value = decodeParameter(context.params.get('sessionId') ?? '');
  if (value === undefined || value === '')
    throw new ApiError(400, 'the session id in the path is not usable', 'invalid_session_id');
  return value;
};

const attachmentId = (context: RouteContext): string => {
  const value = decodeParameter(context.params.get('attachmentId') ?? '');
  if (value === undefined || value === '')
    throw new ApiError(400, 'the attachment id in the path is not usable', 'invalid_attachment_id');
  return value;
};

const bytes = (base64: string): Uint8Array => {
  try {
    // `atob` refuses what is not base64, and the copy into bytes is native rather than a per-character loop —
    // into an array of its own, never a view of Buffer's shared pool.
    return new Uint8Array(Buffer.from(atob(base64), 'latin1'));
  } catch {
    throw new ApiError(400, 'attachment bytes are not valid base64', 'invalid_attachment');
  }
};

/**
 * Bytes encoded per slice before the loop is given back. A multiple of three, so the slices join without
 * padding between them; 768 KiB encodes natively in about a millisecond.
 */
const ENCODE_SLICE_BYTES = 3 * 256 * 1024;

const yieldToLoop = async (): Promise<void> => await new Promise<void>(resolve => setImmediate(resolve));

/**
 * The download's JSON, `{ attachment, base64 }`, spelled exactly as `JSON.stringify` spells it.
 *
 * NEVER ON THE LOOP IN ONE PIECE. An attachment is up to 32 MiB, and encoding it used to be a JavaScript
 * loop of `String.fromCharCode` over the whole file and then a `btoa` — half a second of a stalled daemon
 * per download on the EC2 box. It is encoded natively, a slice at a time with the loop handed back between
 * slices, and appended to the body rather than joined and re-serialised: base64 needs no escaping, so
 * `JSON.stringify` would only have copied it again.
 */
async function downloadBody(attachment: AttachmentView, value: Uint8Array): Promise<string> {
  let body = `{"attachment":${JSON.stringify(attachment)},"base64":"`;
  for (let offset = 0; offset < value.byteLength; offset += ENCODE_SLICE_BYTES) {
    if (offset > 0) await yieldToLoop();
    const slice = value.subarray(offset, offset + ENCODE_SLICE_BYTES);
    body += Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength).toString('base64');
  }
  return `${body}"}`;
}

const reraise = (error: unknown): never => {
  if (error instanceof SessionAttachmentError)
    throw new ApiError(status[error.failure], error.message, `attachment_${error.failure}`);
  throw error;
};

async function upload(subsystem: SessionAttachmentSubsystem, context: RouteContext): Promise<ApiResponse> {
  const request = await parseBody(context.request, AttachmentUploadRequestSchema);
  return jsonResponse(
    await subsystem.upload(sessionId(context), { ...request, bytes: bytes(request.base64) }).catch(reraise),
    201,
  );
}

async function download(subsystem: SessionAttachmentSubsystem, context: RouteContext): Promise<ApiResponse> {
  const result = await subsystem.download(sessionId(context), attachmentId(context)).catch(reraise);
  return jsonTextResponse(await downloadBody(result.attachment, result.bytes));
}

async function unlock(subsystem: SessionAttachmentSubsystem, context: RouteContext): Promise<ApiResponse> {
  const request = await parseBody(context.request, AttachmentUnlockRequestSchema);
  return jsonResponse(
    await subsystem.unlock(sessionId(context), attachmentId(context), request.password).catch(reraise),
  );
}

async function lock(subsystem: SessionAttachmentSubsystem, context: RouteContext): Promise<ApiResponse> {
  return jsonResponse(await subsystem.lock(sessionId(context), attachmentId(context)).catch(reraise));
}

/** Attachment originals are durable; plaintext unlock state is process-local and no-store. */
export function sessionAttachmentRoutes(subsystem: SessionAttachmentSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/attachments',
      minimum: 'operator',
      noStore: true,
      handle: async context => await upload(subsystem, context),
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/attachments/:attachmentId',
      minimum: 'operator',
      noStore: true,
      handle: async context => await download(subsystem, context),
    },
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/attachments/:attachmentId/unlock',
      minimum: 'operator',
      noStore: true,
      handle: async context => await unlock(subsystem, context),
    },
    {
      method: 'DELETE',
      path: '/v1/sessions/:sessionId/attachments/:attachmentId/unlock',
      minimum: 'operator',
      noStore: true,
      handle: async context => await lock(subsystem, context),
    },
  ];
}
