/**
 * Proves the early finish (`tentative-take.ts`): the words so far are worked out while the pause is still
 * being confirmed; speech that resumes throws them away without stopping anything; a pause that holds
 * reuses them only when what followed was quiet.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { IGNORED_TAIL_SAMPLES, QUIET_TAIL_RMS, TentativeTranscriber } from '../../../src/lib/stt/tentative-take.ts';

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

const samples = (length: number, level: number): Float32Array => new Float32Array(length).fill(level);

/** `heard` is what the recording holds at `begin()`; `transcribed` records every decode the engine was asked for. */
const world = (heard: Float32Array, answer: () => Promise<string> = async () => 'hello world') => {
  const transcribed: { length: number; signal: AbortSignal }[] = [];
  const outer = new AbortController();
  let peeks = 0;
  const transcriber = new TentativeTranscriber(
    {
      peek: async () => {
        peeks += 1;
        return heard;
      },
      transcribe: async (taken, signal) => {
        transcribed.push({ length: taken.length, signal });
        return await answer();
      },
    },
    outer.signal,
  );
  return { transcriber, transcribed, outer, peeks: () => peeks };
};

describe('TentativeTranscriber.begin', () => {
  it('reads the recording and decodes it, answering the words', async () => {
    const w = world(samples(16_000, 0.1));
    const take = w.transcriber.begin();
    should(await take.text).equal('hello world');
    should(w.transcribed.map(call => call.length)).deepEqual([16_000]);
    should(w.peeks()).equal(1);
  });

  it('discarding aborts the decode and leaves nothing to reuse', async () => {
    const w = world(samples(16_000, 0.1));
    const take = w.transcriber.begin();
    await tick();
    take.discard();
    take.discard();
    should(w.transcribed[0]?.signal.aborted).equal(true);
    should(await w.transcriber.reuse(samples(16_000, 0))).equal(null);
  });

  it('a second begin replaces the first, which is discarded', async () => {
    const w = world(samples(16_000, 0.1));
    w.transcriber.begin();
    await tick();
    w.transcriber.begin();
    await tick();
    should(w.transcribed.length).equal(2);
    should(w.transcribed[0]?.signal.aborted).equal(true);
    should(w.transcribed[1]?.signal.aborted).equal(false);
  });

  it('cancelling the session aborts an attempt in flight', async () => {
    const w = world(samples(16_000, 0.1), () => new Promise(() => undefined));
    w.transcriber.begin();
    await tick();
    w.outer.abort();
    should(w.transcribed[0]?.signal.aborted).equal(true);
  });

  it('a failed decode rejects the take but does not escape as an unhandled rejection', async () => {
    const w = world(samples(16_000, 0.1), async () => {
      throw new Error('worker down');
    });
    const take = w.transcriber.begin();
    await take.text.then(
      () => should.fail('', '', 'resolved'),
      error => should(String(error)).containEql('worker down'),
    );
  });
});

describe('TentativeTranscriber.reuse', () => {
  it('reuses the answer when only silence followed the snapshot', async () => {
    const w = world(samples(16_000, 0.1));
    w.transcriber.begin();
    const final = new Float32Array(16_000 + 24_000);
    final.fill(0.1, 0, 16_000);
    should(await w.transcriber.reuse(final)).equal('hello world');
    should(w.transcribed.length).equal(1);
  });

  it('reuses it when the take ends exactly where the snapshot did, or a frame later', async () => {
    const w = world(samples(16_000, 0.1));
    w.transcriber.begin();
    should(await w.transcriber.reuse(samples(16_000, 0.1))).equal('hello world');
    should(await w.transcriber.reuse(samples(16_000 + IGNORED_TAIL_SAMPLES, 0.3))).equal('hello world');
  });

  it('refuses it when speech followed the snapshot', async () => {
    const w = world(samples(16_000, 0.1));
    w.transcriber.begin();
    const final = samples(16_000 + 8_000, 0.1);
    should(await w.transcriber.reuse(final)).equal(null);
  });

  it('treats a tail just under the quiet floor as quiet and one just over as speech', async () => {
    const w = world(samples(16_000, 0.1));
    w.transcriber.begin();
    const quiet = new Float32Array(16_000 + 8_000);
    quiet.fill(QUIET_TAIL_RMS * 0.9, 16_000);
    should(await w.transcriber.reuse(quiet)).equal('hello world');
    const loud = new Float32Array(16_000 + 8_000);
    loud.fill(QUIET_TAIL_RMS * 1.5, 16_000);
    should(await w.transcriber.reuse(loud)).equal(null);
  });

  it('refuses it when the final take is SHORTER than the snapshot (the recording is not the one heard)', async () => {
    const w = world(samples(16_000, 0.1));
    w.transcriber.begin();
    should(await w.transcriber.reuse(samples(8_000, 0.1))).equal(null);
  });

  it('answers null with no attempt, after clear, and after a failed attempt', async () => {
    const none = world(samples(16_000, 0.1));
    should(await none.transcriber.reuse(samples(16_000, 0))).equal(null);

    const cleared = world(samples(16_000, 0.1));
    cleared.transcriber.begin();
    cleared.transcriber.clear();
    should(await cleared.transcriber.reuse(samples(16_000, 0))).equal(null);

    const failed = world(samples(16_000, 0.1), async () => {
      throw new Error('boom');
    });
    failed.transcriber.begin();
    should(await failed.transcriber.reuse(samples(16_000, 0))).equal(null);
  });

  it('waits for an attempt still being decoded rather than starting a second decode', async () => {
    let finish: (text: string) => void = () => undefined;
    const w = world(samples(16_000, 0.1), () => new Promise<string>(resolve => (finish = resolve)));
    w.transcriber.begin();
    await tick();
    const reused = w.transcriber.reuse(samples(16_000, 0));
    finish('late words');
    should(await reused).equal('late words');
    should(w.transcribed.length).equal(1);
  });
});
