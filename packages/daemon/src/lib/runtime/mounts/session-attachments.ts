import { AttachmentUnlockRequestSchema, AttachmentUploadRequestSchema, type AttachmentView } from '@ferretry/protocol';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { type ApiResponse, decodeParameter } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
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
    const binary = atob(base64);
    const value = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) value[index] = binary.charCodeAt(index);
    return value;
  } catch {
    throw new ApiError(400, 'attachment bytes are not valid base64', 'invalid_attachment');
  }
};

const base64 = (value: Uint8Array): string => {
  let binary = '';
  for (let offset = 0; offset < value.byteLength; offset += 32_768)
    binary += String.fromCharCode(...value.subarray(offset, offset + 32_768));
  return btoa(binary);
};

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
  return jsonResponse({ attachment: result.attachment, base64: base64(result.bytes) });
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
