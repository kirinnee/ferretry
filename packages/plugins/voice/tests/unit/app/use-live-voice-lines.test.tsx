import { afterEach, describe, expect, test } from 'bun:test';
import type { ReactElement } from 'react';
import { type AutoReadInput, useAutoRead } from '../../../app/hooks/use-auto-read.ts';
import { useLiveVoiceLines } from '../../../app/hooks/use-live-voice-lines.ts';
import { LiveVoiceSettingsProvider } from '../../../app/hooks/use-live-voice-settings.ts';
import { ReadAloudProvider } from '../../../app/hooks/use-read-aloud.ts';
import { createLiveLines, type LiveLine, type LiveSink } from '../../../app/lib/voice-mode/live-lines.ts';
import type { SpeechLineEvent } from '../../../app/lib/stream/voice-stream.ts';
import { LiveVoiceSettingsStore } from '../../../app/lib/voice-chat/live-settings.ts';
import { createReadAloud, type ReadAloudController } from '../../../app/lib/voice-chat/read-aloud.ts';
import type { PickerRow } from '../../../app/lib/voice-chat/reply-picker.ts';
import { createSpeechSynthesisSpeaker } from '../../../app/lib/voice-chat/speech-synthesis.ts';
import { interact, type Mounted, mount } from '../../support/app/dom.ts';
import { FakeSynth, FakeUtterance, voice } from '../../support/app/fake-speech.ts';

/**
 * The page's half of V4, as `surfaces.tsx` joins it: the live lines of a streaming reply go to the machine's voice as the ferret
 * closes them, history is never said, and the reading at the end of the turn (Auto-read, forced on while voice mode is on) says
 * only what the machine's voice did not already take.
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
/** The ferret used a tool: whatever it said before was narration, not the end of the turn. */
const tool = (id = 't1'): PickerRow => ({ id, kind: 'tool', text: 'ran a command', at: AT + 6_000 });

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
  const live = createLiveLines({
    stream: () => ({
      speak: text => {
        const id = next;
        next += 1;
        spoken.push({ id, text });
        return [{ id, text }];
      },
      drop: ids => void dropped.push(...ids),
      interrupt: () => undefined,
    }),
    replyState: () => 'ready',
    player: { remainingMs: () => 0 },
    every: () => () => undefined,
  });
  return {
    sink: live as LiveSink,
    spoken,
    dropped,
    /** A line's sound as the stream reports it. */
    heard: (id: number, event: SpeechLineEvent['event'], code?: string) =>
      live.onSpeech(code === undefined ? { id, event } : { id, event, code }),
  };
}

function rig(options: { sink?: 'takes' | 'refuses' | 'none' | 'real' } = {}) {
  const synth = new FakeSynth([voice('Samantha', 'en-US', { isDefault: true })]);
  const speaker = createSpeechSynthesisSpeaker({ synth, createUtterance: text => new FakeUtterance(text) });
  const controller: ReadAloudController = createReadAloud({ speaker, language: () => 'en-US' });
  const settings = new LiveVoiceSettingsStore({ getItem: () => null, setItem: () => undefined });
  const said: LiveLine[] = [];
  const machine = realSink();
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

const settle = async (ms = 600): Promise<void> => {
  await interact(() => new Promise(resolve => setTimeout(resolve, ms)));
};

/** A turn the page sees from its start: working, lines closing one by one, then your-turn. */
const START: Page = { rows: [person('u0')], turn: 'your-turn', at: -1_000 };

describe('live voice lines on the page', () => {
  test('lines the ferret closes while it works are handed to the machine voice, first then progress then result; history is not', async () => {
    const r = rig();
    const history: Page = { ...START, rows: [person('u0'), { ...ferret('<voice>Old news.</voice>'), id: 'a0' }] };
    mounted = await mount(r.tree(history));
    const ask = person('u1');
    const working = (text: string): Page => ({ rows: [person('u0'), ask, ferret(text)], turn: 'working', at: 1_000 });
    await mounted.render(r.tree(working('<voice>On it.</voice>')));
    await mounted.render(r.tree(working('<voice>On it.</voice>\n\nRan it.\n\n<voice>Tests are running.</voice>')));
    // A line still being written is not said.
    await mounted.render(
      r.tree(working('<voice>On it.</voice>\n\n<voice>Tests are running.</voice>\n\n<voice>All gre')),
    );
    expect(r.said.map(({ id: _id, ...line }) => line)).toEqual([
      { text: 'On it.', kind: 'first' },
      { text: 'Tests are running.', kind: 'line' },
    ]);
    const done = '<voice>On it.</voice>\n\n<voice>Tests are running.</voice>\n\n<voice>All green.</voice>';
    await mounted.render(r.tree({ rows: [person('u0'), ask, ferret(done)], turn: 'your-turn', at: 10_000 }));
    expect(r.said.map(({ id: _id, ...line }) => line).at(-1)).toEqual({ text: 'All green.', kind: 'line' });
  });

  test('the reading at the end of the turn does not say what the machine voice already said', async () => {
    const r = rig();
    mounted = await mount(r.tree(START));
    const ask = person('u1');
    const text = '<voice>On it.</voice>\n\n<voice>All green.</voice>';
    await mounted.render(
      r.tree({ rows: [person('u0'), ask, ferret('<voice>On it.</voice>')], turn: 'working', at: 1_000 }),
    );
    await mounted.render(r.tree({ rows: [person('u0'), ask, ferret(text)], turn: 'working', at: 1_000 }));
    await mounted.render(r.tree({ rows: [person('u0'), ask, ferret(text)], turn: 'your-turn', at: 10_000 }));
    await settle();
    expect(r.said.map(line => line.text)).toEqual(['On it.', 'All green.']);
    expect(r.synth.spoken).toHaveLength(0);
  });

  // V4 never throws away the answer: only a line the ferret is KNOWN to have worked past is progress.
  describe('the machine voice, with its real queue', () => {
    const SPOKEN = (r: ReturnType<typeof rig>) => r.machine.spoken.map(line => line.text);

    test('the two lines of a result that closed while the turn still said "working" are both said', async () => {
      const r = rig({ sink: 'real' });
      mounted = await mount(r.tree(START));
      const ask = person('u1');
      await mounted.render(
        r.tree({ rows: [person('u0'), ask, ferret('<voice>On it.</voice>')], turn: 'working', at: 1_000 }),
      );
      // The result: two lines in ONE message, read before the turn's state flips to your-turn.
      const result = '<voice>On it.</voice>\n\n<voice>Tests passed.</voice>\n\n<voice>Nothing else to do.</voice>';
      await mounted.render(r.tree({ rows: [person('u0'), ask, ferret(result)], turn: 'working', at: 1_000 }));
      expect(SPOKEN(r)).toEqual(['On it.', 'Tests passed.', 'Nothing else to do.']);
      expect(r.machine.dropped).toEqual([]);
    });

    test('a single tagged result is not dropped when the next turn begins before it plays', async () => {
      const r = rig({ sink: 'real' });
      mounted = await mount(r.tree(START));
      const ask = person('u1');
      await mounted.render(
        r.tree({ rows: [person('u0'), ask, ferret('<voice>On it.</voice>')], turn: 'working', at: 1_000 }),
      );
      const result = ferret('<voice>On it.</voice>\n\n<voice>All green.</voice>');
      await mounted.render(r.tree({ rows: [person('u0'), ask, result], turn: 'working', at: 1_000 }));
      // Nothing has played yet; the person asks the next thing and the ferret answers it at once.
      const next = person('u2');
      await mounted.render(
        r.tree({
          rows: [person('u0'), ask, result, next, ferret('<voice>Next one.</voice>', 'a2')],
          turn: 'working',
          at: 20_000,
        }),
      );
      expect(SPOKEN(r)).toEqual(['On it.', 'All green.', 'Next one.']);
      expect(r.machine.dropped).toEqual([]);
    });

    test('narration the ferret worked past IS dropped when a newer line arrives and nobody has heard it', async () => {
      const r = rig({ sink: 'real' });
      mounted = await mount(r.tree(START));
      const ask = person('u1');
      const first = ferret('<voice>On it.</voice>');
      await mounted.render(r.tree({ rows: [person('u0'), ask, first], turn: 'working', at: 1_000 }));
      const stepA = ferret('<voice>Reading the logs.</voice>', 'a2');
      await mounted.render(r.tree({ rows: [person('u0'), ask, first, stepA], turn: 'working', at: 1_000 }));
      // Not known to be progress yet: the turn may end on it.
      expect(r.machine.dropped).toEqual([]);
      const rows = [person('u0'), ask, first, stepA, tool(), ferret('<voice>Found the cause.</voice>', 'a3')];
      await mounted.render(r.tree({ rows, turn: 'working', at: 1_000 }));
      expect(SPOKEN(r)).toEqual(['On it.', 'Reading the logs.', 'Found the cause.']);
      expect(r.machine.dropped).toEqual([1]);
    });

    test('a line the machine failed to make is still read at the end of the turn', async () => {
      const r = rig({ sink: 'real' });
      mounted = await mount(r.tree(START));
      const ask = person('u1');
      const text = '<voice>Build is green.</voice>';
      await mounted.render(r.tree({ rows: [person('u0'), ask, ferret(text)], turn: 'working', at: 1_000 }));
      r.machine.heard(0, 'failed', 'reply_voice_failed');
      await mounted.render(r.tree({ rows: [person('u0'), ask, ferret(text)], turn: 'your-turn', at: 10_000 }));
      await settle();
      expect(r.synth.spoken.map(each => each.text).join(' ')).toContain('Build is green');
    });

    test('a result that opens with the sentence a progress line said is not dropped with it: only the progress line is', async () => {
      const r = rig({ sink: 'real' });
      mounted = await mount(r.tree(START));
      const ask = person('u1');
      const first = ferret('<voice>I will check the release.</voice>');
      await mounted.render(r.tree({ rows: [person('u0'), ask, first], turn: 'working', at: 1_000 }));
      const progress = ferret('<voice>The build passed.</voice>', 'a2');
      await mounted.render(r.tree({ rows: [person('u0'), ask, first, progress], turn: 'working', at: 1_000 }));
      const result = ferret('<voice>The build passed.</voice>\n\n<voice>The release is ready.</voice>', 'a3');
      await mounted.render(
        r.tree({ rows: [person('u0'), ask, first, progress, tool(), result], turn: 'working', at: 1_000 }),
      );
      expect(SPOKEN(r)).toEqual([
        'I will check the release.',
        'The build passed.',
        'The build passed.',
        'The release is ready.',
      ]);
      // Line ids 0 and 1 are the first line and the progress line; the progress line is the one taken back.
      expect(r.machine.dropped).toEqual([1]);
    });

    test('a synthesis failure AFTER the reading decided still gets the one-line reply read', async () => {
      const r = rig({ sink: 'real' });
      mounted = await mount(r.tree(START));
      const ask = person('u1');
      const text = '<voice>The release is blocked by one failing check.</voice>';
      await mounted.render(r.tree({ rows: [person('u0'), ask, ferret(text)], turn: 'working', at: 1_000 }));
      // The turn ends while the machine is still making the line: the reading finds it being said and waits.
      await mounted.render(r.tree({ rows: [person('u0'), ask, ferret(text)], turn: 'your-turn', at: 10_000 }));
      await settle();
      expect(r.synth.spoken).toHaveLength(0);
      r.machine.heard(0, 'failed', 'reply_voice_failed');
      await settle();
      expect(r.synth.spoken.map(each => each.text).join(' ')).toContain('release is blocked');
    });

    test('a late failure after the person has sent something new says nothing', async () => {
      const r = rig({ sink: 'real' });
      mounted = await mount(r.tree(START));
      const ask = person('u1');
      const text = '<voice>Build is green.</voice>';
      await mounted.render(r.tree({ rows: [person('u0'), ask, ferret(text)], turn: 'working', at: 1_000 }));
      await mounted.render(r.tree({ rows: [person('u0'), ask, ferret(text)], turn: 'your-turn', at: 10_000 }));
      await settle();
      // The conversation moved on to a new turn: the failed line of the old one is no longer anyone's to say.
      await mounted.render(
        r.tree({ rows: [person('u0'), ask, ferret(text), person('u2')], turn: 'working', at: 20_000 }),
      );
      r.machine.heard(0, 'failed', 'reply_voice_failed');
      await settle();
      expect(r.synth.spoken).toHaveLength(0);
    });

    test('only the lines that did not play are read: the played one is not said twice', async () => {
      const r = rig({ sink: 'real' });
      mounted = await mount(r.tree(START));
      const ask = person('u1');
      const text = '<voice>On it.</voice>\n\n<voice>Build is green.</voice>';
      await mounted.render(r.tree({ rows: [person('u0'), ask, ferret(text)], turn: 'working', at: 1_000 }));
      r.machine.heard(0, 'started');
      r.machine.heard(0, 'finished');
      r.machine.heard(1, 'failed', 'reply_voice_failed');
      await mounted.render(r.tree({ rows: [person('u0'), ask, ferret(text)], turn: 'your-turn', at: 10_000 }));
      await settle();
      const heard = r.synth.spoken.map(each => each.text).join(' ');
      expect(heard).toContain('Build is green');
      expect(heard).not.toContain('On it');
    });

    test('a line still being said when the turn ends is not said again', async () => {
      const r = rig({ sink: 'real' });
      mounted = await mount(r.tree(START));
      const ask = person('u1');
      const text = '<voice>Build is green.</voice>';
      await mounted.render(r.tree({ rows: [person('u0'), ask, ferret(text)], turn: 'working', at: 1_000 }));
      r.machine.heard(0, 'started');
      await mounted.render(r.tree({ rows: [person('u0'), ask, ferret(text)], turn: 'your-turn', at: 10_000 }));
      await settle();
      expect(r.synth.spoken).toHaveLength(0);
    });
  });

  test('a voice that takes no line leaves the whole reply to the reading at the end, as before', async () => {
    const r = rig({ sink: 'refuses' });
    mounted = await mount(r.tree(START));
    const ask = person('u1');
    const text = '<voice>On it.</voice>\n\n<voice>All green.</voice>';
    await mounted.render(r.tree({ rows: [person('u0'), ask, ferret(text)], turn: 'working', at: 1_000 }));
    await mounted.render(r.tree({ rows: [person('u0'), ask, ferret(text)], turn: 'your-turn', at: 10_000 }));
    await settle();
    expect(r.said).toEqual([]);
    expect(r.synth.spoken.length).toBeGreaterThan(0);
  });

  test('voice mode off: nothing is handed over, and nothing is remembered for the next time', async () => {
    const r = rig();
    const ask = person('u1');
    const rows = [person('u0'), ask, ferret('<voice>On it.</voice>')];
    mounted = await mount(r.tree({ ...START, active: false }));
    await mounted.render(r.tree({ rows, turn: 'working', at: 1_000, active: false }));
    expect(r.said).toEqual([]);
    // Switched on with that line already in the conversation: it is history now, and is not said.
    await mounted.render(r.tree({ rows, turn: 'working', at: 1_000, active: true }));
    expect(r.said).toEqual([]);
    await mounted.render(
      r.tree({
        rows: [person('u0'), ask, ferret('<voice>On it.</voice>\n\n<voice>Next.</voice>')],
        turn: 'working',
        at: 1_000,
      }),
    );
    expect(r.said.map(({ id: _id, ...line }) => line)).toEqual([{ text: 'Next.', kind: 'first' }]);
  });
});
