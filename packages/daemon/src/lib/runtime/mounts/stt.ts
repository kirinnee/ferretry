import type { SttEnhancementResult } from '@ferretry/protocol';
import type { ApiRequest, ApiResponse } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { enhancementErrorStatus, enhancementErrorView } from '../../stt/enhancement.ts';
import { SttEnhancementError } from '../../stt/errors.ts';

/**
 * Dictation enhancement: the daemon's ONE remaining speech-to-text route.
 *
 * Recognition itself now happens in the browser, so the model store, the worker supervisor, the
 * audio decoder and their six routes are gone. What could not follow the browser is this one:
 * enhancement is an outbound call to a hosted chat model authenticated with a credential only the
 * daemon holds (`GROQ_API_KEY`, read from this daemon's own environment — see `lib/stt/ports.ts`).
 * A static public bundle has no way to carry that key, so a browser that wants its transcript
 * repaired by a hosted model asks a daemon it is paired to, and the daemon spends its own credential.
 *
 * IT IS AN ORDINARY `ApiRoute`, which is what the shape always deserved: JSON in, JSON out. The six
 * deleted routes were byte-shaped — audio under a budget that had to be refused unread, a ranged
 * model file with an ETag — and that is what forced the daemon's third, raw route table. Enhance
 * never needed it, and with recognition gone the raw table has no members at all: it is deleted with
 * this change rather than left as machinery no route uses.
 *
 * `admin` SCOPE, unchanged from when this was raw. Enhancement spends the operator's provider
 * account on every call, which is strictly more authority than reading a session. A warden-scoped
 * token judges sessions; it does not get to bill the operator.
 *
 * THERE IS NOTHING TO CLOSE. The deleted half held a worker process with a multi-gigabyte model
 * loaded and had to be reaped on shutdown. Enhancement holds one outbound request at a time and
 * nothing between them, so this mount has no lifecycle and the composition root registers no cleanup.
 */

/**
 * The enhancer as this route needs it.
 *
 * Declared here rather than imported so a test can answer the route without a transport, a secret
 * reader and a clock behind it. `SttEnhancementService` satisfies it structurally, so the
 * composition root hands one over unchanged. `enhance` takes `unknown` deliberately: the service
 * parses the body against the wire schema ITSELF and raises the precise refusal — `too_long`,
 * `provider_unknown`, `bad_model` — that the client already knows how to read. A schema parse here
 * would answer the generic `invalid_request` instead and lose that taxonomy.
 */
export interface SttEnhancementSubsystem {
  enhance(input: unknown): Promise<SttEnhancementResult>;
}

/** The body, as JSON. Malformed JSON is the enhancer's own `bad_request`, not a second vocabulary. */
async function readJson(request: ApiRequest): Promise<unknown> {
  const text = await request.text().catch(() => {
    throw new SttEnhancementError('bad_request', 'request body could not be read');
  });
  try {
    return JSON.parse(text);
  } catch {
    throw new SttEnhancementError('bad_request', 'request body is not valid JSON');
  }
}

/**
 * One transcript in, one repaired transcript out.
 *
 * Every refusal the enhancer raises is projected by the DOMAIN's own pair — `enhancementErrorStatus`
 * and `enhancementErrorView` — rather than restated here, so the status and the `{error, code}` body
 * a client parses are the ones `lib/stt/enhancement.ts` decided. Anything else escaping is a defect
 * and reaches the dispatcher's 500, which never echoes a thrown message: an enhancement failure can
 * carry the provider's own text, and this route's payload is dictated speech.
 */
async function enhance(subsystem: SttEnhancementSubsystem, context: RouteContext): Promise<ApiResponse> {
  try {
    return jsonResponse(await subsystem.enhance(await readJson(context.request)));
  } catch (error) {
    if (error instanceof SttEnhancementError) {
      return jsonResponse(enhancementErrorView(error), enhancementErrorStatus(error.code));
    }
    throw error;
  }
}

/** The one dictation route. */
export function sttEnhancementRoutes(subsystem: SttEnhancementSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'POST',
      path: '/v1/stt/enhance',
      minimum: 'operator',
      handle: async context => await enhance(subsystem, context),
    },
  ];
}
