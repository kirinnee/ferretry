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
 * A line the machine voice failed to make is read by the end-of-turn reading instead. When a SECOND line then fails before the
 * first one's fallback has played, the fallback keeps both: the later failure adds to the reading, it never replaces it.
 */

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});
const AT = Date.UTC(2026, 10, 26, 3, 0, 0);
const iso = (ms: number): string => new Date(AT + ms).toISOString();
const person = (id: string): PickerRow => ({ id, kind: 'user', text: '(voice) check the build', at: AT });
const ferret = (text: string, id = 'a1'): PickerRow => ({ id, kind: 'assistant', text, at: AT + 5_000 });

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
      interrupt: () => void pending.splice(0),
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
            quiet: () => undefined,
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

const settle = async (ms = 600): Promise<void> => {
  await interact(() => new Promise(resolve => setTimeout(resolve, ms)));
};

/** A turn the page sees from its start: working, lines closing one by one, then your-turn. */
const START: Page = { rows: [person('u0')], turn: 'your-turn', at: -1_000 };
test('a first-line failure after the 500 ms reply decision still gets read', async () => {
  const r = rig({ sink: 'real' });
  mounted = await mount(r.tree(START));
  const ask = person('u1');
  const result = ferret('<voice>Do not deploy. The release check failed.</voice>');
  await mounted.render(r.tree({ rows: [person('u0'), ask, result], turn: 'working', at: 1_000 }));
  await mounted.render(r.tree({ rows: [person('u0'), ask, result], turn: 'your-turn', at: 10_000 }));
  await settle();
  expect(r.synth.spoken).toHaveLength(0);

  await interact(() => r.machine.heard(0, 'failed', 'reply_voice_failed'));
  await settle();
  expect(r.synth.spoken.map(each => each.text).join(' ')).toContain('Do not deploy');
});

test('sequential failures keep every result line available until it is read', async () => {
  const r = rig({ sink: 'real' });
  mounted = await mount(r.tree(START));
  const ask = person('u1');
  const result = ferret('<voice>Do not deploy.</voice>\n\n<voice>The database check failed.</voice>');
  await mounted.render(r.tree({ rows: [person('u0'), ask, result], turn: 'working', at: 1_000 }));
  await interact(() => r.machine.heard(0, 'failed', 'reply_voice_failed'));
  await mounted.render(r.tree({ rows: [person('u0'), ask, result], turn: 'your-turn', at: 10_000 }));
  await settle();
  expect(r.synth.queue.map(each => each.text)).toEqual(['Do not deploy.']);

  await interact(() => r.machine.heard(1, 'failed', 'reply_voice_failed'));
  await settle();
  expect(r.synth.queue.map(each => each.text).join(' ')).toContain('Do not deploy');
  // The browser voice says one piece at a time: once the first line is said, the second follows it.
  await interact(() => r.synth.play());
  expect(r.synth.queue.map(each => each.text).join(' ')).toContain('database check failed');
});

test('sequential live failures do not hush the first machine fallback', async () => {
  const r = rig({ sink: 'real', attachMachine: true });
  mounted = await mount(r.tree(START));
  const ask = person('u1');
  const result = ferret('<voice>Do not deploy.</voice>\n\n<voice>The database check failed.</voice>');
  await mounted.render(r.tree({ rows: [person('u0'), ask, result], turn: 'working', at: 1_000 }));
  await interact(() => r.machine.heard(0, 'failed', 'reply_voice_failed'));
  await mounted.render(r.tree({ rows: [person('u0'), ask, result], turn: 'your-turn', at: 10_000 }));
  await settle();
  expect(r.machine.pending).toEqual([1, 2]);
  expect(r.machine.spoken.at(-1)?.text).toBe('Do not deploy.');

  await interact(() => r.machine.heard(1, 'failed', 'reply_voice_failed'));
  await settle();
  const queued = r.machine.spoken.filter(line => r.machine.pending.includes(line.id));
  expect(queued.map(line => line.text).join(' ')).toContain('Do not deploy');
  expect(r.machine.spoken.at(-1)?.text).toBe('The database check failed.');
});
