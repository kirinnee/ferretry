/**
 * A QUESTION IS READ EVEN THOUGH ITS FORM REPLACES LIVE (F137 slice 5, fix round 2) — through the real
 * SessionChatPage, the real Composer, hook, runner and machine, the real Live reader over the page's ONE read-aloud
 * controller and the real speech adapter over a fake browser. Only the microphone, the clock and the engine's audio
 * are fakes.
 *
 * Live is owned by the Composer, and a pending structured question REPLACES the Composer with the question form. The
 * runner went with it, taking the question's reading (still in its 500 ms settle) along: the question and its options
 * were never spoken and the page's auto-read stayed switched off for Live. Now the page keeps a reader that outlives the
 * Composer: it speaks the question and its options, the microphone and the sends are already gone, so the question is
 * read and NEVER answerable by voice.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { unitClock } from '../../../daemon/tests/support/unit-clock.ts';
import { SessionSearchProvider } from '../../src/features/session-search/session-search.tsx';
import { ReadAloudProvider } from '../../src/hooks/use-read-aloud.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { SessionChatPage } from '../../src/lib/pages/session-chat-page.tsx';
import { writeMdComposePref } from '../../src/lib/md-compose.ts';
import { DEFAULT_STT_SETTINGS } from '../../src/lib/stt/stt-settings.ts';
import { createReadAloud } from '../../src/lib/voice-chat/read-aloud.ts';
import { createSpeechSynthesisSpeaker } from '../../src/lib/voice-chat/speech-synthesis.ts';
import { WorkspaceLayoutStore } from '../../src/lib/workspace-layout-store.ts';
import { WorkspaceRailPreferenceStore } from '../../src/lib/workspace-rail-preferences.ts';
import { fakeRecognitionProvider } from '../support/browser-recognition.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { typeInto } from '../support/dom-form.ts';
import { FakeSynth, FakeUtterance } from '../support/fake-speech.ts';
import { sessionView } from '../support/sessions.ts';

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 12; turn += 1) await interact(async () => await Promise.resolve());
};

const descriptorOf = (target: object, key: string) => Object.getOwnPropertyDescriptor(target, key);

type Restore = () => void;
const patch = (target: object, key: string, value: unknown): Restore => {
  const original = descriptorOf(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  return () => {
    if (original === undefined) delete (target as Record<string, unknown>)[key];
    else Object.defineProperty(target, key, original);
  };
};

const PENDING = {
  toolUseId: 'ask',
  questions: [{ question: 'Which option?', options: [{ label: 'One' }, { label: 'Two' }] }],
};
const ASKING = {
  status: 'awaiting_question',
  turnState: 'needs-input',
  turnStateAt: '2026-11-05T01:00:01Z',
  pendingQuestion: PENDING,
} as const;
const RUNNING = { status: 'running', turnState: 'your-turn', turnStateAt: '2026-11-05T01:00:00Z' } as const;

let restores: Restore[] = [];
let page: Mounted | null = null;
beforeEach(() => {
  writeMdComposePref('off');
  unitClock.hold();
});
afterEach(async () => {
  await page?.unmount();
  page = null;
  for (const restore of restores.reverse()) restore();
  restores = [];
  writeMdComposePref('on');
});

const rig = () => {
  const recognition = fakeRecognitionProvider({ endsOnStop: true });
  restores.push(
    patch(globalThis, 'isSecureContext', true),
    patch(globalThis, 'SpeechRecognition', function SpeechRecognition() {
      return recognition.create();
    }),
    patch(
      globalThis,
      'AudioContext',
      class {
        createMediaStreamSource() {
          return { connect() {}, disconnect() {} };
        }
        createAnalyser() {
          return {
            fftSize: 1024,
            getFloatTimeDomainData(buffer: Float32Array) {
              buffer.fill(0.001);
            },
          };
        }
        async resume() {}
        async close() {}
      },
    ),
    patch(navigator, 'mediaDevices', { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) }),
    patch(globalThis, 'fetch', async (input: unknown) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/fs/index'))
        return Response.json({ v: 1, sessionId: 'q', root: '/work/q', files: [], coverage: 'complete', skipped: [] });
      if (url.pathname.endsWith('/mcp'))
        return Response.json({ project: { path: '/work/q/.mcp.json', etag: null, servers: [] } });
      if (url.pathname.endsWith('/changes')) return Response.json({ repo: false, changes: [] });
      return Response.json({ entries: [] });
    }),
  );
  const daemon = daemonConnection({ daemonId: 'd', baseUrl: 'https://d.example.test', deviceId: 't' });
  const synth = new FakeSynth();
  const controller = createReadAloud({
    speaker: createSpeechSynthesisSpeaker({ synth, createUtterance: text => new FakeUtterance(text) }),
    language: () => 'en-US',
  });
  const storage = { getItem: () => null, setItem() {} };
  const layouts = new WorkspaceLayoutStore(storage);
  const rails = new WorkspaceRailPreferenceStore(storage);
  const sends: string[] = [];
  const answers: unknown[] = [];
  const client = {
    send: async (_id: string, input: { message: string }) => {
      sends.push(input.message);
      return { accepted: true };
    },
    answer: async (...args: unknown[]) => {
      answers.push(args);
    },
    interrupt: async () => undefined,
    resume: async () => undefined,
    stop: async () => undefined,
  };
  const render = (state: NonNullable<Parameters<typeof sessionView>[1]>['state']) => (
    <ReadAloudProvider controller={controller}>
      <SessionSearchProvider connection={daemon} focusSignal={0} scope={daemonSessionScope(daemon, 'q')}>
        <SessionChatPage
          client={client as never}
          connection={daemon}
          entries={[]}
          formFactor="desktop"
          onSessionChange={() => undefined}
          presentation="pane"
          session={sessionView('q', { state })}
          workspaceLayouts={layouts}
          workspaceRails={rails}
          dictationSettings={{ ...DEFAULT_STT_SETTINGS, enabled: true, engine: 'browser' }}
        />
      </SessionSearchProvider>
    </ReadAloudProvider>
  );
  const root = (): HTMLElement => (page as Mounted).container;
  const phase = (): string | null => root().querySelector('[data-live-phase]')?.getAttribute('data-live-phase') ?? null;
  /** Live on, a message sent by hand (Live is Working on it), ready for the ferret's question. */
  const working = async (): Promise<void> => {
    page = await mount(render(RUNNING));
    await flush();
    await interact(() =>
      must(root().querySelector<HTMLButtonElement>('button[aria-label="Live voice"]'), 'Live').click(),
    );
    await flush();
    expect(phase()).toBe('listening');
    await typeInto(must(root().querySelector('textarea'), 'composer'), 'ask me a question', 'textarea');
    await flush();
    await interact(() => must(root().querySelector<HTMLButtonElement>('button[aria-label="Send"]'), 'Send').click());
    await flush();
    expect(phase()).toBe('working');
  };
  const ask = async (): Promise<void> => {
    await (page as Mounted).render(render(ASKING));
    await flush();
  };
  const settle = async (ms = 5_000): Promise<void> => {
    await interact(() => unitClock.advance(ms));
    await flush();
  };
  return { recognition, synth, controller, sends, answers, render, root, phase, working, ask, settle };
};

describe('Live and a structured question', () => {
  it('reads the question AND its options aloud when the form replaces Live; nothing listens, nothing is sent', async () => {
    const r = rig();
    await r.working();
    await r.ask();
    // The form replaced the composer — and Live with it.
    expect(r.root().querySelector('.fy-question-form')).not.toBeNull();
    expect(r.root().querySelector('textarea')).toBeNull();
    expect(r.phase()).toBeNull();

    await r.settle();
    const spoken = r.controller.getState();
    expect(spoken.status).toBe('reading');
    expect(spoken.segments.join(' ')).toContain('Which option?');
    expect(spoken.segments.join(' ')).toContain('One');
    expect(spoken.segments.join(' ')).toContain('Two');
    expect(r.synth.queue.length).toBeGreaterThan(0);

    // The microphone is gone and the question is not answerable by voice: nothing is sent or answered, by speech or time.
    const takes = r.recognition.created;
    await r.settle(60_000);
    expect(r.recognition.created).toBe(takes);
    expect(r.sends).toEqual(['ask me a question']);
    expect(r.answers).toEqual([]);
  });

  it('the reading ends with the speech, and the person answers the form by hand as always', async () => {
    const r = rig();
    await r.working();
    await r.ask();
    await r.settle();
    await interact(async () => {
      while (r.synth.queue.length > 0) r.synth.play();
    });
    await flush();
    expect(r.controller.getState().status).toBe('finished');
    expect(r.root().querySelector('.fy-question-form')).not.toBeNull();
  });

  it('answering the question (or the turn moving on) before it is read cuts the reading', async () => {
    const r = rig();
    await r.working();
    await r.ask();
    await r.settle(600);
    expect(r.controller.getState().status).toBe('reading');
    // The ferret got its answer from somewhere else: the question is gone, and so is its reading.
    await (page as Mounted).render(
      r.render({ status: 'running', turnState: 'your-turn', turnStateAt: '2026-11-05T01:00:09Z' }),
    );
    await flush();
    expect(r.controller.getState().status).toBe('stopped');
    expect(r.synth.queue).toHaveLength(0);
  });

  it('a question that arrives while Live is only LISTENING is not read (Live was not waiting on the ferret)', async () => {
    const r = rig();
    page = await mount(r.render(RUNNING));
    await flush();
    await interact(() =>
      must(r.root().querySelector<HTMLButtonElement>('button[aria-label="Live voice"]'), 'Live').click(),
    );
    await flush();
    expect(r.phase()).toBe('listening');
    await r.ask();
    await r.settle();
    expect(r.controller.getState().status).toBe('idle');
    // (Starting Live speaks one silent space to unlock iOS speech: nothing else.)
    expect(r.synth.spoken.filter(utterance => utterance.text.trim() !== '')).toHaveLength(0);
  });

  it('a question with Live OFF is not read by this path at all', async () => {
    const r = rig();
    page = await mount(r.render(RUNNING));
    await flush();
    await r.ask();
    await r.settle();
    expect(r.controller.getState().status).toBe('idle');
  });

  it('leaving the page silences the question', async () => {
    const r = rig();
    await r.working();
    await r.ask();
    await r.settle(600);
    expect(r.controller.getState().status).toBe('reading');
    await page?.unmount();
    page = null;
    expect(r.controller.getState().status).toBe('idle');
    expect(r.synth.queue.filter(utterance => utterance.text.trim() !== '')).toHaveLength(0);
  });
});
