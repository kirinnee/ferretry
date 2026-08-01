import { describe, it } from 'bun:test';
import should from 'should';
import { CaptureError } from '../../../src/lib/stt/capture-error.ts';
import { SttRequestError } from '../../../src/lib/stt/daemon-engine.ts';
import { TARGET_SAMPLE_RATE } from '../../../src/lib/stt/pcm.ts';
import {
  type CaptureLike,
  type FinishDeps,
  type FinishError,
  type FinishPhase,
  finishUtterance,
  UtteranceLatch,
} from '../../../src/lib/stt/utterance.ts';

/** One second of audio — comfortably above the mis-tap floor. */
const speech = (): Float32Array => new Float32Array(TARGET_SAMPLE_RATE);

class FakeCapture implements CaptureLike {
  cancels = 0;
  stops = 0;
  #samples: Float32Array | Error;
  #release: (() => void) | null = null;

  constructor(samples: Float32Array | Error = speech()) {
    this.#samples = samples;
  }

  /** Holds the flush open so a race can be arranged around it. */
  hold(): () => void {
    let release = (): void => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    this.#release = () => {
      release();
    };
    this.#gate = gate;
    return () => this.#release?.();
  }

  #gate: Promise<void> | null = null;

  async stop(): Promise<Float32Array> {
    this.stops += 1;
    if (this.#gate !== null) await this.#gate;
    if (this.#samples instanceof Error) throw this.#samples;
    return this.#samples;
  }

  cancel(): void {
    this.cancels += 1;
  }
}

interface Recorded {
  readonly commits: string[];
  readonly phases: FinishPhase[];
  readonly errors: FinishError[];
  readonly controllers: (AbortController | null)[];
}

const deps = (
  latch: UtteranceLatch,
  overrides: Partial<FinishDeps> = {},
): FinishDeps & { readonly recorded: Recorded } => {
  const recorded: Recorded = { commits: [], phases: [], errors: [], controllers: [] };
  return {
    latch,
    transcribe: async () => 'raw text',
    refine: async (raw: string) => raw,
    commit: (text: string) => void recorded.commits.push(text),
    setPhase: (phase: FinishPhase) => void recorded.phases.push(phase),
    setError: (error: FinishError) => void recorded.errors.push(error),
    onController: (controller: AbortController | null) => void recorded.controllers.push(controller),
    recorded,
    ...overrides,
  };
};

describe('UtteranceLatch', () => {
  it('hands the capture to exactly one caller, ever', () => {
    const latch = new UtteranceLatch();
    const token = latch.begin();
    const capture = new FakeCapture();
    should(latch.attach(token, capture)).be.true();

    should(latch.claim(token)).equal(capture);
    should(latch.claim(token)).be.null();
  });

  it('refuses a claim from a stale generation', () => {
    const latch = new UtteranceLatch();
    const stale = latch.begin();
    latch.attach(stale, new FakeCapture());
    latch.begin();

    should(latch.claim(stale)).be.null();
  });

  it('tells a caller its capture was never taken, so the caller can close it', () => {
    const latch = new UtteranceLatch();
    const stale = latch.begin();
    latch.begin();

    should(latch.attach(stale, new FakeCapture())).be.false();
    should(latch.liveCapture).be.null();
  });

  it('cancels the live capture when a new utterance begins', () => {
    const latch = new UtteranceLatch();
    const first = latch.begin();
    const capture = new FakeCapture();
    latch.attach(first, capture);

    const second = latch.begin();
    should(capture.cancels).equal(1);
    should(second).not.equal(first);
    should(latch.generation).equal(second);
  });

  it('keeps a claimed capture reachable, so a cancel still closes its microphone', () => {
    const latch = new UtteranceLatch();
    const token = latch.begin();
    const capture = new FakeCapture();
    latch.attach(token, capture);
    latch.claim(token);

    should(latch.ownedCapture).equal(capture);
    latch.cancel();
    should(capture.cancels).equal(1);
    should(latch.ownedCapture).be.null();
  });

  it('releases the owned slot when the finish settles', () => {
    const latch = new UtteranceLatch();
    const token = latch.begin();
    const capture = new FakeCapture();
    latch.attach(token, capture);
    latch.claim(token);

    latch.settle(new FakeCapture());
    should(latch.ownedCapture).equal(capture);
    latch.settle(capture);
    should(latch.ownedCapture).be.null();
  });

  it('never throws when a capture is already gone', () => {
    const latch = new UtteranceLatch();
    const token = latch.begin();
    latch.attach(token, {
      stop: async () => new Float32Array(0),
      cancel: () => {
        throw new Error('already released');
      },
    });

    should(() => latch.cancel()).not.throw();
  });

  it('makes a late or duplicated background notification a no-op', () => {
    const latch = new UtteranceLatch();
    const token = latch.begin();
    latch.attach(token, new FakeCapture());

    should(latch.abort(token)).be.true();
    should(latch.abort(token)).be.false();
  });

  it('reports whether a token is still the current generation', () => {
    const latch = new UtteranceLatch();
    const token = latch.begin();
    should(latch.isCurrent(token)).be.true();
    latch.begin();
    should(latch.isCurrent(token)).be.false();
  });
});

describe('finishUtterance', () => {
  it('takes one utterance from released microphone to committed text', async () => {
    const latch = new UtteranceLatch();
    const token = latch.begin();
    const capture = new FakeCapture();
    latch.attach(token, capture);
    const dependencies = deps(latch, { refine: async (raw: string) => `${raw}!` });

    await finishUtterance(token, dependencies);

    should(dependencies.recorded.commits).deepEqual(['raw text!']);
    should(dependencies.recorded.phases).deepEqual(['transcribing', 'idle']);
    should(dependencies.recorded.controllers.at(-1)).be.null();
    should(latch.ownedCapture).be.null();
  });

  it('commits ONCE when the limit and the release arrive together', async () => {
    const latch = new UtteranceLatch();
    const token = latch.begin();
    const capture = new FakeCapture();
    const release = capture.hold();
    latch.attach(token, capture);
    const dependencies = deps(latch);

    // Both callers arrive before the flush resolves — the shape of the kteam bug.
    const first = finishUtterance(token, dependencies);
    const second = finishUtterance(token, dependencies);
    release();
    await Promise.all([first, second]);

    should(dependencies.recorded.commits).deepEqual(['raw text']);
    should(capture.stops).equal(1);
  });

  it('says nothing at all about a mis-tap', async () => {
    const latch = new UtteranceLatch();
    const token = latch.begin();
    latch.attach(token, new FakeCapture(new Float32Array(10)));
    const dependencies = deps(latch);

    await finishUtterance(token, dependencies);

    should(dependencies.recorded.commits).deepEqual([]);
    should(dependencies.recorded.errors).deepEqual([]);
    should(dependencies.recorded.phases).deepEqual(['idle']);
  });

  it('honours an explicit minimum', async () => {
    const latch = new UtteranceLatch();
    const token = latch.begin();
    latch.attach(token, new FakeCapture(new Float32Array(TARGET_SAMPLE_RATE * 2)));
    const dependencies = deps(latch, { minSeconds: 5 });

    await finishUtterance(token, dependencies);
    should(dependencies.recorded.phases).deepEqual(['idle']);
  });

  it('reports a capture that failed to flush', async () => {
    const latch = new UtteranceLatch();
    const token = latch.begin();
    latch.attach(token, new FakeCapture(new CaptureError('audio-unavailable', 'the microphone went away')));
    const dependencies = deps(latch);

    await finishUtterance(token, dependencies);

    should(dependencies.recorded.errors).deepEqual([
      { code: 'audio-unavailable', message: 'the microphone went away' },
    ]);
    should(dependencies.recorded.phases).deepEqual(['error']);
  });

  it('stays silent when the tab backgrounded during a failing flush', async () => {
    const latch = new UtteranceLatch();
    const token = latch.begin();
    const capture = new FakeCapture(new Error('gone'));
    const release = capture.hold();
    latch.attach(token, capture);
    const dependencies = deps(latch);

    const finish = finishUtterance(token, dependencies);
    latch.abort(token);
    release();
    await finish;

    should(dependencies.recorded.errors).deepEqual([]);
    should(dependencies.recorded.phases).deepEqual([]);
  });

  it('stays silent when the tab backgrounded during a successful flush', async () => {
    const latch = new UtteranceLatch();
    const token = latch.begin();
    const capture = new FakeCapture();
    const release = capture.hold();
    latch.attach(token, capture);
    const dependencies = deps(latch);

    const finish = finishUtterance(token, dependencies);
    latch.abort(token);
    release();
    await finish;

    should(dependencies.recorded.commits).deepEqual([]);
    should(dependencies.recorded.phases).deepEqual([]);
  });

  it('never commits a transcript that arrives after a newer utterance began', async () => {
    const latch = new UtteranceLatch();
    const token = latch.begin();
    latch.attach(token, new FakeCapture());
    const dependencies = deps(latch, {
      transcribe: async () => {
        latch.begin();
        return 'stale text';
      },
    });

    await finishUtterance(token, dependencies);
    should(dependencies.recorded.commits).deepEqual([]);
  });

  it('never commits refined text from an utterance the reader moved on from', async () => {
    const latch = new UtteranceLatch();
    const token = latch.begin();
    latch.attach(token, new FakeCapture());
    const dependencies = deps(latch, {
      refine: async (raw: string) => {
        latch.begin();
        return raw;
      },
    });

    await finishUtterance(token, dependencies);
    should(dependencies.recorded.commits).deepEqual([]);
  });

  it('treats a cancelled request as nothing happening, not as an error', async () => {
    const latch = new UtteranceLatch();
    const token = latch.begin();
    latch.attach(token, new FakeCapture());
    const dependencies = deps(latch, {
      transcribe: async () => {
        throw new SttRequestError('aborted', 'Transcription was cancelled.');
      },
    });

    await finishUtterance(token, dependencies);

    should(dependencies.recorded.errors).deepEqual([]);
    should(dependencies.recorded.phases).deepEqual(['transcribing', 'idle']);
  });

  it('reports the engine’s own code and message', async () => {
    const latch = new UtteranceLatch();
    const token = latch.begin();
    latch.attach(token, new FakeCapture());
    const dependencies = deps(latch, {
      transcribe: async () => {
        throw new SttRequestError('busy', 'A transcript is already running.');
      },
    });

    await finishUtterance(token, dependencies);
    should(dependencies.recorded.errors).deepEqual([{ code: 'busy', message: 'A transcript is already running.' }]);
  });

  it('reports an unknown failure without pretending to know its shape', async () => {
    const latch = new UtteranceLatch();
    const token = latch.begin();
    latch.attach(token, new FakeCapture());

    const fromError = deps(latch, {
      transcribe: async () => {
        throw new Error('the model exploded');
      },
    });
    await finishUtterance(token, fromError);
    should(fromError.recorded.errors).deepEqual([{ code: 'unknown', message: 'the model exploded' }]);

    const second = latch.begin();
    latch.attach(second, new FakeCapture());
    const fromThrow = deps(latch, {
      transcribe: async () => {
        throw 'nope';
      },
    });
    await finishUtterance(second, fromThrow);
    should(fromThrow.recorded.errors).deepEqual([{ code: 'unknown', message: 'Transcription failed.' }]);
  });

  it('stays silent when the utterance was abandoned mid-transcription', async () => {
    const latch = new UtteranceLatch();
    const token = latch.begin();
    latch.attach(token, new FakeCapture());
    const dependencies = deps(latch, {
      transcribe: async () => {
        latch.begin();
        throw new Error('too late');
      },
    });

    await finishUtterance(token, dependencies);

    should(dependencies.recorded.errors).deepEqual([]);
    should(dependencies.recorded.controllers.at(-1)).not.be.null();
  });

  it('claims nothing for a token that is no longer current', async () => {
    const latch = new UtteranceLatch();
    const token = latch.begin();
    latch.attach(token, new FakeCapture());
    latch.begin();
    const dependencies = deps(latch);

    await finishUtterance(token, dependencies);
    should(dependencies.recorded.phases).deepEqual([]);
  });
});
