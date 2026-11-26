import type { answer } from './durian-answer.ts';
import type { loadNeeded, takeNeeds } from './durian-shims/lazy-part.ts';
import type { ReadRequest, WorkerMessage } from './durian-wire.ts';

/**
 * ONE ASK, ANSWERED, WITH WHAT IT NEEDS FETCHED ON THE WAY (`durian-worker.ts` is its one caller; it is a function so a test can run it).
 *
 * The parser is synchronous and a part's code or KaTeX cannot be fetched in the middle of a parse (`durian-shims/lazy-part.ts`), so a parse
 * that found one missing is thrown away: the worker says `loading` (the page stops counting the parse's time while the code is fetched,
 * and gives the fetch its own, longer budget), fetches what was named, says `working` (the page counts again, from what was left) and
 * parses the message again. A message that needs nothing lazy, which is almost every message, says nothing but its answer.
 *
 * Total: it never throws, and it ends. A fetch that fails is `failed` (the page shows the message as text); a message that is still
 * missing something after {@link MOST_ROUNDS} rounds is `failed` too (one part's own formula needs KaTeX once the part is here, so two
 * or three rounds are honest and six are not).
 */
export const MOST_ROUNDS = 6;

export interface ServeDeps {
  readonly answer: typeof answer;
  readonly takeNeeds: typeof takeNeeds;
  readonly loadNeeded: typeof loadNeeded;
  readonly say: (message: WorkerMessage) => void;
}

export async function serve(request: ReadRequest, deps: ServeDeps): Promise<void> {
  // Anything an earlier parse left behind is not this message's.
  deps.takeNeeds();
  for (let round = 0; round < MOST_ROUNDS; round++) {
    const message = deps.answer(request);
    const missing = deps.takeNeeds();
    if (missing.length === 0) {
      deps.say(message);
      return;
    }
    deps.say({ kind: 'loading', id: request.id });
    try {
      await deps.loadNeeded(missing);
    } catch {
      deps.say({ kind: 'failed', id: request.id });
      return;
    }
    deps.say({ kind: 'working', id: request.id });
  }
  deps.say({ kind: 'failed', id: request.id });
}
