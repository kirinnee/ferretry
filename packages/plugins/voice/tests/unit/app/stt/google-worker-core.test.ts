/**
 * Proves the Google worker's behaviour with a fake transcriber: it loads the named model once from the verified install,
 * answers in arrival order, turns MediaPipe's final and interim segments into committed and interim words, ends an
 * open take before starting another, and turns every failure into an answer the page can attribute.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import {
  type GoogleResult,
  type GoogleSegment,
  type GoogleTranscriberPort,
  GoogleWorkerCore,
} from '../../../../app/lib/stt/google-worker-core.ts';
import type { SherpaWorkerReply } from '../../../../app/lib/stt/sherpa-worker-core.ts';

const final = (transcript: string): GoogleSegment => ({ transcript, isFinal: true });
const interim = (transcript: string): GoogleSegment => ({ transcript, isFinal: false });

/** A transcriber that answers scripted results, one per call, and counts what it was asked. */
class FakeTranscriber implements GoogleTranscriberPort {
  readonly pushed: number[] = [];
  finishes = 0;
  readonly script: GoogleResult[] = [];
  readonly finishScript: GoogleResult[] = [];
  failPush = false;

  async transcribeStream(samples: Float32Array): Promise<GoogleResult> {
    if (this.failPush) throw new Error('the model fell over');
    this.pushed.push(samples.length);
    return this.script.shift() ?? { segments: [] };
  }
  async finishStream(): Promise<GoogleResult> {
    this.finishes += 1;
    return this.finishScript.shift() ?? { segments: [] };
  }
}

const harness = (
  options: {
    read?: () => Promise<{ runtime: Uint8Array; model: Uint8Array }>;
    load?: () => Promise<GoogleTranscriberPort>;
  } = {},
) => {
  const replies: SherpaWorkerReply[] = [];
  const transcriber = new FakeTranscriber();
  let clock = 100;
  let loads = 0;
  const core = new GoogleWorkerCore({
    read: options.read ?? (async () => ({ runtime: new Uint8Array([1]), model: new Uint8Array([2]) })),
    runtime: {
      load:
        options.load ??
        (async () => {
          loads += 1;
          clock += 40;
          return transcriber;
        }),
    },
    post: reply => replies.push(reply),
    now: () => clock,
  });
  return { core, replies, transcriber, loads: () => loads };
};

const load = { type: 'load', model: 'google-audio-transcriber' } as const;
const slice = (length = 4_000): Float32Array => new Float32Array(length);

describe('the Google worker core', () => {
  it('loads the model once, on the first message that needs it, and says how long it took', async () => {
    const { core, replies, loads } = harness();
    await core.handle(load);
    await core.handle({ type: 'stream-open', id: 1 });
    await core.handle({ type: 'stream-drop', id: 1 });
    should(loads()).equal(1);
    should(replies).eql([{ type: 'ready', loadMs: 40 }]);
  });

  it('ignores a model the catalog does not name for this runtime, and anything that is not a request', async () => {
    const { core, replies } = harness();
    await core.handle({ type: 'load', model: 'sherpa-zipformer-en' });
    await core.handle({ type: 'nonsense' });
    await core.handle(null);
    should(replies).have.length(1);
    should(replies[0]).containEql({ type: 'failed', id: null, code: 'load-failed' });
  });

  it('answers nothing for a slice that completes no window, then the words so far', async () => {
    const { core, replies, transcriber } = harness();
    transcriber.script.push(
      { segments: [] },
      { segments: [interim('Please fix the login')] },
      { segments: [final('Please fix the login redirect,'), interim('and run the tests')] },
    );
    await core.handle(load);
    await core.handle({ type: 'stream-open', id: 1 });
    for (let index = 0; index < 3; index += 1) await core.handle({ type: 'stream-push', id: 1, samples: slice() });
    should(replies.slice(1)).eql([
      { type: 'partial', id: 1, committed: '', interim: 'Please fix the login' },
      { type: 'partial', id: 1, committed: 'Please fix the login redirect,', interim: 'and run the tests' },
    ]);
    should(transcriber.pushed).eql([4_000, 4_000, 4_000]);
  });

  it('keeps every final, in order, never changing them, and replaces the interim each time', async () => {
    const { core, replies, transcriber } = harness();
    transcriber.script.push(
      { segments: [final('One.'), interim('two three')] },
      { segments: [final('Two three.'), interim('four')] },
    );
    await core.handle(load);
    await core.handle({ type: 'stream-open', id: 7 });
    await core.handle({ type: 'stream-push', id: 7, samples: slice() });
    await core.handle({ type: 'stream-push', id: 7, samples: slice() });
    should(replies.at(-1)).eql({ type: 'partial', id: 7, committed: 'One. Two three.', interim: 'four' });
  });

  it('flushes the tail on close and answers the whole text, with the finals joined by single spaces', async () => {
    const { core, replies, transcriber } = harness();
    transcriber.script.push({ segments: [final('Hello there.'), interim('how are')] });
    transcriber.finishScript.push({ segments: [final(' how are you '), final('today?')] });
    await core.handle(load);
    await core.handle({ type: 'stream-open', id: 1 });
    await core.handle({ type: 'stream-push', id: 1, samples: slice() });
    await core.handle({ type: 'stream-close', id: 1 });
    should(replies.at(-1)).eql({ type: 'result', id: 1, text: 'Hello there. how are you today?' });
    should(transcriber.finishes).equal(1);
  });

  it('answers an empty take with an empty text', async () => {
    const { core, replies } = harness();
    await core.handle(load);
    await core.handle({ type: 'stream-open', id: 1 });
    await core.handle({ type: 'stream-close', id: 1 });
    should(replies.at(-1)).eql({ type: 'result', id: 1, text: '' });
  });

  it('ends an open take before it starts another, so the transcriber never mixes two', async () => {
    const { core, replies, transcriber } = harness();
    transcriber.script.push({ segments: [final('Old words.')] });
    transcriber.finishScript.push({ segments: [final('left over')] });
    await core.handle(load);
    await core.handle({ type: 'stream-open', id: 1 });
    await core.handle({ type: 'stream-push', id: 1, samples: slice() });
    await core.handle({ type: 'stream-open', id: 2 });
    should(transcriber.finishes).equal(1);
    await core.handle({ type: 'stream-close', id: 2 });
    should(replies.at(-1)).eql({ type: 'result', id: 2, text: '' });
  });

  it('drops an open take by ending it, and leaves another one alone', async () => {
    const { core, transcriber } = harness();
    await core.handle(load);
    await core.handle({ type: 'stream-open', id: 1 });
    await core.handle({ type: 'stream-drop', id: 9 });
    should(transcriber.finishes).equal(0);
    await core.handle({ type: 'stream-drop', id: 1 });
    should(transcriber.finishes).equal(1);
  });

  it('refuses a whole-take transcription: this model listens while you speak', async () => {
    const { core, replies } = harness();
    await core.handle(load);
    await core.handle({ type: 'transcribe', id: 3, samples: slice() });
    should(replies.at(-1)).containEql({ type: 'failed', id: 3, code: 'transcribe-failed' });
  });

  it('answers a push to a take that is not open with a failure for it', async () => {
    const { core, replies } = harness();
    await core.handle(load);
    await core.handle({ type: 'stream-push', id: 5, samples: slice() });
    should(replies.at(-1)).containEql({
      type: 'failed',
      id: 5,
      code: 'transcribe-failed',
      message: 'That stream is not open.',
    });
  });

  it('closes the take that failed, so the next one starts clean', async () => {
    const { core, replies, transcriber } = harness();
    await core.handle(load);
    await core.handle({ type: 'stream-open', id: 1 });
    transcriber.failPush = true;
    await core.handle({ type: 'stream-push', id: 1, samples: slice() });
    should(replies.at(-1)).containEql({
      type: 'failed',
      id: 1,
      code: 'transcribe-failed',
      message: 'the model fell over',
    });
    await core.handle({ type: 'stream-close', id: 1 });
    should(replies.at(-1)).containEql({ type: 'failed', id: 1, message: 'That stream is not open.' });
  });

  it('says why a load failed, with the install’s own code, and tries again on the next message', async () => {
    let attempts = 0;
    const transcriber = new FakeTranscriber();
    const { core, replies } = harness({
      read: async () => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error('Speech model is not installed.'), { code: 'not-installed' });
        if (attempts === 2) throw Object.assign(new Error('The model changed.'), { code: 'integrity' });
        return { runtime: new Uint8Array([1]), model: new Uint8Array([2]) };
      },
      load: async () => transcriber,
    });
    await core.handle(load);
    await core.handle({ type: 'stream-open', id: 1 });
    await core.handle({ type: 'stream-open', id: 2 });
    should(replies.slice(0, 3)).eql([
      { type: 'failed', id: null, code: 'not-installed', message: 'Speech model is not installed.' },
      { type: 'failed', id: 1, code: 'integrity', message: 'The model changed.' },
      { type: 'ready', loadMs: replies[2] && 'loadMs' in replies[2] ? replies[2].loadMs : 0 },
    ]);
  });

  it('calls a transcriber that will not start a failed load, in the engine’s words', async () => {
    const { core, replies } = harness({
      load: async () => {
        throw new Error('the runtime would not compile');
      },
    });
    await core.handle(load);
    should(replies).eql([{ type: 'failed', id: null, code: 'load-failed', message: 'the runtime would not compile' }]);
  });
});
