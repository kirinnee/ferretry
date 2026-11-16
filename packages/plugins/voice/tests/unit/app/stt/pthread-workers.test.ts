/**
 * Proves the only widening speech threads need (`pthread-workers.ts`): ONNX Runtime's sub-workers may start
 * under Trusted Types when — and only when — they are the app's own speech worker scripts on this origin.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { allowSpeechThreads, vetThreadUrl } from '../../../../app/lib/stt/pthread-workers.ts';
import { createTrustedTypes, isWorkerScriptUrl } from '../../../../app/shell-voice.ts';

const ORIGIN = 'https://ferretry.pages.dev';
const scope = { location: { href: `${ORIGIN}/assets/parakeet-worker-Ab12_-x.js`, origin: ORIGIN } };
const trust = (path: string): string => {
  if (!isWorkerScriptUrl(path)) throw new TypeError('refused');
  return `trusted:${path}`;
};

describe('vetThreadUrl', () => {
  it('trusts the speech worker’s own script, as the sub-workers ONNX Runtime starts', () => {
    should(vetThreadUrl(`${ORIGIN}/assets/parakeet-worker-Ab12_-x.js`, scope, trust)).equal(
      'trusted:/assets/parakeet-worker-Ab12_-x.js',
    );
    should(vetThreadUrl(new URL(`${ORIGIN}/assets/whisper-worker-Zz9.js`), scope, trust)).equal(
      'trusted:/assets/whisper-worker-Zz9.js',
    );
    should(vetThreadUrl('/assets/vosk-worker-Q.js', scope, trust)).equal('trusted:/assets/vosk-worker-Q.js');
  });

  it('trusts the dev server’s address of the same module', () => {
    should(vetThreadUrl('/src/worker/parakeet-worker.ts?worker_file&type=module', scope, trust)).equal(
      'trusted:/src/worker/parakeet-worker.ts?worker_file&type=module',
    );
  });

  it('hands every other URL on unchanged, for the browser to refuse as before', () => {
    for (const other of [
      `${ORIGIN}/assets/app-Ab12.js`,
      `${ORIGIN}/sw.verified.js`,
      `${ORIGIN}/assets/parakeet-worker-x.js/../../evil.js`,
      'https://evil.example/assets/parakeet-worker-Ab12_-x.js',
      'data:text/javascript,alert(1)',
      'blob:https://ferretry.pages.dev/1234',
      'not a url at all \u0000',
    ])
      should(vetThreadUrl(other, scope, trust)).equal(other);
  });

  it('hands a URL it cannot read, or one the policy refuses, on unchanged', () => {
    const unreadable = {
      toString: (): string => {
        throw new Error('no string form');
      },
    };
    should(vetThreadUrl(unreadable, scope, trust)).equal(unreadable);
    const refusing = (): string => {
      throw new TypeError('policy says no');
    };
    const mine = `${ORIGIN}/assets/parakeet-worker-Ab12_-x.js`;
    should(vetThreadUrl(mine, scope, refusing)).equal(mine);
  });

  it('never throws, whatever it is handed', () => {
    for (const odd of [undefined, null, 5, {}, Symbol.iterator.description])
      should(() => vetThreadUrl(odd, scope, trust)).not.throw();
  });

  it('agrees with the page’s own policy on what a speech worker is', () => {
    const real = createTrustedTypes(undefined);
    should(vetThreadUrl(`${ORIGIN}/assets/sherpa-worker-AAA.js`, scope, real.scriptUrl)).equal(
      '/assets/sherpa-worker-AAA.js',
    );
    should(vetThreadUrl(`${ORIGIN}/assets/other-worker-AAA.js`, scope, real.scriptUrl)).equal(
      `${ORIGIN}/assets/other-worker-AAA.js`,
    );
  });
});

describe('allowSpeechThreads', () => {
  class FakeWorker {
    static made: { url: unknown; options: unknown }[] = [];
    constructor(url: unknown, options?: unknown) {
      FakeWorker.made.push({ url, options });
    }
  }

  const fresh = () => {
    FakeWorker.made = [];
    return {
      Worker: FakeWorker as unknown as new (url: unknown, options?: unknown) => unknown,
      location: scope.location,
    };
  };

  it('makes the worker’s constructor pass its own script through the policy, keeping the options', () => {
    const page = fresh();
    allowSpeechThreads(page, trust);
    new page.Worker(`${ORIGIN}/assets/parakeet-worker-Ab12_-x.js`, { type: 'module', name: 'em-pthread' });
    should(FakeWorker.made).deepEqual([
      { url: 'trusted:/assets/parakeet-worker-Ab12_-x.js', options: { type: 'module', name: 'em-pthread' } },
    ]);
  });

  it('leaves other URLs exactly as they were', () => {
    const page = fresh();
    allowSpeechThreads(page, trust);
    new page.Worker('blob:https://ferretry.pages.dev/1');
    should(FakeWorker.made[0]?.url).equal('blob:https://ferretry.pages.dev/1');
  });

  it('wraps once, however many times it is called', () => {
    const page = fresh();
    allowSpeechThreads(page, trust);
    const first = page.Worker;
    allowSpeechThreads(page, trust);
    should(page.Worker).equal(first);
    new page.Worker(`${ORIGIN}/assets/parakeet-worker-A.js`);
    should(FakeWorker.made.length).equal(1);
  });
});
