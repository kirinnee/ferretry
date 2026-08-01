import { daemonVersion } from '../../version.ts';
import { STT_API_PREFIX } from '../../stt/routes.ts';
import type { RawRoute } from '../../api/raw.ts';
import { VERSION_HEADER } from '../../api/responses.ts';
import type { RouteContext } from '../../api/route.ts';

/**
 * Dictation: the daemon's speech-to-text surface.
 *
 * The whole subsystem — a Whisper worker supervisor, a model store that installs and verifies model
 * files, an audio decoder with a duration budget, and an LLM enhancement pass — was built and fully
 * tested, and the composition root CONSTRUCTED it and called nothing. `fy stt status`, `models`,
 * `install`, `transcribe` and `enhance` are shipped commands whose gateway
 * (`packages/cli/src/lib/stt/gateway.ts`) has spoken these exact paths since it was ported, against
 * a daemon that answered `unknown_route` to every one of them. This mounts them.
 *
 * THEY ARE RAW ROUTES, NOT `ApiRoute`s, and that is forced rather than chosen. Transcription
 * streams audio bytes under a budget it must refuse a body against rather than buffer, and
 * `ApiRequest` reads text only; `ApiResponse` carries a string body, and the model-file read answers
 * with a ranged slice, an ETag and a 304. See `api/raw.ts` for the seam and why it is still behind
 * the one authorization boundary.
 *
 * EVERY ROUTE IS `admin`. Dictation spends the operator's Groq key on `enhance` and spawns a
 * process that loads a multi-gigabyte model on `transcribe`, which is strictly more authority than
 * reading a session. A warden-scoped token judges sessions; it does not get to run the operator's
 * hardware or bill their account.
 *
 * WHAT IS DELIBERATELY NOT MOUNTED: the public model-file read under `/stt-models/`. It exists to
 * hand a BROWSER the weights for in-page transcription, and nothing in this repository mints such a
 * URL — the PWA has no dictation client and `resolvePublicFile` has no caller outside the service.
 * Serving it as `public` would put an unauthenticated file feed on the daemon for no client, and
 * serving it as `admin` would contradict both its name and its purpose. It lands with the browser
 * transcription client, which is what decides which of those two it is.
 */

/**
 * The speech-to-text surface as the routes need it.
 *
 * Declared here rather than imported because `SttService` is an ADAPTER and `src/lib` may not import
 * `src/adapters`. The service satisfies this structurally, so the composition root hands one over
 * unchanged.
 */
export interface SttSubsystem {
  /** Handles any path this surface owns; answers `undefined` for anything else. */
  handle(request: Request): Promise<Response | undefined>;
  /** Releases the worker process the surface may have spawned. */
  close(): Promise<void>;
}

/**
 * Runs one request through the subsystem and stamps the daemon version on the way out.
 *
 * TWO TABLES MATCH ONE PATH HERE, and the divergence between them is real rather than theoretical.
 * The router matches RAW segments so that authorization inspects exactly what the handler will,
 * while the service re-resolves the path through `matchSttRoute`, which DECODES each component and
 * rejects one that regains a separator or a terminator. So `GET /v1/stt/models/a%2Fb` matches the
 * `:modelId` pattern, is authorized, and then resolves to no route at all inside the service.
 *
 * That gap is answered 404 rather than allowed to become a 500 about `undefined`: an id that names
 * no model is a missing model, which is the same answer the service gives for one that is merely
 * absent. Re-implementing the decode here to keep the tables in lockstep would put a second copy of
 * a security-relevant path check in the daemon, which is worse than one honest 404.
 */
async function serve(subsystem: SttSubsystem, request: Request): Promise<Response> {
  const response = await subsystem.handle(request);
  if (response === undefined) {
    return Response.json({ error: 'model not found', code: 'model_not_found' }, { status: 404 });
  }
  // Every API response carries the daemon version so a client can name a skew rather than guess why
  // a route it knows about refused. The service builds its own responses and cannot know it.
  response.headers.set(VERSION_HEADER, daemonVersion);
  return response;
}

function route(method: string, path: string, subsystem: SttSubsystem): RawRoute {
  return {
    method,
    path,
    scope: 'admin',
    serve: async (_context: RouteContext, request: Request) => await serve(subsystem, request),
  };
}

/**
 * The dictation routes.
 *
 * Order matters — the router tries routes in registration order — so `/v1/stt/models` is registered
 * before the `:modelId` pattern beneath it, and `…/:modelId/install` before the bare `:modelId` it
 * would otherwise be read as a two-segment id by.
 */
export function sttRawRoutes(subsystem: SttSubsystem): readonly RawRoute[] {
  return [
    route('GET', `${STT_API_PREFIX}/status`, subsystem),
    route('GET', `${STT_API_PREFIX}/models`, subsystem),
    route('GET', `${STT_API_PREFIX}/models/:modelId/install`, subsystem),
    route('POST', `${STT_API_PREFIX}/models/:modelId/install`, subsystem),
    route('GET', `${STT_API_PREFIX}/models/:modelId`, subsystem),
    route('POST', `${STT_API_PREFIX}/transcribe`, subsystem),
    route('POST', `${STT_API_PREFIX}/enhance`, subsystem),
  ];
}
