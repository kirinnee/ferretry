import { answer } from './durian-answer.ts';
import { serve } from './durian-serve.ts';
import { loadNeeded, takeNeeds } from './durian-shims/lazy-part.ts';
import { isReadRequest, type WorkerMessage } from './durian-wire.ts';

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
 * answers each `read` ask with one message back (`durian-serve.ts`: a message that needs a part's parser or KaTeX, which arrive
 * when first needed, says `loading` and `working` on the way). The asks are answered one at a time, in the order they came: a fetch
 * in progress holds the next ask as a parse in progress does. Anything that is not a well-formed ask is ignored.
 */
interface WorkerScope {
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  postMessage(message: unknown): void;
}

const scope = self as unknown as WorkerScope;
const say = (message: WorkerMessage): void => scope.postMessage(message);

let queue: Promise<void> = Promise.resolve();
scope.onmessage = event => {
  const request = event.data;
  if (!isReadRequest(request)) return;
  queue = queue.then(() => serve(request, { answer, takeNeeds, loadNeeded, say }));
};
say({ kind: 'ready' });
