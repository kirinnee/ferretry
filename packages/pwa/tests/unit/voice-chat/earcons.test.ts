/**
 * Proves Live's earcons and buzzes: which event earns which tone (a pure table over two machine states), the four
 * tones are distinct in shape, the Web Audio and vibrate adapters are guarded (silent where the device cannot, never
 * a throw), and the platform guess for the iPhone Listen fallback is total.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  cueFor,
  EARCON_GAIN,
  earconTones,
  HAPTIC_PATTERNS,
  navigatorHaptics,
  webAudioEarcons,
} from '../../../src/lib/voice-chat/earcons.ts';
import { INITIAL_LIVE_STATE, type LiveState } from '../../../src/lib/voice-chat/live-machine.ts';
import { needsTapToListen } from '../../../src/lib/voice-chat/platform.ts';
import type { EarconKind } from '../../../src/lib/voice-chat/ports.ts';

const state = (patch: Partial<LiveState>): LiveState => ({ ...INITIAL_LIVE_STATE, ...patch });

describe('cueFor — which event earns which tone', () => {
  const none = { earcon: null, haptic: null };

  it('listening: the microphone just opened (first time and after each reply), and only then', () => {
    should(cueFor(state({ phase: 'starting' }), state({ phase: 'listening' }))).deepEqual({
      earcon: 'listening',
      haptic: null,
    });
    // A take that came to nothing goes quietly back to listening: no tone.
    should(cueFor(state({ phase: 'sending' }), state({ phase: 'listening' }))).deepEqual(none);
    should(cueFor(state({ phase: 'hearing' }), state({ phase: 'listening' }))).deepEqual(none);
  });

  it('sent: the message went (tone and a buzz)', () => {
    should(cueFor(state({ phase: 'sending' }), state({ phase: 'working' }))).deepEqual({
      earcon: 'sent',
      haptic: 'sent',
    });
  });

  it("reply ready: the ferret's turn ended, however Live goes on (tone and a buzz)", () => {
    for (const next of ['reading', 'starting', 'hold'] as const) {
      should(cueFor(state({ phase: 'working' }), state({ phase: next }))).deepEqual({
        earcon: 'reply-ready',
        haptic: 'reply-ready',
      });
    }
    // Away from the screen the tab is quiet.
    should(cueFor(state({ phase: 'working' }), state({ phase: 'paused' }))).deepEqual(none);
  });

  it('stopped: Live ended; a refusal to start has no tone', () => {
    for (const before of ['listening', 'hearing', 'sending', 'working', 'reading', 'hold', 'paused'] as const) {
      should(cueFor(state({ phase: before }), state({ phase: 'off' }))).deepEqual({ earcon: 'stopped', haptic: null });
    }
    should(
      cueFor(state({ phase: 'working' }), state({ phase: 'off', notice: { kind: 'ended', why: 'ferret-stopped' } })),
    ).deepEqual({ earcon: 'stopped', haptic: null });
    should(
      cueFor(state({ phase: 'starting' }), state({ phase: 'off', notice: { kind: 'blocked', block: 'mic-blocked' } })),
    ).deepEqual(none);
    should(cueFor(state({ phase: 'off' }), state({ phase: 'off' }))).deepEqual(none);
  });

  it('nothing else is announced: the same phase, a countdown, a hold, hearing you', () => {
    should(cueFor(state({ phase: 'listening' }), state({ phase: 'listening' }))).deepEqual(none);
    should(cueFor(state({ phase: 'listening' }), state({ phase: 'hearing' }))).deepEqual(none);
    should(cueFor(state({ phase: 'hearing' }), state({ phase: 'sending' }))).deepEqual(none);
    should(cueFor(state({ phase: 'listening' }), state({ phase: 'hold' }))).deepEqual(none);
    should(cueFor(state({ phase: 'reading' }), state({ phase: 'hold' }))).deepEqual(none);
    should(cueFor(state({ phase: 'reading' }), state({ phase: 'starting' }))).deepEqual(none);
  });
});

describe('the tones', () => {
  const KINDS: readonly EarconKind[] = ['listening', 'sent', 'reply-ready', 'stopped'];

  it('are four distinct shapes, each short, quiet, and made of oscillators (no files)', () => {
    const shapes = KINDS.map(kind => {
      const tones = earconTones(kind);
      should(tones.length).be.above(0);
      const end = Math.max(...tones.map(tone => tone.startMs + tone.durationMs));
      should(end).be.belowOrEqual(400);
      return tones.map(tone => tone.frequency).join('>');
    });
    should(new Set(shapes).size).equal(4);
    // Rising for listening, falling for stopped.
    const [l1, l2] = earconTones('listening').map(tone => tone.frequency);
    should(l2 ?? 0).be.above(l1 ?? 0);
    const [s1, s2] = earconTones('stopped').map(tone => tone.frequency);
    should(s2 ?? 0).be.below(s1 ?? 0);
    should(EARCON_GAIN).be.belowOrEqual(0.2);
  });

  it('an unknown kind has no notes', () => {
    should(earconTones('nope' as EarconKind)).deepEqual([]);
  });
});

describe('webAudioEarcons', () => {
  const fakeContext = () => {
    const calls: string[] = [];
    const context = {
      currentTime: 10,
      destination: {},
      state: 'suspended' as string,
      resume: async () => {
        calls.push('resume');
        context.state = 'running';
      },
      createOscillator: () => {
        const node = {
          type: '',
          frequency: {
            setValueAtTime: (value: number) => void calls.push(`freq:${value}`),
            linearRampToValueAtTime: () => undefined,
          },
          connect: () => undefined,
          start: (at: number) => void calls.push(`start:${at}`),
          stop: () => void calls.push('stop'),
        };
        return node;
      },
      createGain: () => ({
        gain: {
          setValueAtTime: () => undefined,
          linearRampToValueAtTime: (value: number) => void calls.push(`ramp:${value}`),
        },
        connect: () => undefined,
      }),
    };
    return { context, calls };
  };

  it('plays one oscillator per note, quietly, and resumes a suspended context (inside the tap, via unlock)', () => {
    const { context, calls } = fakeContext();
    const port = webAudioEarcons(function Ctor() {
      return context;
    } as never);
    port.unlock();
    should(calls).containEql('resume');
    port.play('reply-ready');
    should(calls.filter(call => call.startsWith('freq:'))).deepEqual(['freq:659.25', 'freq:880']);
    should(calls.filter(call => call === 'stop').length).equal(2);
    should(calls).containEql(`ramp:${EARCON_GAIN}`);
  });

  it('unlock is silent when the context breaks while being read', () => {
    const port = webAudioEarcons(function Ctor() {
      return {
        currentTime: 0,
        destination: {},
        get state(): string {
          throw new Error('broken');
        },
        createOscillator: () => {
          throw new Error('no');
        },
        createGain: () => {
          throw new Error('no');
        },
      };
    } as never);
    port.unlock();
  });

  it('is silent — never an error — with no Web Audio, a constructor that throws, or a context that breaks', () => {
    const none = webAudioEarcons(undefined);
    none.unlock();
    none.play('sent');
    const throwing = webAudioEarcons(function Ctor() {
      throw new Error('blocked');
    } as never);
    throwing.unlock();
    throwing.play('sent');
    const broken = webAudioEarcons(function Ctor() {
      return {
        currentTime: 0,
        destination: {},
        createOscillator: () => {
          throw new Error('no');
        },
        createGain: () => {
          throw new Error('no');
        },
      };
    } as never);
    broken.play('stopped');
  });
});

describe('navigatorHaptics', () => {
  it('vibrates with the pattern for each buzz, and tolerates a device that cannot', () => {
    const buzzed: (readonly number[])[] = [];
    const haptics = navigatorHaptics({
      vibrate: pattern => {
        buzzed.push(pattern);
        return true;
      },
    });
    haptics.pulse('sent');
    haptics.pulse('reply-ready');
    should(buzzed).deepEqual([HAPTIC_PATTERNS.sent, HAPTIC_PATTERNS['reply-ready']]);
    navigatorHaptics({}).pulse('sent');
    navigatorHaptics(undefined).pulse('sent');
    navigatorHaptics({
      vibrate: () => {
        throw new Error('not allowed');
      },
    }).pulse('sent');
  });
});

describe('needsTapToListen', () => {
  it('is true on an iPhone, an iPad, and an iPad pretending to be a Mac; false on a Mac and everything else', () => {
    should(needsTapToListen({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' })).be.true();
    should(needsTapToListen({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)' })).be.true();
    should(
      needsTapToListen({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 5 }),
    ).be.true();
    should(
      needsTapToListen({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 0 }),
    ).be.false();
    should(needsTapToListen({ userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/120' })).be.false();
    should(needsTapToListen({})).be.false();
    should(needsTapToListen(undefined)).be.false();
    should(needsTapToListen(null)).be.false();
    should(needsTapToListen({ userAgent: 7 as never, maxTouchPoints: 'x' as never })).be.false();
  });
});
