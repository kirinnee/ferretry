import { answer } from './durian-answer.ts';
import { isReadRequest } from './durian-wire.ts';

/**
 * THE DURIAN WORKER (r12 H11): the only place the product runs Durian's parser. A parse can take far longer than a frame on
 * text that looks ordinary, and nothing on the page's main thread can stop a loop that is running; a worker can be
 * terminated. The page (`durian-reader.ts`) gives each parse a time budget and terminates this worker when it is spent, and
 * shows that message as the text it is.
 *
 * A module worker, built as a same-origin chunk (`durian-worker-url.ts` names it for the bundler) and started under the
 * page's own policy: `worker-src 'self'` and the `fy-worker` Trusted Types policy, which accepts exactly this chunk's name.
 *
 * It says `ready` once its code is loaded, so the page does not count module loading against a message's budget, and then
 * answers each `read` ask with one message back. Anything that is not a well-formed ask is ignored.
 */
interface WorkerScope {
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  postMessage(message: unknown): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = event => {
  if (isReadRequest(event.data)) scope.postMessage(answer(event.data));
};
scope.postMessage({ kind: 'ready' });
