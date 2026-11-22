/**
 * The entry the size budget builds (`tests/perf/hypermedia-size.test.ts`): the chat's transcript, the one piece of Conversation
 * that draws an assistant message, imported the way the app imports it. Handing it to a global is what stops the bundler
 * dropping it (an app build keeps no entry exports); it is exported too, so a larger entry can import this one for real
 * (this package is `sideEffects: false`: a bare import of this file would be dropped).
 */
import { Transcript } from '../../../app/chat/transcript.tsx';

Object.assign(globalThis, { transcriptBudgetEntry: Transcript });

export { Transcript };
