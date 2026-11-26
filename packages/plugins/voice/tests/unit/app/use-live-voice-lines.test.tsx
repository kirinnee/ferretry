import { afterEach, describe, expect, test } from 'bun:test';
import type { ReactElement } from 'react';
import { type AutoReadInput, useAutoRead } from '../../../app/hooks/use-auto-read.ts';
import { useLiveVoiceLines } from '../../../app/hooks/use-live-voice-lines.ts';
import { LiveVoiceSettingsProvider } from '../../../app/hooks/use-live-voice-settings.ts';
import { ReadAloudProvider } from '../../../app/hooks/use-read-aloud.ts';
import type { LiveLine, LiveSink } from '../../../app/lib/voice-mode/live-lines.ts';
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
const ferret = (text: string): PickerRow => ({ id: 'a1', kind: 'assistant', text, at: AT + 5_000 });

interface Page {
  readonly rows: readonly PickerRow[];
  readonly turn: 'working' | 'your-turn';
  readonly at: number;
  readonly active?: boolean;
}

function rig(options: { sink?: 'takes' | 'refuses' | 'none' } = {}) {
  const synth = new FakeSynth([voice('Samantha', 'en-US', { isDefault: true })]);
  const speaker = createSpeechSynthesisSpeaker({ synth, createUtterance: text => new FakeUtterance(text) });
  const controller: ReadAloudController = createReadAloud({ speaker, language: () => 'en-US' });
  const settings = new LiveVoiceSettingsStore({ getItem: () => null, setItem: () => undefined });
  const said: LiveLine[] = [];
  const sink: LiveSink | undefined =
    options.sink === 'none'
      ? undefined
      : {
          say: line => {
            if (options.sink === 'refuses') return false;
            said.push(line);
            return true;
          },
        };
  function Probe({ page }: { readonly page: Page }) {
    const lines = useLiveVoiceLines({
      active: page.active ?? true,
      rows: page.rows,
      live: true,
      working: page.turn === 'working',
      visible: true,
      sink: () => sink,
    });
    useAutoRead({
      scope: 'd/s',
      entries: page.rows,
      authoritative: true,
      forced: page.active ?? true,
      covers: lines.covers,
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
  return { synth, said, tree, controller };
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
    expect(r.said).toEqual([
      { text: 'On it.', kind: 'first' },
      { text: 'Tests are running.', kind: 'progress' },
    ]);
    const done = '<voice>On it.</voice>\n\n<voice>Tests are running.</voice>\n\n<voice>All green.</voice>';
    await mounted.render(r.tree({ rows: [person('u0'), ask, ferret(done)], turn: 'your-turn', at: 10_000 }));
    expect(r.said.at(-1)).toEqual({ text: 'All green.', kind: 'result' });
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
    expect(r.said).toEqual([{ text: 'Next.', kind: 'first' }]);
  });
});
