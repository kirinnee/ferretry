import { parse, UNTRUSTED_LIMITS } from 'durian-markdown';
import { serve } from '../../../app/hypermedia/durian-serve.ts';
import { loadNeeded, takeNeeds } from '../../../app/hypermedia/durian-shims/lazy-part.ts';
import { isReadRequest, type WorkerMessage } from '../../../app/hypermedia/durian-wire.ts';

/**
 * THE PARSER WORKER WITH NOTHING HELD (`lazy-worker.test.ts` builds it the way the page's worker is built). The product holds every folder
 * part as plain code before Durian reads it (`held-fence-parse.ts`), so a message in production reaches a part's parser only through
 * the one thing that is not a fence: a formula in a sentence. A part's parser that arrives on demand is what the unit that un-holds
 * a part relies on, and it is proved here, on Durian's `parse` itself: the worker's own loop (`durian-serve.ts`) around a `parse` that reads the
 * message as written, with Durian's untrusted caps and no front matter.
 */
const scope = self as unknown as {
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  postMessage(message: unknown): void;
};
const say = (message: WorkerMessage): void => scope.postMessage(message);

let queue: Promise<void> = Promise.resolve();
scope.onmessage = event => {
  const request = event.data;
  if (!isReadRequest(request)) return;
  queue = queue.then(() =>
    serve(request, {
      answer: ask => ({
        kind: 'read',
        id: ask.id,
        doc: parse(ask.source, { frontMatter: false, limits: UNTRUSTED_LIMITS }),
        drawable: [],
      }),
      takeNeeds,
      loadNeeded,
      say,
    }),
  );
};
say({ kind: 'ready' });
