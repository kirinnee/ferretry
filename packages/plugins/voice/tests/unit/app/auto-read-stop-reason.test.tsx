import { afterEach, expect, test } from 'bun:test';
import type { ReactElement } from 'react';
import { type AutoReadInput, useAutoRead } from '../../../app/hooks/use-auto-read.ts';
import { useLiveVoiceLines } from '../../../app/hooks/use-live-voice-lines.ts';
import { LiveVoiceSettingsProvider } from '../../../app/hooks/use-live-voice-settings.ts';
import { ReadAloudProvider } from '../../../app/hooks/use-read-aloud.ts';
import { createLiveLines, type LiveLine, type LiveSink } from '../../../app/lib/voice-mode/live-lines.ts';
import { createMachineSpeaker } from '../../../app/lib/voice-mode/machine-speaker.ts';
import type { SpeechLineEvent } from '../../../app/lib/stream/voice-stream.ts';
import { LiveVoiceSettingsStore } from '../../../app/lib/voice-chat/live-settings.ts';
import { createReadAloud, type ReadAloudController } from '../../../app/lib/voice-chat/read-aloud.ts';
import type { PickerRow } from '../../../app/lib/voice-chat/reply-picker.ts';
import { createSpeechSynthesisSpeaker } from '../../../app/lib/voice-chat/speech-synthesis.ts';
import { interact, type Mounted, mount } from '../../support/app/dom.ts';
import { FakeSynth, FakeUtterance, voice } from '../../support/app/fake-speech.ts';

/**
 * WHO stopped a reading decides whether the ferret is told what was heard. The person stopping it (a tap, "stop", talking over it) is a
 * cut-off the machine's voice reports; the tab going to the background, or auto-read being switched off, is no one's choice, and the
 * voice only hushes: the daemon must never turn those into a message to the owner's ferret.
 */

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});
const AT = Date.UTC(2026, 10, 26, 3, 0, 0);
const iso = (ms: number): string => new Date(AT + ms).toISOString();
const person = (id: string): PickerRow => ({ id, kind: 'user', text: '(voice) check the build', at: AT });
interface Page {
  readonly rows: readonly PickerRow[];
  readonly turn: 'working' | 'your-turn';
  readonly at: number;
  readonly active?: boolean;
}

/** The machine voice, for real: the panel's own queue over a fake stream that records what it was asked to speak and to take back. */
function realSink() {
  const spoken: { id: number; text: string }[] = [];
  const dropped: number[] = [];
  const cuts: string[] = [];
  let next = 0;
  const pending: number[] = [];
  const deps = {
    stream: () => ({
      speak: (text: string) => {
        const id = next++;
        spoken.push({ id, text });
        pending.push(id);
        return [{ id, text }];
      },
      drop: (ids: readonly number[]) => void dropped.push(...ids),
      hush: () => void pending.splice(0),
      interrupt: () => {
        cuts.push('person');
        pending.splice(0);
      },
    }),
    replyState: () => 'ready' as const,
    player: { remainingMs: () => 0 },
    every: () => () => undefined,
  };
  const live = createLiveLines(deps);
  const speaker = createMachineSpeaker(deps);
  return {
    sink: live as LiveSink,
    speaker,
    pending,
    spoken,
    dropped,
    cuts,
    /** A line's sound as the stream reports it. */
    heard: (id: number, event: SpeechLineEvent['event'], code?: string) => {
      if (event !== 'started' && pending.includes(id)) pending.splice(pending.indexOf(id), 1);
      const line = code === undefined ? { id, event } : { id, event, code };
      speaker.onSpeech(line);
      live.onSpeech(line);
    },
  };
}

function rig(options: { attachMachine?: boolean; sink?: 'takes' | 'refuses' | 'none' | 'real' } = {}) {
  const synth = new FakeSynth([voice('Samantha', 'en-US', { isDefault: true })]);
  const speaker = createSpeechSynthesisSpeaker({ synth, createUtterance: text => new FakeUtterance(text) });
  const controller: ReadAloudController = createReadAloud({ speaker, language: () => 'en-US' });
  const settings = new LiveVoiceSettingsStore({ getItem: () => null, setItem: () => undefined });
  const said: LiveLine[] = [];
  const machine = realSink();
  if (options.attachMachine) controller.attach(machine.speaker);
  const sink: LiveSink | undefined =
    options.sink === 'none'
      ? undefined
      : options.sink === 'real'
        ? machine.sink
        : {
            say: line => {
              if (options.sink === 'refuses') return false;
              said.push(line);
              return true;
            },
            outdate: () => undefined,
          };
  function Probe({ page }: { readonly page: Page }) {
    const lines = useLiveVoiceLines({
      active: page.active ?? true,
      rows: page.rows,
      live: true,
      visible: true,
      sink: () => sink,
    });
    useAutoRead({
      scope: 'd/s',
      entries: page.rows,
      authoritative: true,
      forced: page.active ?? true,
      unsaid: lines.unsaid,
      turn: page.turn,
      turnStateAt: iso(page.at),
      question: null,
      sends: [],
    } satisfies AutoReadInput);
    return null;
  }
  const tree = (page: Page): ReactElement => (
    <LiveVoiceSettingsProvider store={settings}>
      <ReadAloudProvider controller={controller}>
        <Probe page={page} />
      </ReadAloudProvider>
    </LiveVoiceSettingsProvider>
  );
  return { synth, said, tree, controller, machine };
}

/** A turn the page sees from its start: working, lines closing one by one, then your-turn. */
const START: Page = { rows: [person('u0')], turn: 'your-turn', at: -1_000 };
const hidden = async <T,>(act: () => Promise<T> | T): Promise<void> => {
  const previous = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  try {
    await interact(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await act();
  } finally {
    if (previous === undefined) Reflect.deleteProperty(document, 'visibilityState');
    else Object.defineProperty(document, 'visibilityState', previous);
  }
};

const reading = async () => {
  const r = rig({ attachMachine: true });
  mounted = await mount(r.tree(START));
  await interact(() => r.controller.read('reply', '<voice>Check the build status.</voice>'));
  expect(r.controller.getState().status).toBe('reading');
  expect(r.machine.pending).toHaveLength(1);
  return r;
};

test('backgrounding the tab stops the reading with a plain hush, never a person-initiated cut', async () => {
  const r = await reading();
  await hidden(() => undefined);
  expect(r.controller.getState().status).toBe('stopped');
  expect(r.machine.cuts).toEqual([]);
  expect(r.machine.pending).toHaveLength(0);
});

test('a stop that carries no reason is automatic: no cut', async () => {
  const r = await reading();
  await interact(() => r.controller.stop());
  expect(r.controller.getState().status).toBe('stopped');
  expect(r.machine.cuts).toEqual([]);
});

test('the person stopping the reading is a cut', async () => {
  const r = await reading();
  await interact(() => r.controller.stop('person'));
  expect(r.controller.getState().status).toBe('stopped');
  expect(r.machine.cuts).toEqual(['person']);
});
