/**
 * The entry the size budget builds (`tests/perf/hypermedia-size.test.ts`): the chat's transcript, the one piece of Conversation
 * that draws an assistant message, imported the way the app imports it, WITH the stylesheet the app loads beside it: the
 * Conversation surfaces import `app/hypermedia/dh-styles.ts` (Durian's stylesheet) for the same transcript, so the gate counts it
 * too, through the same import and the same `sideEffects` entry that keep it in the app's build (r12 H8 fix: a package marked
 * side-effect-free dropped that bare import, and the app shipped no Durian CSS). Handing the transcript to a global is what
 * stops the bundler dropping it (an app build keeps no entry exports); it is exported too, so a larger entry can import this
 * one for real (this package marks only the stylesheet as having side effects: a bare import of this file would be dropped).
 */
import { Transcript } from '../../../app/chat/transcript.tsx';
import '../../../app/hypermedia/dh-styles.ts';

Object.assign(globalThis, { transcriptBudgetEntry: Transcript });

export { Transcript };
