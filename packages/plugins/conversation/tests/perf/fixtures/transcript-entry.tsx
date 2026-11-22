/**
 * The entry the size budget builds (`tests/perf/hypermedia-size.test.ts`): the chat's transcript, the one piece of Conversation
 * that draws an assistant message, imported the way the app imports it, WITH the stylesheet the app loads beside it: the
 * Conversation surfaces import `app/hypermedia/dh-styles.ts` (Durian's stylesheet) for the same transcript, so the gate counts it
 * too, through the same import, which the Durian plugin keeps in the build (r12 H8 fix: this package is `sideEffects: false`, so
 * the bare import was dropped and the app shipped no Durian CSS). Handing the transcript to a global is what stops the bundler
 * dropping it (an app build keeps no entry exports); it is exported too, so a larger entry can import this one for real (this
 * package is side-effect-free: a bare import of this file would be dropped).
 */
import { Transcript } from '../../../app/chat/transcript.tsx';
import '../../../app/hypermedia/dh-styles.ts';

Object.assign(globalThis, { transcriptBudgetEntry: Transcript });

export { Transcript };
