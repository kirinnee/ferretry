/**
 * The page half of `google-transcriber.realworld.test.ts`: runs the SHIPPED Google voice (`browserGoogleVoice`, the same
 * object Settings and the dictation hook hold) inside the built app's real policy, and reports what it did. Bundled by the
 * test; never part of the app.
 */
import { browserGoogleVoice } from '../../../../app/lib/stt/google-voice.ts';
import type { OnDeviceInstallSnapshot } from '../../../../app/lib/stt/on-device-voice.ts';

interface Window {
  __go?: (assets: { workerUrl: string; runtimeUrl: string }) => Promise<unknown>;
  __voice?: ReturnType<typeof browserGoogleVoice>;
  __violations?: string[];
}
const page = globalThis as unknown as Window & typeof globalThis;
const violations: string[] = [];
page.__violations = violations;
document.addEventListener('securitypolicyviolation', event =>
  violations.push(`${event.violatedDirective} ${event.blockedURI} ${event.sourceFile}`),
);

// The model's one origin is answered by this test's own server (same-origin, so the page's policy needs no change): only the
// ORIGIN differs from a real install; the store, its ranges, hashing and the pins are the shipped ones.
const realFetch = page.fetch.bind(page);
page.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  realFetch(
    typeof input === 'string' && input.startsWith('https://huggingface.co/')
      ? `${location.origin}/__hf/${input.slice('https://huggingface.co/'.length)}`
      : input,
    init,
  )) as typeof fetch;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Builds the voice fresh (a new page load starts with nothing installed in a fresh profile). */
const voiceFor = (assets: { workerUrl: string; runtimeUrl: string }) =>
  browserGoogleVoice(page as never, assets, () => false);

interface Api {
  install(assets: { workerUrl: string; runtimeUrl: string }): Promise<OnDeviceInstallSnapshot>;
  dictate(assets: { workerUrl: string; runtimeUrl: string }, speakMs: number): Promise<unknown>;
}

const api: Api = {
  install: async assets => {
    const voice = voiceFor(assets);
    page.__voice = voice;
    await voice.refresh();
    await voice.install();
    return voice.getSnapshot();
  },
  dictate: async (assets, speakMs) => {
    const voice = voiceFor(assets);
    await voice.refresh();
    /** One dictation: start, speak for `ms`, Stop. The words that appeared live, and what Stop waited for. */
    const take = async (ms: number) => {
      const live: { at: number; committed: string; interim: string }[] = [];
      const began = performance.now();
      let failure = '';
      const session = voice.createSession({
        onStart: () => undefined,
        onTranscript: () => undefined,
        onFailure: error => (failure = `${error.code}: ${error.message}`),
        onAbort: () => undefined,
        onLimit: () => undefined,
        onLive: state =>
          live.push({ at: Math.round(performance.now() - began), committed: state.committed, interim: state.interim }),
      });
      session.start();
      await sleep(ms);
      const stopped = performance.now();
      const text = await session.finish();
      return { text, failure, afterStopMs: Math.round(performance.now() - stopped), live };
    };
    // The first take loads the model (it reads the installed bytes, hashes them again and builds the transcriber): its wait
    // after Stop is the cold start. The second is the warm dictation a person has from then on.
    const cold = await take(300);
    const warm = await take(speakMs);
    return { cold: { afterStopMs: cold.afterStopMs, failure: cold.failure }, warm };
  },
};
(page as unknown as { __api: Api }).__api = api;
