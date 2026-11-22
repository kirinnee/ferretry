/**
 * A DURIAN WORKER WITH A SLOW PARSE, FOR A TEST ONLY (r12 H11). It is the real worker (`durian-answer.ts`, the real message
 * reader, the real wire) with one difference: the parser a message that carries the marker is read with is a loop that does not
 * return. It is never shipped: nothing in `app/` imports it, and the only thing the product has for this is the optional parser
 * argument of `readMessage`, which this file fills. It names nothing about what makes a real parse slow, because a real parse is
 * not what it stands in for: a loop that runs until it is ended is.
 */
import { answer } from '../../../../app/hypermedia/durian-answer.ts';
import { isReadRequest } from '../../../../app/hypermedia/durian-wire.ts';
import { readMessage } from '../../../../app/hypermedia/parse-message.ts';

/** The text a message carries to be read slowly. */
const SLOW = 'FY-SLOW-PARSE';

const neverReturns = (): never => {
  for (;;) {
    // busy: the worker's thread is the only thing this holds
  }
};

interface Scope {
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  postMessage(message: unknown): void;
}
const scope = self as unknown as Scope;

scope.onmessage = event => {
  if (!isReadRequest(event.data)) return;
  scope.postMessage(
    answer(event.data, (source, prefix, arriving) =>
      source.includes(SLOW)
        ? readMessage(source, prefix, arriving, false, neverReturns)
        : readMessage(source, prefix, arriving),
    ),
  );
};
scope.postMessage({ kind: 'ready' });
