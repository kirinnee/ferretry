import type { Admission } from '../contract/bound.ts';
import { WITHHELD_SENTENCE } from '../contract/bound.ts';
import { ApiError, errorResponse, finalised } from '../contract/http.ts';
import { CONNECTOR_GRANT_PATTERN, DELEGATE_PLUGINS, type DelegatePort } from '../contract/ports/delegate.ts';
import type { Manifest } from '../manifest/types.ts';
import type { Dispatcher } from './dispatch.ts';
import type { Log } from '../contract/ports/log.ts';

/** Boot composition kept to one line; the live dispatcher and bound Gate exist only after plugin build. */
export function delegateFor(
  manifest: Manifest,
  dispatcher: () => Dispatcher,
  bound: { readonly admission?: Admission },
  log: Log,
  lifecycle: { stopping(): boolean },
): DelegatePort {
  return delegatePort({
    manifest,
    dispatcher,
    admission: () => bound.admission,
    refused: route => log.error('undeclared delegated route', { plugin: manifest.id, route }),
    stopping: () => lifecycle.stopping(),
  });
}

export function delegatePort(input: {
  readonly manifest: Manifest;
  readonly dispatcher: () => Dispatcher;
  readonly admission: () => Admission | undefined;
  readonly refused: (key: string) => void;
  readonly stopping?: () => boolean;
}): DelegatePort {
  const declared = input.manifest.permissions?.delegate;
  const allowed = new Set(declared);
  const enabled = declared !== undefined && (DELEGATE_PLUGINS as readonly string[]).includes(input.manifest.id);
  const failure = () => errorResponse(500, 'This plugin may not delegate that call.', 'delegate_refused');
  return {
    async call({ grant }, call) {
      if (!enabled || !CONNECTOR_GRANT_PATTERN.test(grant) || input.stopping?.() === true) return failure();
      const body = call.body === undefined ? '' : JSON.stringify(call.body);
      const response = await input.dispatcher().dispatch(
        {
          method: call.method,
          path: call.path,
          query: new Map(call.query),
          headers: new Map(call.requestId === undefined ? [] : [['x-fy-request-id', call.requestId]]),
          arrival: { kind: 'delegated', by: 'connector', grant },
          clientAddress: 'connector',
          text: async (limitBytes = Number.POSITIVE_INFINITY) => {
            if (new TextEncoder().encode(body).byteLength > limitBytes)
              throw new ApiError(413, 'delegated request body is too large', 'body_too_large');
            return body;
          },
        },
        { allowed, refused: input.refused },
      );
      // The same last check as every carrier, THEN the host's literal mask. Gate alone holds those tokens.
      // Missing/throwing mask or a binary body fails closed; compressed bytes are never handed to a plugin.
      try {
        const final = finalised(response);
        const admission = input.admission();
        const masked = admission?.maskHostCredentials?.(final.body);
        if (masked === undefined || final.bytes !== undefined || input.stopping?.() === true)
          return errorResponse(409, WITHHELD_SENTENCE, 'withheld');
        const headers = new Map<string, string>();
        for (const [key, value] of final.headers) {
          if (['content-encoding', 'content-length', 'etag'].includes(key.toLowerCase())) continue;
          const clean = admission?.maskHostCredentials?.(value);
          if (clean === undefined) return errorResponse(409, WITHHELD_SENTENCE, 'withheld');
          headers.set(key, clean);
        }
        return { status: final.status, headers, body: masked };
      } catch {
        return errorResponse(409, WITHHELD_SENTENCE, 'withheld');
      }
    },
  };
}
