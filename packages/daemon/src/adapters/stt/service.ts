import type { SttEnhancementResult, SttStatus, SttTranscript } from '@ferretry/protocol';
import {
  assertCanTranscribe,
  declaredBodyRefusal,
  decodeSttAudio,
  matchSttRoute,
  matchesIfNoneMatch,
  maxRequestBytes,
  methodNotAllowed,
  modelFileEtag,
  parseByteRange,
  projectSttStatus,
  projectTranscript,
  requestedContainer,
  type SttLimits,
  sttFailureResponse,
  sttLimits,
  type SttRoute,
  SttError,
  STT_MAX_DURATION_SECONDS_DEFAULT,
} from '../../lib/index.ts';
import type { SttModelStore } from './model-store.ts';
import type { SttWorkerClient, SttWorkerTranscription } from './worker-client.ts';

/** What the service needs from the enhancer; the real one satisfies it. */
export interface SttEnhancerLike {
  enhance(input: unknown): Promise<SttEnhancementResult>;
}

/** What the service needs from the worker supervisor. */
export interface SttTranscriberLike {
  status(): ReturnType<SttWorkerClient['status']>;
  transcribe(samples: Float32Array): Promise<SttWorkerTranscription>;
  close(): Promise<void>;
}

export interface SttServiceOptions {
  readonly models: SttModelStore;
  readonly worker: SttTranscriberLike;
  readonly enhancer: SttEnhancerLike;
  readonly maxDurationSeconds?: number;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

/**
 * The speech-to-text HTTP surface.
 *
 * Routing, admission and every error-to-status mapping are decisions taken in
 * `lib/stt`; this class only reads requests, calls the collaborators, and writes
 * responses. It is deliberately transport-shaped rather than framework-shaped:
 * it takes a `Request` and returns a `Response`, so it can be mounted by any
 * server the daemon happens to run.
 */
export class SttService {
  private readonly limits: SttLimits;
  private closed = false;

  constructor(private readonly options: SttServiceOptions) {
    this.limits = sttLimits(options.maxDurationSeconds ?? STT_MAX_DURATION_SECONDS_DEFAULT);
  }

  /** Handles any path this surface owns; returns undefined for anything else. */
  async handle(request: Request): Promise<Response | undefined> {
    const route = matchSttRoute(new URL(request.url).pathname);
    if (route === undefined) return undefined;
    try {
      if (this.closed) throw new SttError('service_closed', 'speech-to-text is shutting down');
      return await this.dispatch(route, request);
    } catch (error) {
      const failure = sttFailureResponse(error);
      return json(failure.body, failure.status);
    }
  }

  async status(): Promise<SttStatus> {
    return projectSttStatus({
      worker: this.options.worker.status(),
      models: await this.options.models.inventory(),
      closed: this.closed,
      maxDurationSeconds: this.limits.maxDurationSeconds,
    });
  }

  /** Closes the surface and the worker behind it. Safe to call twice. */
  async close(): Promise<void> {
    this.closed = true;
    await this.options.worker.close();
  }

  private async dispatch(route: SttRoute, request: Request): Promise<Response> {
    const method = request.method.toUpperCase();
    switch (route.kind) {
      case 'status':
        this.assertMethod(route, method, ['GET']);
        return json(await this.status());
      case 'models':
        this.assertMethod(route, method, ['GET']);
        return json({ models: await this.options.models.inventory() });
      case 'model':
        this.assertMethod(route, method, ['GET']);
        return json(await this.options.models.modelStatus(route.modelId));
      case 'install':
        return await this.install(route, method);
      case 'transcribe':
        this.assertMethod(route, method, ['POST']);
        return json(await this.transcribe(request));
      case 'enhance':
        this.assertMethod(route, method, ['POST']);
        return json(await this.options.enhancer.enhance(await this.readJson(request)));
      case 'public-file':
        this.assertMethod(route, method, ['GET', 'HEAD']);
        return await this.serveModelFile(route.modelId, route.fileName, request, method);
    }
  }

  private assertMethod(route: SttRoute, method: string, allowed: readonly string[]): void {
    if (!allowed.includes(method)) throw methodNotAllowed(route);
  }

  private async install(route: Extract<SttRoute, { kind: 'install' }>, method: string): Promise<Response> {
    if (method === 'GET') return json(await this.options.models.modelStatus(route.modelId));
    this.assertMethod(route, method, ['GET', 'POST']);
    const result = await this.options.models.startInstall(route.modelId);
    if (!result.started && result.status.state === 'installing') {
      throw new SttError('model_installing', 'model installation is already in progress');
    }
    return json(result.status, result.started ? 202 : 200);
  }

  private async readJson(request: Request): Promise<unknown> {
    try {
      return await request.json();
    } catch {
      throw new SttError('bad_request', 'request body is not valid JSON');
    }
  }

  private async transcribe(request: Request): Promise<SttTranscript> {
    const contentType = request.headers.get('content-type');
    const container = requestedContainer(contentType);
    if (container === undefined) {
      throw new SttError('bad_request', 'content-type must be audio/wav or audio/L16; rate=16000; channels=1');
    }
    const budget = maxRequestBytes(this.limits, container);
    const declared = declaredBodyRefusal(request.headers.get('content-length'), budget);
    if (declared !== undefined) throw declared;

    assertCanTranscribe({
      closed: this.closed,
      daemon: (await this.options.models.inventory()).daemon,
      worker: this.options.worker.status(),
    });

    const bytes = await this.readBoundedBody(request, budget);
    const audio = decodeSttAudio(bytes, contentType ?? '', this.limits.maxDurationSeconds);
    return projectTranscript(await this.options.worker.transcribe(audio.samples));
  }

  /** Reads at most `maxBytes`; an undeclared over-long body is cut off, not buffered. */
  private async readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
    const body = request.body;
    if (body === null) throw new SttError('bad_audio', 'audio is empty');
    const chunks: Uint8Array[] = [];
    let received = 0;
    for await (const chunk of body) {
      received += chunk.byteLength;
      if (received > maxBytes) throw new SttError('too_long', 'audio exceeds the maximum size');
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  private async serveModelFile(modelId: string, fileName: string, request: Request, method: string): Promise<Response> {
    const file = await this.options.models.resolvePublicFile(modelId, fileName);
    if (file === undefined) throw new SttError('not_found', 'model file not found');

    const size = file.definition.bytes;
    const etag = modelFileEtag(file.definition.sha256);
    const headers = new Headers({
      'accept-ranges': 'bytes',
      'cache-control': 'public, max-age=31536000, immutable',
      'content-type': file.definition.mime,
      etag,
      'x-content-type-options': 'nosniff',
    });
    if (matchesIfNoneMatch(request.headers.get('if-none-match'), etag)) {
      return new Response(null, { status: 304, headers });
    }
    const range = parseByteRange(request.headers.get('range'), size);
    if (range === null) {
      headers.set('content-range', `bytes */${size}`);
      headers.set('content-length', '0');
      return new Response(null, { status: 416, headers });
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? size - 1;
    headers.set('content-length', String(end - start + 1));
    if (range !== undefined) headers.set('content-range', `bytes ${start}-${end}/${size}`);
    if (method === 'HEAD') return new Response(null, { status: range === undefined ? 200 : 206, headers });
    return new Response(Bun.file(file.path).slice(start, end + 1), {
      status: range === undefined ? 200 : 206,
      headers,
    });
  }
}
