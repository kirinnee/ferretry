import {
  ApiError,
  type CallContext,
  decodeParameter,
  jsonResponse,
  type RouteHandler,
} from '@ferretry/kernel/contract';
import {
  SpeedupProviderSchema,
  type SpeedupProvider,
  type SpeedupsView,
  type SpeedupTestResult,
  type SttEnhancementResult,
  type VoiceEntryResult,
  SttEnhancementError,
} from '../contract/index.ts';
import {
  type ElevenLabsStatus,
  type ElevenLabsVoices,
  type ReplyVoiceApi,
  type VoiceEngineApi,
  VoiceEngineError,
} from '../contract/index.ts';
import { VoiceEntryRefused } from './lib/stream/entry.ts';
import { enhancementErrorStatus, enhancementErrorView } from './lib/stt/enhancement.ts';

/**
 * Dictation enhancement: the daemon's ONE speech-to-text route (R626). Recognition happens in the browser, so no
 * microphone audio ever crosses the tunnel or the daemon; this is an ordinary JSON route.
 *
 * `enhance` takes `unknown` deliberately: the service parses the body against the wire schema ITSELF and raises the
 * precise refusal — `too_long`, `provider_unknown`, `bad_model` — that the client already knows how to read.
 */
export interface SttEnhancementSubsystem {
  enhance(input: unknown): Promise<SttEnhancementResult>;
}

/**
 * Speed-ups: whether each optional provider key is set, and a Test that proves one works. NEITHER ROUTE TAKES OR
 * RETURNS A KEY: a key goes in through the Vault's secret route. The status read is a NAME lookup (S168); the Test
 * asks the Vault's outbound holder to spend the key once and answers with a code and a fixed sentence.
 */
export interface SpeedupsSubsystem {
  view(): Promise<SpeedupsView>;
  test(provider: SpeedupProvider): Promise<SpeedupTestResult>;
}

/** The body, as JSON. Malformed JSON is the enhancer's own `bad_request`, not a second vocabulary. */
async function readJson(call: CallContext): Promise<unknown> {
  const text = await call.request.text().catch(() => {
    throw new SttEnhancementError('bad_request', 'request body could not be read');
  });
  try {
    return JSON.parse(text);
  } catch {
    throw new SttEnhancementError('bad_request', 'request body is not valid JSON');
  }
}

/** An entry ask is a ferret name and a session name: nothing near this size is a real one. */
const ENTRY_BODY_MAX_BYTES = 1_024;

/** The entry's body, read under its own small limit (a bigger one is a 413); anything that is not JSON is read as nothing and refused as a bad ask. */
async function readEntryBody(call: CallContext): Promise<unknown> {
  let text: string;
  try {
    text = await call.request.text(ENTRY_BODY_MAX_BYTES);
  } catch (error) {
    if (error instanceof ApiError && error.status === 413) throw error;
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function pathProvider(call: CallContext): SpeedupProvider {
  const parsed = SpeedupProviderSchema.safeParse(decodeParameter(call.params.get('provider') ?? ''));
  if (!parsed.success) throw new ApiError(404, 'there is no speed-up provider by that name', 'unknown_provider');
  return parsed.data;
}

/**
 * Every refusal the enhancer raises is projected by the DOMAIN's own pair — `enhancementErrorStatus` and
 * `enhancementErrorView` — so the status and the `{error, code}` body a client parses are the ones the enhancer decided.
 * Anything else escaping is a defect and reaches the dispatcher's 500, which never echoes a thrown message: an
 * enhancement failure can carry the provider's own text, and this route's payload is dictated speech.
 */
export function voiceRoutes(
  enhancement: SttEnhancementSubsystem,
  speedups: SpeedupsSubsystem,
  engine: Pick<VoiceEngineApi, 'view' | 'install' | 'remove'>,
  reply: Pick<ReplyVoiceApi, 'view' | 'install' | 'remove'>,
  elevenlabs: { status(): Promise<ElevenLabsStatus>; voices(): Promise<ElevenLabsVoices> },
  entry: (body: unknown, call: CallContext) => Promise<VoiceEntryResult>,
): {
  readonly 'POST /v1/voice/entry': RouteHandler;
  readonly 'GET /v1/voice/engine': RouteHandler;
  readonly 'POST /v1/voice/engine/install': RouteHandler;
  readonly 'DELETE /v1/voice/engine': RouteHandler;
  readonly 'GET /v1/voice/reply-voice': RouteHandler;
  readonly 'POST /v1/voice/reply-voice/install': RouteHandler;
  readonly 'DELETE /v1/voice/reply-voice': RouteHandler;
  readonly 'GET /v1/voice/reply-voice/elevenlabs': RouteHandler;
  readonly 'GET /v1/voice/reply-voice/elevenlabs/voices': RouteHandler;
  readonly 'POST /v1/stt/enhance': RouteHandler;
  readonly 'GET /v1/speedups': RouteHandler;
  readonly 'POST /v1/speedups/:provider/test': RouteHandler;
} {
  return {
    // A phone's own voice mode asks the machine to tell the ferret once (the same claim the stream uses).
    'POST /v1/voice/entry': async call => {
      try {
        return jsonResponse(await entry(await readEntryBody(call), call));
      } catch (error) {
        if (error instanceof VoiceEntryRefused) throw new ApiError(error.status, error.message, error.code);
        throw error;
      }
    },
    'GET /v1/voice/engine': async () => jsonResponse(await engine.view()),
    // Starts the download and answers at once (202): the screen polls the GET for progress.
    'POST /v1/voice/engine/install': async () => jsonResponse(await engine.install(), 202),
    'DELETE /v1/voice/engine': async () => {
      try {
        return jsonResponse(await engine.remove());
      } catch (error) {
        if (error instanceof VoiceEngineError) throw new ApiError(409, error.message, error.code);
        throw error;
      }
    },
    'GET /v1/voice/reply-voice': async () => jsonResponse(await reply.view()),
    'POST /v1/voice/reply-voice/install': async () => jsonResponse(await reply.install(), 202),
    'DELETE /v1/voice/reply-voice': async () => {
      try {
        return jsonResponse(await reply.remove());
      } catch (error) {
        if (error instanceof VoiceEngineError) throw new ApiError(409, error.message, error.code);
        throw error;
      }
    },
    // ElevenLabs as the reply voice: what is set and spent today (free), and the account's voices (one use of the key).
    'GET /v1/voice/reply-voice/elevenlabs': async () => jsonResponse(await elevenlabs.status()),
    'GET /v1/voice/reply-voice/elevenlabs/voices': async () => jsonResponse(await elevenlabs.voices()),
    'POST /v1/stt/enhance': async call => {
      try {
        return jsonResponse(await enhancement.enhance(await readJson(call)));
      } catch (error) {
        if (error instanceof SttEnhancementError) {
          return jsonResponse(enhancementErrorView(error), enhancementErrorStatus(error.code));
        }
        throw error;
      }
    },
    'GET /v1/speedups': async () => jsonResponse(await speedups.view()),
    'POST /v1/speedups/:provider/test': async call => jsonResponse(await speedups.test(pathProvider(call))),
  };
}
