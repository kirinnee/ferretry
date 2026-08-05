import { describe, expect, it } from 'bun:test';
import {
  browserWaveformRuntime,
  type CaptureAnalyserTap,
  type CaptureMonitor,
  displayLevel,
  InputWaveform,
  type InputWaveformRuntime,
  inputRms,
  NO_SIGNAL_AFTER_MS,
  nextNoSignalReading,
  paintInputLevel,
  startInputWaveform,
  waveformAnalyser,
} from '../../src/components/input-waveform.tsx';
import { interact, mount, must } from '../support/dom.ts';

interface PaintCall {
  readonly op: string;
  readonly args: readonly unknown[];
}

/** A recording 2D context: every call the painter can make, remembered in order. */
const recordingContext = (): { context: CanvasRenderingContext2D; calls: PaintCall[] } => {
  const calls: PaintCall[] = [];
  const push =
    (op: string) =>
    (...args: unknown[]): void => {
      calls.push({ op, args });
    };
  const context = {
    setTransform: push('setTransform'),
    clearRect: push('clearRect'),
    save: push('save'),
    restore: push('restore'),
    fillRect: push('fillRect'),
    beginPath: push('beginPath'),
    moveTo: push('moveTo'),
    lineTo: push('lineTo'),
    stroke: push('stroke'),
    fillStyle: '',
    strokeStyle: '',
    globalAlpha: 1,
    lineWidth: 1,
  };
  return { context: context as unknown as CanvasRenderingContext2D, calls };
};

const fakeCanvas = (bounds: { width: number; height: number } | null = { width: 320, height: 56 }) => {
  const canvas = {
    width: 0,
    height: 0,
    clientWidth: 0,
    clientHeight: 0,
    getBoundingClientRect: () => ({ width: bounds?.width ?? 0, height: bounds?.height ?? 0 }) as DOMRect,
  };
  return canvas as unknown as HTMLCanvasElement;
};

interface FakeAnalyser {
  fftSize: number;
  smoothingTimeConstant: number;
  minDecibels: number;
  maxDecibels: number;
  getFloatTimeDomainData(target: Float32Array): void;
}

const fakeAnalyser = (fill: (index: number) => number = () => 0): FakeAnalyser => ({
  fftSize: 32,
  smoothingTimeConstant: 0,
  minDecibels: 0,
  maxDecibels: 0,
  getFloatTimeDomainData(target: Float32Array) {
    for (let index = 0; index < target.length; index += 1) target[index] = fill(index);
  },
});

const monitorOf = (
  analyser: unknown,
  onDisconnect: () => void = () => undefined,
): { monitor: CaptureMonitor; disconnected: () => number } => {
  let count = 0;
  const tap: CaptureAnalyserTap = {
    analyser,
    disconnect: () => {
      count += 1;
      onDisconnect();
    },
  };
  return { monitor: { createAnalyser: () => tap }, disconnected: () => count };
};

/** A manual rAF: the test decides when a frame happens and with what timestamp. */
const manualRuntime = (
  overrides: Partial<InputWaveformRuntime> = {},
): { runtime: InputWaveformRuntime; frame: (now: number) => void; cancelled: () => number[] } => {
  let pending: FrameRequestCallback | null = null;
  const cancelled: number[] = [];
  const runtime: InputWaveformRuntime = {
    requestFrame: callback => {
      pending = callback;
      return 7;
    },
    cancelFrame: handle => {
      cancelled.push(handle);
    },
    reducedMotion: null,
    pixelRatio: 1,
    color: '#abcdef',
    ...overrides,
  };
  return {
    runtime,
    frame: now => {
      const callback = pending;
      pending = null;
      callback?.(now);
    },
    cancelled: () => cancelled,
  };
};

const noSignalNode = (): HTMLElement => {
  const node = { hidden: true, textContent: '' };
  return node as unknown as HTMLElement;
};

describe('inputRms', () => {
  it('is zero for an empty buffer', () => {
    expect(inputRms(new Float32Array(0))).toBe(0);
  });

  it('is the root mean square of the samples', () => {
    expect(inputRms(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5, 10);
  });

  it('treats a non-finite sample as silence rather than propagating NaN', () => {
    expect(inputRms(new Float32Array([Number.NaN, 0]))).toBe(0);
  });
});

describe('displayLevel', () => {
  it('gates everything at or below the noise floor to zero', () => {
    expect(displayLevel(0.008)).toBe(0);
    expect(displayLevel(Number.NaN)).toBe(0);
  });

  it('rises with energy and saturates at one', () => {
    expect(displayLevel(0.05)).toBeGreaterThan(0);
    expect(displayLevel(0.05)).toBeLessThan(1);
    expect(displayLevel(9)).toBe(1);
  });
});

describe('nextNoSignalReading', () => {
  it('clears the silence clock as soon as there is energy', () => {
    expect(nextNoSignalReading(1_000, 0.5, 2_000)).toEqual({ silentSince: null, noSignal: false });
  });

  it('starts the clock on the first silent frame and reports only after the delay', () => {
    const first = nextNoSignalReading(null, 0, 1_000);
    expect(first).toEqual({ silentSince: 1_000, noSignal: false });
    expect(nextNoSignalReading(first.silentSince, 0, 1_000 + NO_SIGNAL_AFTER_MS).noSignal).toBe(true);
  });

  it('restarts the clock when the timestamp goes backwards', () => {
    expect(nextNoSignalReading(5_000, 0, 10).silentSince).toBe(10);
  });
});

describe('waveformAnalyser', () => {
  it('refuses anything that cannot report time-domain samples', () => {
    expect(waveformAnalyser(null)).toBeNull();
    expect(waveformAnalyser('analyser')).toBeNull();
    expect(waveformAnalyser({})).toBeNull();
  });

  it('accepts a tap that can', () => {
    const analyser = fakeAnalyser();
    expect(waveformAnalyser(analyser)).toBe(analyser as never);
  });
});

describe('paintInputLevel', () => {
  it('sizes the bitmap for the device pixel ratio and paints a centre line when silent', () => {
    const canvas = fakeCanvas();
    const { context, calls } = recordingContext();
    paintInputLevel(canvas, context, {
      samples: new Float32Array(4),
      level: 0,
      reducedMotion: false,
      color: '#fff',
      pixelRatio: 2,
    });
    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(112);
    expect(calls.filter(call => call.op === 'stroke')).toHaveLength(1);
    expect(calls.at(-1)?.op).toBe('restore');
  });

  it('falls back to a default box and clamps a nonsense pixel ratio', () => {
    const canvas = fakeCanvas(null);
    const { context } = recordingContext();
    paintInputLevel(canvas, context, {
      samples: new Float32Array(0),
      level: 0,
      reducedMotion: false,
      color: '#fff',
      pixelRatio: Number.NaN,
    });
    expect(canvas.width).toBe(320);
    expect(canvas.height).toBe(56);
  });

  it('draws the waveform path when there is level and a peak', () => {
    const canvas = fakeCanvas();
    const { context, calls } = recordingContext();
    paintInputLevel(canvas, context, {
      samples: new Float32Array([0.5, -0.5, Number.NaN, 0.25]),
      level: 0.8,
      reducedMotion: false,
      color: '#fff',
      pixelRatio: 1,
    });
    expect(calls.filter(call => call.op === 'lineTo').length).toBeGreaterThan(1);
    expect(calls.filter(call => call.op === 'moveTo')).toHaveLength(2);
  });

  it('skips the path when every sample is zero, even with a level', () => {
    const canvas = fakeCanvas();
    const { context, calls } = recordingContext();
    paintInputLevel(canvas, context, {
      samples: new Float32Array([0, 0, 0]),
      level: 0.9,
      reducedMotion: false,
      color: '#fff',
      pixelRatio: 1,
    });
    expect(calls.filter(call => call.op === 'stroke')).toHaveLength(1);
  });

  it('paints a bar meter instead of a waveform under reduced motion', () => {
    const canvas = fakeCanvas();
    const { context, calls } = recordingContext();
    paintInputLevel(canvas, context, {
      samples: new Float32Array([1, -1]),
      level: 2,
      reducedMotion: true,
      color: '#fff',
      pixelRatio: 1,
    });
    expect(calls.filter(call => call.op === 'fillRect')).toHaveLength(2);
    expect(calls.some(call => call.op === 'stroke')).toBe(false);
  });
});

describe('startInputWaveform', () => {
  const withContext = (canvas: HTMLCanvasElement, context: CanvasRenderingContext2D): HTMLCanvasElement => {
    (canvas as unknown as { getContext: () => CanvasRenderingContext2D }).getContext = () => context;
    return canvas;
  };

  it('does nothing at all when the canvas has no 2D context', () => {
    const canvas = fakeCanvas();
    (canvas as unknown as { getContext: () => null }).getContext = () => null;
    const { monitor } = monitorOf(fakeAnalyser());
    const { runtime } = manualRuntime();
    const stop = startInputWaveform({ monitor, canvas, noSignalElement: noSignalNode(), runtime });
    expect(stop()).toBeUndefined();
  });

  it('refuses when the recorder cannot hand back an analyser branch', () => {
    const { context } = recordingContext();
    const canvas = withContext(fakeCanvas(), context);
    const { runtime } = manualRuntime();
    expect(() =>
      startInputWaveform({
        monitor: { createAnalyser: () => null },
        canvas,
        noSignalElement: noSignalNode(),
        runtime,
      }),
    ).toThrow(/cannot provide an analyser/);
  });

  it('gives the branch back when the tap cannot report levels', () => {
    const { context } = recordingContext();
    const canvas = withContext(fakeCanvas(), context);
    const { monitor, disconnected } = monitorOf({ notAnAnalyser: true });
    const { runtime } = manualRuntime();
    expect(() => startInputWaveform({ monitor, canvas, noSignalElement: noSignalNode(), runtime })).toThrow(
      /cannot report input levels/,
    );
    expect(disconnected()).toBe(1);
  });

  it('closes the branch when a throwing tap cannot even be disconnected', () => {
    const { context } = recordingContext();
    const canvas = withContext(fakeCanvas(), context);
    const tap: CaptureAnalyserTap = {
      analyser: {},
      disconnect: () => {
        throw new Error('already gone');
      },
    };
    const { runtime } = manualRuntime();
    expect(() =>
      startInputWaveform({ monitor: { createAnalyser: () => tap }, canvas, noSignalElement: noSignalNode(), runtime }),
    ).toThrow(/cannot report input levels/);
  });

  it('releases the branch when the analyser refuses configuration', () => {
    const { context } = recordingContext();
    const canvas = withContext(fakeCanvas(), context);
    const hostile = {
      getFloatTimeDomainData: () => undefined,
      set fftSize(_value: number) {
        throw new Error('nope');
      },
    };
    const { monitor, disconnected } = monitorOf(hostile);
    const { runtime } = manualRuntime();
    expect(() => startInputWaveform({ monitor, canvas, noSignalElement: noSignalNode(), runtime })).toThrow('nope');
    expect(disconnected()).toBe(1);
  });

  it('releases the branch when the reduced-motion query refuses a listener', () => {
    const { context } = recordingContext();
    const canvas = withContext(fakeCanvas(), context);
    const { monitor, disconnected } = monitorOf(fakeAnalyser());
    const { runtime } = manualRuntime({
      reducedMotion: {
        matches: false,
        addEventListener: () => {
          throw new Error('detached');
        },
      } as unknown as MediaQueryList,
    });
    expect(() => startInputWaveform({ monitor, canvas, noSignalElement: noSignalNode(), runtime })).toThrow('detached');
    expect(disconnected()).toBe(1);
  });

  it('cleans up when the very first frame cannot be scheduled', () => {
    const { context } = recordingContext();
    const canvas = withContext(fakeCanvas(), context);
    const { monitor, disconnected } = monitorOf(fakeAnalyser());
    const { runtime } = manualRuntime({
      requestFrame: () => {
        throw new Error('no raf');
      },
    });
    expect(() => startInputWaveform({ monitor, canvas, noSignalElement: noSignalNode(), runtime })).toThrow('no raf');
    expect(disconnected()).toBe(1);
  });

  it('paints, throttles, reveals the no-signal notice, and hides it again', () => {
    const { context, calls } = recordingContext();
    const canvas = withContext(fakeCanvas(), context);
    let loud = false;
    const { monitor, disconnected } = monitorOf(fakeAnalyser(() => (loud ? 0.4 : 0)));
    const notice = noSignalNode();
    const { runtime, frame, cancelled } = manualRuntime();
    const stop = startInputWaveform({ monitor, canvas, noSignalElement: notice, runtime });

    frame(0);
    const afterFirst = calls.length;
    // Inside the 20 fps interval: the loop reschedules without painting.
    frame(10);
    expect(calls.length).toBe(afterFirst);

    frame(NO_SIGNAL_AFTER_MS);
    expect(notice.hidden).toBe(false);

    loud = true;
    frame(NO_SIGNAL_AFTER_MS + 1_000);
    expect(notice.hidden).toBe(true);

    stop();
    stop();
    expect(cancelled()).toEqual([7]);
    expect(disconnected()).toBe(1);
  });

  it('ends the monitor rather than stranding the branch when a frame throws', () => {
    const { context } = recordingContext();
    const canvas = withContext(fakeCanvas(), context);
    const exploding = {
      fftSize: 8,
      smoothingTimeConstant: 0,
      minDecibels: 0,
      maxDecibels: 0,
      getFloatTimeDomainData: () => {
        throw new Error('detached canvas');
      },
    };
    const { monitor, disconnected } = monitorOf(exploding);
    const { runtime, frame } = manualRuntime();
    startInputWaveform({ monitor, canvas, noSignalElement: noSignalNode(), runtime });
    frame(0);
    expect(disconnected()).toBe(1);
  });

  it('ignores a frame that fires after cleanup', () => {
    const { context, calls } = recordingContext();
    const canvas = withContext(fakeCanvas(), context);
    const { monitor } = monitorOf(fakeAnalyser());
    const { runtime, frame } = manualRuntime();
    const stop = startInputWaveform({ monitor, canvas, noSignalElement: noSignalNode(), runtime });
    stop();
    frame(0);
    expect(calls).toHaveLength(0);
  });

  it('repaints immediately when the reduced-motion preference changes mid-run', () => {
    const { context, calls } = recordingContext();
    const canvas = withContext(fakeCanvas(), context);
    const { monitor } = monitorOf(fakeAnalyser());
    // A holder, not a `let`: TypeScript narrows a closure-assigned local back to
    // `null` at the call site, which is a fact about inference and not the test.
    const captured: { listener: ((event: MediaQueryListEvent) => void) | null } = { listener: null };
    let removed = 0;
    const { runtime, frame } = manualRuntime({
      reducedMotion: {
        matches: false,
        addEventListener: (_type: string, next: (event: MediaQueryListEvent) => void) => {
          captured.listener = next;
        },
        removeEventListener: () => {
          removed += 1;
        },
      } as unknown as MediaQueryList,
    });
    const stop = startInputWaveform({ monitor, canvas, noSignalElement: noSignalNode(), runtime });
    frame(0);
    const painted = calls.length;
    must(captured.listener, 'a reduced-motion listener')({ matches: true } as MediaQueryListEvent);
    // Without the reset the next frame would be inside the throttle window.
    frame(5);
    expect(calls.length).toBeGreaterThan(painted);
    stop();
    expect(removed).toBe(1);
  });

  it('falls back to the legacy addListener pair on older WebKit', () => {
    const { context } = recordingContext();
    const canvas = withContext(fakeCanvas(), context);
    const { monitor } = monitorOf(fakeAnalyser());
    let added = 0;
    let removed = 0;
    const { runtime } = manualRuntime({
      reducedMotion: {
        matches: true,
        addListener: () => {
          added += 1;
        },
        removeListener: () => {
          removed += 1;
        },
      } as unknown as MediaQueryList,
    });
    const stop = startInputWaveform({ monitor, canvas, noSignalElement: noSignalNode(), runtime });
    expect(added).toBe(1);
    stop();
    expect(removed).toBe(1);
  });

  it('survives a media query and a rAF handle that both refuse teardown', () => {
    const { context } = recordingContext();
    const canvas = withContext(fakeCanvas(), context);
    const { monitor, disconnected } = monitorOf(fakeAnalyser());
    const { runtime } = manualRuntime({
      cancelFrame: () => {
        throw new Error('document is gone');
      },
      reducedMotion: {
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => {
          throw new Error('detached query');
        },
      } as unknown as MediaQueryList,
    });
    const stop = startInputWaveform({ monitor, canvas, noSignalElement: noSignalNode(), runtime });
    stop();
    expect(disconnected()).toBe(1);
  });

  it('does not install any listener on a query that supports neither API', () => {
    const { context } = recordingContext();
    const canvas = withContext(fakeCanvas(), context);
    const { monitor } = monitorOf(fakeAnalyser());
    const { runtime } = manualRuntime({ reducedMotion: {} as unknown as MediaQueryList });
    expect(() => startInputWaveform({ monitor, canvas, noSignalElement: noSignalNode(), runtime })()).not.toThrow();
  });
});

describe('browserWaveformRuntime', () => {
  it('reads rAF, the reduced-motion query, the pixel ratio and the computed colour', () => {
    const canvas = document.createElement('canvas');
    const runtime = must(browserWaveformRuntime(canvas), 'a browser runtime');
    const handle = runtime.requestFrame(() => undefined);
    runtime.cancelFrame(handle);
    expect(runtime.pixelRatio).toBeGreaterThan(0);
    expect(typeof runtime.color).toBe('string');
  });
});

/** happy-dom has no canvas backend, so the component's own element is given one. */
const withCanvasContext = async (body: () => Promise<void>): Promise<void> => {
  const { context } = recordingContext();
  const canvasPrototype = HTMLCanvasElement.prototype as unknown as { getContext: unknown };
  const original = canvasPrototype.getContext;
  canvasPrototype.getContext = () => context;
  try {
    await body();
  } finally {
    canvasPrototype.getContext = original;
  }
};

describe('<InputWaveform>', () => {
  it('renders the meter and keeps the no-signal notice hidden with no monitor', async () => {
    const view = await mount(<InputWaveform monitor={null} />);
    expect(view.container.querySelector('canvas')).not.toBeNull();
    expect(must(view.container.querySelector('p'), 'the notice').hidden).toBe(true);
    await view.unmount();
  });

  it('renders nothing extra when the browser offers no runtime', async () => {
    const { monitor } = monitorOf(fakeAnalyser());
    const view = await mount(<InputWaveform monitor={monitor} runtime={() => null} />);
    expect(must(view.container.querySelector('p'), 'the notice').hidden).toBe(true);
    await view.unmount();
  });

  it('names the unavailable meter instead of reporting a dead microphone', async () => {
    await withCanvasContext(async () => {
      const view = await mount(
        <InputWaveform
          monitor={{ createAnalyser: () => null }}
          runtime={() => ({
            requestFrame: () => 1,
            cancelFrame: () => undefined,
            reducedMotion: null,
            pixelRatio: 1,
            color: '#fff',
          })}
        />,
      );
      const notice = must(view.container.querySelector('p'), 'the notice');
      expect(notice.hidden).toBe(false);
      expect(notice.textContent).toContain('unavailable');
      await view.unmount();
    });
  });

  it('drives a real paint loop and tears it down on unmount', async () => {
    await withCanvasContext(async () => {
      const { monitor, disconnected } = monitorOf(fakeAnalyser(() => 0.3));
      const { runtime, frame } = manualRuntime();
      const view = await mount(<InputWaveform monitor={monitor} runtime={() => runtime} />);
      await interact(() => frame(0));
      await view.unmount();
      expect(disconnected()).toBe(1);
    });
  });
});
