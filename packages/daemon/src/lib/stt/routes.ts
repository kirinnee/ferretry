import type { SttErrorCode, SttErrorView } from '@ferretry/protocol';
import { SttEnhancementError, SttError } from './errors.ts';
import { enhancementErrorStatus, enhancementErrorView } from './enhancement.ts';

/** Every route the speech-to-text surface answers. */
export type SttRoute =
  | { readonly kind: 'status' }
  | { readonly kind: 'models' }
  | { readonly kind: 'model'; readonly modelId: string }
  | { readonly kind: 'install'; readonly modelId: string }
  | { readonly kind: 'transcribe' }
  | { readonly kind: 'enhance' }
  | { readonly kind: 'public-file'; readonly modelId: string; readonly fileName: string };

export const STT_API_PREFIX = '/v1/stt';
export const STT_PUBLIC_PREFIX = '/stt-models/';

const ERROR_STATUS: Readonly<Record<SttErrorCode, number>> = {
  bad_request: 400,
  bad_audio: 400,
  too_long: 413,
  unsupported_language: 400,
  busy: 409,
  model_missing: 409,
  model_not_found: 404,
  model_installing: 409,
  install_failed: 503,
  native_missing: 503,
  load_failed: 503,
  decode_failed: 500,
  worker_unavailable: 503,
  worker_crashed: 503,
  service_closed: 503,
  not_found: 404,
  method_not_allowed: 405,
};

export function sttErrorStatus(code: SttErrorCode): number {
  return ERROR_STATUS[code];
}

export function sttErrorView(error: SttError): SttErrorView {
  return { error: error.message, code: error.code };
}

/** One shape for every failure the surface can answer with. */
export function sttFailureResponse(error: unknown): { readonly status: number; readonly body: unknown } {
  if (error instanceof SttEnhancementError) {
    return { status: enhancementErrorStatus(error.code), body: enhancementErrorView(error) };
  }
  if (error instanceof SttError) return { status: sttErrorStatus(error.code), body: sttErrorView(error) };
  return {
    status: 500,
    body: { error: 'speech-to-text request failed', code: 'decode_failed' satisfies SttErrorCode },
  };
}

function decodedComponent(raw: string): string | undefined {
  try {
    const decoded = decodeURIComponent(raw);
    return decoded.length === 0 || decoded.includes('/') || decoded.includes('\0') ? undefined : decoded;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a path to a route without consulting any state.
 *
 * Path components are decoded and then re-checked: `%2f` decodes to a separator
 * and `%00` to a terminator, either of which would smuggle a second component
 * past a naive split.
 */
export function matchSttRoute(pathname: string): SttRoute | undefined {
  if (pathname === `${STT_API_PREFIX}/status`) return { kind: 'status' };
  if (pathname === `${STT_API_PREFIX}/models`) return { kind: 'models' };
  if (pathname === `${STT_API_PREFIX}/transcribe`) return { kind: 'transcribe' };
  if (pathname === `${STT_API_PREFIX}/enhance`) return { kind: 'enhance' };

  const install = /^\/v1\/stt\/models\/([^/]+)\/install$/u.exec(pathname);
  if (install !== null) {
    const modelId = decodedComponent(install[1] ?? '');
    return modelId === undefined ? undefined : { kind: 'install', modelId };
  }
  const model = /^\/v1\/stt\/models\/([^/]+)$/u.exec(pathname);
  if (model !== null) {
    const modelId = decodedComponent(model[1] ?? '');
    return modelId === undefined ? undefined : { kind: 'model', modelId };
  }
  if (pathname.startsWith(STT_PUBLIC_PREFIX)) {
    const components = pathname.slice(STT_PUBLIC_PREFIX.length).split('/');
    if (components.length !== 2) return undefined;
    const modelId = decodedComponent(components[0] ?? '');
    const fileName = decodedComponent(components[1] ?? '');
    if (modelId === undefined || fileName === undefined) return undefined;
    return { kind: 'public-file', modelId, fileName };
  }
  return undefined;
}

/** The methods each route accepts, in the order an Allow header wants them. */
export function allowedMethods(route: SttRoute): readonly string[] {
  switch (route.kind) {
    case 'status':
    case 'models':
    case 'model':
      return ['GET'];
    case 'install':
      return ['GET', 'POST'];
    case 'transcribe':
    case 'enhance':
      return ['POST'];
    case 'public-file':
      return ['GET', 'HEAD'];
  }
}

export function methodNotAllowed(route: SttRoute): SttError {
  return new SttError('method_not_allowed', `method not allowed; expected ${allowedMethods(route).join(', ')}`);
}

/** The container a content-type asks for, or nothing when it asks for neither. */
export function requestedContainer(contentType: string | null): 'wav' | 'pcm16le' | undefined {
  const mime = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (mime === 'audio/wav' || mime === 'audio/x-wav') return 'wav';
  if (mime === 'audio/l16' || mime === 'audio/pcm') return 'pcm16le';
  return undefined;
}

/** A declared body larger than the limit is refused before a byte is read. */
export function declaredBodyRefusal(contentLength: string | null, maxBytes: number): SttError | undefined {
  if (contentLength === null) return undefined;
  const declared = Number(contentLength.trim());
  if (!Number.isFinite(declared) || declared < 0) return new SttError('bad_request', 'content-length is not valid');
  return declared > maxBytes ? new SttError('too_long', 'audio exceeds the maximum size') : undefined;
}

export function modelFileEtag(sha256: string): string {
  return `"sha256-${sha256}"`;
}

export function matchesIfNoneMatch(header: string | null, etag: string): boolean {
  if (header === null) return false;
  return header.split(',').some(candidate => {
    const tag = candidate.trim();
    if (tag === '*') return true;
    return (tag.startsWith('W/') ? tag.slice(2) : tag) === etag;
  });
}

export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Parse a single byte range.
 *
 * `undefined` means "no range asked for", `null` means "asked for one we cannot
 * satisfy" — the caller answers those differently (200 versus 416).
 */
export function parseByteRange(header: string | null, size: number): ByteRange | undefined | null {
  if (header === null) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (match === null) return null;
  const [, rawStart = '', rawEnd = ''] = match;
  if (rawStart === '' && rawEnd === '') return null;
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (suffix === 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  if (start >= size) return null;
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  return end < start ? null : { start, end };
}
