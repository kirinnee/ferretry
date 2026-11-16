import {
  ApiError,
  type ApiResponse,
  decodeParameter,
  jsonResponse,
  type RouteHandler,
} from '@ferretry/kernel/contract';
import {
  AttachmentUnlockRequestSchema,
  AttachmentUploadRequestSchema,
  type AttachmentView,
} from '../../contract/index.ts';
import { parseBody } from '../reader/lib/http.ts';
import { AttachmentError } from './lib/ferret-attachments.ts';

type Call = Parameters<RouteHandler>[0];

/** The store as the attachment routes reach it (`ferretScopedAttachments` satisfies this). */
export interface AttachmentSubsystem {
  upload(
    ferretId: string,
    request: { readonly filename: string; readonly mime: string; readonly bytes: Uint8Array },
  ): Promise<AttachmentView>;
  download(
    ferretId: string,
    attachmentId: string,
  ): Promise<{ readonly attachment: AttachmentView; readonly bytes: Uint8Array }>;
  unlock(ferretId: string, attachmentId: string, password: string): Promise<AttachmentView>;
  lock(ferretId: string, attachmentId: string): Promise<AttachmentView>;
}

const status: Readonly<Record<AttachmentError['failure'], number>> = {
  invalid: 400,
  not_found: 404,
  corrupt: 500,
  too_large: 413,
  wrong_password: 409,
  locked: 409,
  decryption_failed: 422,
};

const ferretId = (call: Call): string => {
  const value = decodeParameter(call.params.get('ferretId') ?? '');
  if (value === undefined || value === '')
    throw new ApiError(400, 'the ferret id in the path is not usable', 'invalid_ferret_id');
  return value;
};

const attachmentId = (call: Call): string => {
  const value = decodeParameter(call.params.get('attachmentId') ?? '');
  if (value === undefined || value === '')
    throw new ApiError(400, 'the attachment id in the path is not usable', 'invalid_attachment_id');
  return value;
};

const bytes = (base64: string): Uint8Array => {
  try {
    // `atob` refuses what is not base64, and the copy into bytes is native rather than a per-character loop: into an
    // array of its own, never a view of Buffer's shared pool.
    return new Uint8Array(Buffer.from(atob(base64), 'latin1'));
  } catch {
    throw new ApiError(400, 'attachment bytes are not valid base64', 'invalid_attachment');
  }
};

/**
 * Bytes encoded per slice before the loop is given back. A multiple of three, so the slices join without padding between
 * them; 768 KiB encodes natively in about a millisecond.
 */
const ENCODE_SLICE_BYTES = 3 * 256 * 1024;

/** Gives the event loop back for a turn; the daemon runs on Bun, whose `sleep(0)` is a macrotask. */
const yieldToLoop = async (): Promise<void> => await Bun.sleep(0);

/**
 * The download's JSON, `{ attachment, base64 }`, spelled exactly as `JSON.stringify` spells it.
 *
 * NEVER ON THE LOOP IN ONE PIECE. An attachment is up to 32 MiB; it is encoded natively, a slice at a time with the loop
 * handed back between slices, and appended to the body rather than joined and re-serialised: base64 needs no escaping,
 * so `JSON.stringify` would only have copied it again.
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
  if (error instanceof AttachmentError)
    throw new ApiError(status[error.failure], error.message, `attachment_${error.failure}`);
  throw error;
};

export const uploadRoute =
  (subsystem: AttachmentSubsystem): RouteHandler =>
  async (call): Promise<ApiResponse> => {
    const request = await parseBody(call.request, AttachmentUploadRequestSchema);
    return jsonResponse(
      await subsystem.upload(ferretId(call), { ...request, bytes: bytes(request.base64) }).catch(reraise),
      201,
    );
  };

export const downloadRoute =
  (subsystem: AttachmentSubsystem): RouteHandler =>
  async (call): Promise<ApiResponse> => {
    const result = await subsystem.download(ferretId(call), attachmentId(call)).catch(reraise);
    return {
      status: 200,
      headers: new Map([['content-type', 'application/json; charset=utf-8']]),
      body: await downloadBody(result.attachment, result.bytes),
    };
  };

export const unlockRoute =
  (subsystem: AttachmentSubsystem): RouteHandler =>
  async (call): Promise<ApiResponse> => {
    const request = await parseBody(call.request, AttachmentUnlockRequestSchema);
    return jsonResponse(await subsystem.unlock(ferretId(call), attachmentId(call), request.password).catch(reraise));
  };

export const lockRoute =
  (subsystem: AttachmentSubsystem): RouteHandler =>
  async (call): Promise<ApiResponse> =>
    jsonResponse(await subsystem.lock(ferretId(call), attachmentId(call)).catch(reraise));
