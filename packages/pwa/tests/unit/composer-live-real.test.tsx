/**
 * Live voice through the REAL composer, runner, live take, Parakeet session and browser capture (only the browser media
 * APIs, the model, the clock and the shared-draft daemon are fakes): the send boundaries a stop must hold.
 *
 *   - A Live send is revocable across EVERY await, including the shared-draft wait, and commits only at the moment of
 *     the actual submission.
 *   - A composition (IME) holds Live; Live never degrades into an ordinary send of text the person did not approve.
 *   - A hide during Working latches until an explicit Resume.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { unitClock } from '../../../daemon/tests/support/unit-clock.ts';
import {
  applyTextOp,
  type SharedDraftClientFrame,
  SharedDraftClientFrameSchema,
  type SharedDraftSent,
  type SharedDraftServerFrame,
} from '../../../protocol/src/lib/index.ts';
import { Composer } from '../../src/components/composer.tsx';
import { readLiveDocument } from '../../src/components/live-markdown-editor.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonDraftStore, type DraftStorage } from '../../src/lib/drafts.ts';
import type { DaemonStreamOpener } from '../../src/lib/event-transport.ts';
import { writeMdComposePref } from '../../src/lib/md-compose.ts';
import type { RelayClientSession } from '../../src/lib/relay-session.ts';
import { DEFAULT_STT_SETTINGS } from '../../src/lib/stt/stt-settings.ts';
import type { ReplySnapshot, ReplySource } from '../../src/lib/voice-chat/reply-feed.ts';
import { fakeRecognitionProvider } from '../support/browser-recognition.ts';
import { interact, mount, must } from '../support/dom.ts';
import { typeInto } from '../support/dom-form.ts';
import { type FakeLive, fakeLive } from '../support/live-ports.ts';

const daemon = daemonConnection({
  daemonId: 'daemon-a',
  baseUrl: 'https://daemon-a.example.test',
  deviceId: 'token-a',
});
const BROWSER_VOICE = { ...DEFAULT_STT_SETTINGS, engine: 'browser' } as const;

const memoryStorage = (): DraftStorage => {
  const entries = new Map<string, string>();
  return {
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
};

const replySource = (): ReplySource => {
  const snapshot: ReplySnapshot = { turnState: 'your-turn', turnStateAt: 't0', status: 'running' };
  return { current: () => snapshot, subscribe: () => () => undefined };
};

const textareaOf = (container: HTMLElement): HTMLTextAreaElement =>
  must(container.querySelector('textarea'), 'the composer textarea');
const liveButton = (container: HTMLElement): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>('button[aria-label="Live voice"]');
const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) await interact(async () => await Promise.resolve());
};

import { type AudioCaptureGlobalLike, browserAudioCapture } from '../../src/lib/stt/audio-capture.ts';
import { browserSessionHost } from '../../src/lib/stt/on-device-host.ts';
import { ParakeetRecognitionSession } from '../../src/lib/stt/parakeet-session.ts';
import { LiveRunner } from '../../src/lib/voice-chat/live-runner.ts';
import { liveTakePort } from '../../src/lib/voice-chat/live-take.ts';
import { documentVisibility } from '../../src/lib/voice-chat/visibility.ts';

/** The capture decodes blobs (`Blob.arrayBuffer`), which is not a microtask: let real timers run too. */
const settle = async (): Promise<void> => {
  await interact(async () => {
    await unitClock.quiet();
    for (let i = 0; i < 50; i++) await Promise.resolve();
  });
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}
const deferred = <T,>(): Deferred<T> => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
};

/** The browser's media APIs, with the microphone's tracks observable. */
const media = () => {
  const tracks = { live: 0, stopped: 0 };
  const recorders: { stops: number }[] = [];
  class Recorder {
    mimeType = 'audio/webm';
    ondataavailable: ((event: { readonly data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    readonly seen = { stops: 0 };
    constructor(_stream: unknown) {
      recorders.push(this.seen);
    }
    start(): void {}
    stop(): void {
      this.seen.stops += 1;
      this.ondataavailable?.({ data: new Blob([new Uint8Array(8)]) });
      this.onstop?.();
    }
    requestData(): void {
      this.ondataavailable?.({ data: new Blob([new Uint8Array(8)]) });
    }
  }
  class Offline {
    async decodeAudioData() {
      const loud = new Float32Array(16_000).fill(0.2);
      return { numberOfChannels: 1, length: loud.length, getChannelData: () => loud };
    }
  }
  const global: AudioCaptureGlobalLike = {
    navigator: {
      mediaDevices: {
        getUserMedia: async () => {
          tracks.live += 1;
          return {
            getTracks: () => [
              {
                stop: () => {
                  tracks.live -= 1;
                  tracks.stopped += 1;
                },
              },
            ],
          };
        },
      },
    },
    MediaRecorder: Recorder,
    OfflineAudioContext: Offline,
  };
  return { global, tracks, recorders };
};

/**
 * A page's document: `visibilitychange` listeners called in registration order. `snapshot` fans the event out to a copy
 * of the listener list, so a listener removed by an earlier one still runs (an event already queued to every watcher).
 */
class FakeDocument {
  visibilityState = 'visible';
  readonly #listeners: (() => void)[] = [];
  constructor(private readonly snapshot: boolean) {}
  addEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.#listeners.push(listener);
  }
  removeEventListener(_type: 'visibilitychange', listener: () => void): void {
    const at = this.#listeners.indexOf(listener);
    if (at >= 0) this.#listeners.splice(at, 1);
  }
  get watchers(): number {
    return this.#listeners.length;
  }
  show(): void {
    this.visibilityState = 'visible';
    for (const listener of [...this.#listeners]) listener();
  }
  hide(): void {
    this.visibilityState = 'hidden';
    const called = this.snapshot ? [...this.#listeners] : this.#listeners;
    for (let at = 0; at < called.length; at += 1) called[at]?.();
  }
}

/**
 * A runner over fake ports, except the take: the real adapter over a real Parakeet session over real capture.
 * With `page`, the session watches the REAL `watchHidden` (`on-device-host.ts`) and the runner the REAL
 * `documentVisibility`, both over that document: a hide reaches the runner first and the session second.
 */
const realRig = (fake: FakeLive, page?: FakeDocument) => {
  const world = media();
  const host =
    page === undefined
      ? null
      : browserSessionHost({
          ...world.global,
          document: page,
          setTimeout: () => 0,
          clearTimeout: () => undefined,
        });
  const decode = deferred<string>();
  const decodes: AbortSignal[] = [];
  const take = liveTakePort({
    createSession: callbacks =>
      new ParakeetRecognitionSession(
        {
          capture: browserAudioCapture(world.global),
          engine: {
            preload: () => undefined,
            transcribe: async (_samples, signal) => {
              if (signal !== undefined) decodes.push(signal);
              return await decode.promise;
            },
          },
          watchHidden: host === null ? () => () => undefined : onHidden => host.watchHidden(onHidden),
          setTimeout: () => 0,
          clearTimeout: () => undefined,
          now: () => fake.ports.clock.now(),
        },
        callbacks,
      ),
    clean: async text => ({ text, kept: 'raw' }),
  });
  const ports =
    page === undefined ? { ...fake.ports, take } : { ...fake.ports, take, visibility: documentVisibility(page) };
  const runner = new LiveRunner(ports, { canSend: true });
  return { ...world, decode, decodes, runner, ports };
};
const AT = '2026-11-05T00:00:00Z';

class Machine {
  text = '';
  epoch = 0;
  rev = 0;
  held = false;
  clears = true;
  streams = true;
  readonly edits: SharedDraftClientFrame[] = [];
  readonly opened: number[] = [];
  private readonly waiting: (() => void)[] = [];
  private live: { deliver: (frame: SharedDraftServerFrame) => void; kill: () => void } | undefined;

  readonly open: DaemonStreamOpener = async (_daemon, request) => {
    if (!this.streams) throw new Error('this machine has no shared draft stream');
    this.opened.push(this.epoch);
    const closers: ((closed: { code: number; reason: string }) => void)[] = [];
    let alive = true;
    const deliver = (frame: SharedDraftServerFrame): void => {
      const go = (): void =>
        queueMicrotask(() => {
          if (alive) request.onData({ kind: 'text', text: JSON.stringify(frame) });
        });
      if (this.held) this.waiting.push(go);
      else go();
    };
    const kill = (): void => {
      if (!alive) return;
      alive = false;
      for (const closer of closers) closer({ code: 1006, reason: 'gone' });
    };
    this.live = { deliver, kill };
    // A composer that reconnects where the draft still stands has missed nothing: the daemon only says so.
    const at = new Map(request.query ?? []);
    const current =
      at.get('generation') === 'g' && Number(at.get('epoch')) === this.epoch && Number(at.get('rev')) === this.rev;
    if (!current)
      deliver({
        kind: 'snapshot',
        snapshot: {
          v: 1,
          sessionId: 's1',
          generation: 'g',
          epoch: this.epoch,
          rev: this.rev,
          text: this.text,
          items: [],
          updatedAt: AT,
        },
      });
    deliver({ kind: 'ready' });
    return {
      sendStream: (frame: { text?: string }) => this.receive(deliver, frame.text ?? ''),
      closeStream: () => {
        alive = false;
      },
      onStreamClosed: (listener: (closed: { code: number; reason: string }) => void) => closers.push(listener),
    } as unknown as RelayClientSession;
  };

  release(): void {
    this.held = false;
    for (const go of this.waiting.splice(0)) go();
  }

  /** The network drops the stream: the composer reconnects and catches up from a snapshot. */
  drop(): void {
    this.live?.kill();
  }

  /** The send route: once the message is accepted, its words leave the draft. */
  clear(requestId: string, sent: SharedDraftSent): void {
    if (!this.clears || sent.epoch !== this.epoch || sent.base !== this.rev) return;
    this.apply({ ...sent, sent: true }, requestId, undefined);
  }

  private receive(deliver: (frame: SharedDraftServerFrame) => void, text: string): void {
    const frame = SharedDraftClientFrameSchema.parse(JSON.parse(text));
    if (frame.kind === 'presence') return;
    this.edits.push(frame);
    // One device: an edit names the revision it stands on, or it was typed into a message already sent.
    if (frame.edit.epoch !== this.epoch || frame.edit.base !== this.rev) {
      deliver({ kind: 'error', id: frame.id, code: 'shared_draft_stale', message: 'read it again' });
      return;
    }
    this.apply(frame.edit, frame.id, deliver);
  }

  private apply(
    edit: { readonly text?: readonly (number | string)[]; readonly sent?: boolean },
    id: string,
    own: ((frame: SharedDraftServerFrame) => void) | undefined,
  ): void {
    const op = edit.text ?? [this.text.length];
    this.text = applyTextOp(this.text, op as never);
    const applied = { generation: 'g', epoch: this.epoch, rev: this.rev + 1, text: op as never, add: [], remove: [] };
    const finished = edit.sent === true && this.text === '';
    this.epoch = finished ? this.epoch + 1 : this.epoch;
    this.rev = finished ? 0 : this.rev + 1;
    const position = { epoch: this.epoch, rev: this.rev };
    if (own === undefined) this.live?.deliver({ kind: 'edit', id, applied, ...position });
    else own({ kind: 'ack', id, applied, ...position });
  }
}

const phaseOf = (container: HTMLElement): string | null | undefined =>
  container.querySelector('[data-live-phase]')?.getAttribute('data-live-phase');
const clickAction = (container: HTMLElement, action: string): void =>
  must(container.querySelector<HTMLButtonElement>(`[data-live-action="${action}"]`), action).click();

/** The daemon's answer to a send, held until the test lets it go (`gate`). */
interface Gate {
  readonly promise: Promise<void>;
  open(): void;
}
const gate = (): Gate => {
  let open: () => void = () => undefined;
  const promise = new Promise<void>(resolve => {
    open = resolve;
  });
  return { promise, open };
};

const integrated = async (options: { machine?: Machine; sendGate?: Gate; rich?: boolean } = {}) => {
  const fake = fakeLive();
  const page = new FakeDocument(true);
  const hardware = realRig(fake, page);
  const { send: _send, ...ports } = hardware.ports;
  const sent: string[] = [];
  const drafts = new DaemonDraftStore(memoryStorage());
  const api = {
    send: async (_id: string, body: { message: string }) => {
      sent.push(body.message);
      await options.sendGate?.promise;
      return {};
    },
  };
  const element = (
    <Composer
      api={api as never}
      daemon={daemon}
      dictationRecognition={fakeRecognitionProvider({ endsOnStop: true })}
      dictationSettings={BROWSER_VOICE}
      draftStore={drafts}
      sessionId="s1"
      liveReply={replySource()}
      liveVoiceSeams={{ ports }}
      {...(options.machine === undefined ? {} : { openDraftStream: options.machine.open, sharedUploads: false })}
    />
  );
  const composer = await mount(element);
  await settle();
  await flush();
  await interact(() => must(liveButton(composer.container), 'Live').click());
  await settle();
  await flush();
  expect(phaseOf(composer.container)).toBe('listening');
  return { fake, page, hardware, sent, composer };
};
type World = Awaited<ReturnType<typeof integrated>>;

/** One spoken turn whose real decode answers `words`: they are in the box and the countdown is about to run. */
const finishReal = async (w: World, words = 'Fix the bug.'): Promise<void> => {
  await interact(() => {
    w.fake.hear(0.1, 600);
    w.fake.hear(0.001, 1520);
  });
  await settle();
  expect(w.hardware.decodes.length).toBe(1);
  await interact(() => w.hardware.decode.resolve(words));
  await settle();
  await flush();
  expect(boxText(w.composer.container)).toBe(words);
};

/** The words in the message box, whichever editor draws it. */
const boxText = (container: HTMLElement): string => {
  const editor = container.querySelector<HTMLElement>('[data-live-editor]');
  return editor === null ? textareaOf(container).value : readLiveDocument(editor);
};

const typeRaw = (text: HTMLTextAreaElement, value: string): void => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(text, value);
  text.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('Live send boundaries through the real composer, runner, take, Parakeet and capture', () => {
  beforeEach(() => {
    writeMdComposePref('off');
    unitClock.hold();
  });
  afterEach(() => writeMdComposePref('on'));

  it("the person's own Send retires a slow real decode", async () => {
    const w = await integrated();
    const text = textareaOf(w.composer.container);
    await typeInto(text, 'Please', 'textarea');
    await flush();
    await interact(() => clickAction(w.composer.container, 'Resume'));
    await settle();
    await interact(() => {
      w.fake.hear(0.1, 600);
      w.fake.hear(0.001, 1520);
    });
    await settle();
    await interact(() =>
      must(w.composer.container.querySelector<HTMLButtonElement>('button[type=submit]'), 'Send').click(),
    );
    await settle();
    expect(w.sent).toEqual(['Please']);
    await interact(() => w.hardware.decode.resolve('late words'));
    await settle();
    await interact(() => w.fake.advance(60000));
    await flush();
    expect(w.sent).toEqual(['Please']);
    expect(text.value).toBe('');
    expect(w.hardware.tracks.live).toBe(0);
    await w.composer.unmount();
  });

  for (const stop of ['hold', 'hidden', 'end', 'typing'] as const)
    it(`a send queued behind the render is revoked by ${stop}`, async () => {
      const w = await integrated();
      await finishReal(w);
      await interact(() => {
        w.fake.advance(1500);
        if (stop === 'hold') clickAction(w.composer.container, 'Hold');
        if (stop === 'end') must(liveButton(w.composer.container), 'Live').click();
        if (stop === 'hidden') w.page.hide();
        if (stop === 'typing') typeRaw(textareaOf(w.composer.container), 'edited after approval');
      });
      await settle();
      await flush();
      expect(w.sent).toEqual([]);
      expect(w.hardware.tracks.live).toBe(0);
      await w.composer.unmount();
    });

  describe('while the shared draft has not answered yet', () => {
    /** Words on screen, the countdown over, and the composer waiting on the daemon's answer to its last keystroke. */
    const waiting = async () => {
      const machine = new Machine();
      const w = await integrated({ machine });
      machine.held = true;
      await finishReal(w);
      expect(machine.edits.length).toBeGreaterThan(0);
      await interact(() => w.fake.advance(1500));
      await settle();
      await flush();
      expect(w.sent).toEqual([]);
      return { machine, w };
    };

    it('sends the approved words exactly once when nothing stops it (the send commits at its submission)', async () => {
      const { machine, w } = await waiting();
      await interact(() => machine.release());
      await settle();
      await flush();
      expect(w.sent).toEqual(['Fix the bug.']);
      await w.composer.unmount();
    });

    for (const stop of ['end', 'hidden', 'hidden and shown again', 'typing', 'unmount'] as const)
      it(`stays revocable: ${stop} before the answer comes sends nothing, even once it does`, async () => {
        const { machine, w } = await waiting();
        if (stop === 'end') await interact(() => must(liveButton(w.composer.container), 'Live').click());
        if (stop === 'hidden') await interact(() => w.page.hide());
        if (stop === 'hidden and shown again')
          await interact(() => {
            w.page.hide();
            w.page.show();
          });
        if (stop === 'typing') await interact(() => typeRaw(textareaOf(w.composer.container), 'Fix the bug. Now'));
        if (stop === 'unmount') await w.composer.unmount();
        await interact(() => machine.release());
        await settle();
        await flush();
        await interact(() => unitClock.advance(2000));
        await settle();
        await flush();
        expect(w.sent).toEqual([]);
        expect(w.hardware.tracks.live).toBe(0);
        if (stop !== 'unmount') await w.composer.unmount();
      });

    it('does not send after the page is gone when the wait only runs out later', async () => {
      const { w } = await waiting();
      await w.composer.unmount();
      await interact(() => unitClock.advance(2000));
      await settle();
      await flush();
      expect(w.sent).toEqual([]);
    });
  });

  describe('an input-method composition', () => {
    const compose = async (rich: boolean) => {
      writeMdComposePref(rich ? 'on' : 'off');
      const w = await integrated();
      await finishReal(w);
      return w;
    };

    it('holds Live at compositionstart; text the editor shows before `input` is reported is never sent', async () => {
      const w = await compose(true);
      const editor = must(w.composer.container.querySelector<HTMLElement>('[data-live-editor]'), 'rich editor');
      expect(readLiveDocument(editor)).toBe('Fix the bug.');
      await interact(() => editor.dispatchEvent(new Event('compositionstart', { bubbles: true })));
      expect(phaseOf(w.composer.container)).toBe('hold');
      must(editor.lastElementChild, 'last line').textContent = 'Fix the bug. UNFINISHED';
      await interact(() => w.fake.advance(1500));
      await settle();
      await flush();
      expect(w.sent).toEqual([]);
      expect(w.hardware.tracks.live).toBe(0);
      await w.composer.unmount();
    });

    it('holds Live at compositionstart in the plain textarea too', async () => {
      const w = await compose(false);
      const text = textareaOf(w.composer.container);
      await interact(() => text.dispatchEvent(new Event('compositionstart', { bubbles: true })));
      expect(phaseOf(w.composer.container)).toBe('hold');
      await interact(() => w.fake.advance(1500));
      await settle();
      await flush();
      expect(w.sent).toEqual([]);
      await w.composer.unmount();
    });

    it('never sends a Live attempt that reaches the composer while a composition is open', async () => {
      const w = await compose(false);
      const text = textareaOf(w.composer.container);
      // The composition begins in the same task as the countdown ending: the send is queued behind the render.
      await interact(() => {
        w.fake.advance(1500);
        text.dispatchEvent(new Event('compositionstart', { bubbles: true }));
      });
      await settle();
      await flush();
      expect(w.sent).toEqual([]);
      expect(phaseOf(w.composer.container)).toBe('hold');
      await w.composer.unmount();
    });
  });

  describe('a hide while the reply is being worked on', () => {
    it('is latched across a show until an explicit Resume (the mic does not reopen on its own)', async () => {
      const w = await integrated();
      await finishReal(w);
      await interact(() => w.fake.advance(1500));
      await settle();
      expect(w.sent).toEqual(['Fix the bug.']);
      expect(phaseOf(w.composer.container)).toBe('working');
      await interact(() => {
        w.page.hide();
        w.page.show();
      });
      await flush();
      await interact(() => w.fake.signal({ kind: 'done' }));
      await settle();
      await flush();
      expect(phaseOf(w.composer.container)).toBe('paused');
      expect(w.hardware.tracks.live).toBe(0);
      await interact(() => clickAction(w.composer.container, 'Resume'));
      await settle();
      await flush();
      expect(phaseOf(w.composer.container)).toBe('listening');
      expect(w.hardware.tracks.live).toBe(1);
      await w.composer.unmount();
    });

    it('is latched when the tab is hidden while the send is still being acknowledged', async () => {
      const sendGate = gate();
      const w = await integrated({ sendGate });
      await finishReal(w);
      await interact(() => w.fake.advance(1500));
      await settle();
      expect(w.sent).toEqual(['Fix the bug.']);
      await interact(() => {
        w.page.hide();
        w.page.show();
      });
      await interact(() => sendGate.open());
      await settle();
      await flush();
      await interact(() => w.fake.signal({ kind: 'done' }));
      await settle();
      await flush();
      expect(phaseOf(w.composer.container)).toBe('paused');
      expect(w.hardware.tracks.live).toBe(0);
      expect(w.sent).toEqual(['Fix the bug.']);
      await w.composer.unmount();
    });
  });

  it('a hide during a real decode keeps the words, and Resume adds the next take after them', async () => {
    const w = await integrated();
    await interact(() => {
      w.fake.hear(0.1, 600);
      w.fake.hear(0.001, 1520);
    });
    await settle();
    await interact(() => w.page.hide());
    await settle();
    expect(w.hardware.tracks.live).toBe(0);
    expect(w.hardware.decodes[0]?.aborted).toBe(false);
    await interact(() => w.hardware.decode.resolve('Held words.'));
    await settle();
    await flush();
    expect(phaseOf(w.composer.container)).toBe('paused');
    expect(textareaOf(w.composer.container).value).toBe('Held words.');
    await interact(() => w.page.show());
    await interact(() => clickAction(w.composer.container, 'Resume'));
    await settle();
    await interact(() => {
      w.fake.hear(0.1, 600);
      w.fake.hear(0.001, 1520);
    });
    await settle();
    await flush();
    expect(textareaOf(w.composer.container).value).toBe('Held words. Held words.');
    expect(w.sent).toEqual([]);
    await w.composer.unmount();
  });
});
