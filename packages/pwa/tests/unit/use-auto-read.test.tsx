import { afterEach, describe, expect, test } from 'bun:test';
import type { ReactElement } from 'react';
import { AutoReadChip } from '../../src/components/auto-read-chip.tsx';
import { type AutoReadHandle, type AutoReadInput, useAutoRead } from '../../src/hooks/use-auto-read.ts';
import { LiveVoiceSettingsProvider } from '../../src/hooks/use-live-voice-settings.ts';
import { ReadAloudProvider } from '../../src/hooks/use-read-aloud.ts';
import { LiveVoiceSettingsStore } from '../../src/lib/voice-chat/live-settings.ts';
import { createReadAloud, type ReadAloudController } from '../../src/lib/voice-chat/read-aloud.ts';
import type { PickerRow } from '../../src/lib/voice-chat/reply-picker.ts';
import { createSpeechSynthesisSpeaker } from '../../src/lib/voice-chat/speech-synthesis.ts';
import { interact, type Mounted, mount } from '../support/dom.ts';
import { FakeSynth, FakeUtterance, voice } from '../support/fake-speech.ts';

/**
 * Auto-read replies, end to end over a fake voice: off by default, reads the last message of a turn it
 * SAW end (after the 500 ms text-settled guard), a question is read not answered, a tap or key or a new
 * send stops it, a hidden tab is silent — and it never speaks at all unless the device switched it on.
 */

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  setVisibility('visible');
});

const setVisibility = (state: 'visible' | 'hidden'): void => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
};

const memory = (): { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void } => {
  const data = new Map<string, string>();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) };
};

const AT = Date.UTC(2026, 10, 5, 3, 0, 0);
const user: PickerRow = { id: 'u1', kind: 'user', text: 'fix it', at: AT };
const reply = (text: string, id = 'a1'): PickerRow => ({ id, kind: 'assistant', text, at: AT + 9000 });

const BASE: AutoReadInput = {
  scope: 'd/s',
  entries: [user],
  turn: 'your-turn',
  turnStateAt: new Date(AT - 1000).toISOString(),
  legacy: false,
  question: null,
  sendSignal: 0,
};
const working = (): AutoReadInput => ({ ...BASE, turn: 'working', turnStateAt: new Date(AT + 1000).toISOString() });
const ended = (rows: readonly PickerRow[], extra: Partial<AutoReadInput> = {}): AutoReadInput => ({
  ...BASE,
  entries: rows,
  turn: 'your-turn',
  turnStateAt: new Date(AT + 10_000).toISOString(),
  ...extra,
});

/**
 * A clock that reads `base` now and then runs at the speed of the process's own: rows and turn states in these
 * fixtures are dated near `AT`, so the hook's "now" must be too, whatever the process's real date is.
 */
const clockFrom = (base: number): (() => number) => {
  const started = Date.now();
  return () => base + (Date.now() - started);
};

const rig = (autoRead: boolean) => {
  const synth = new FakeSynth([voice('Samantha', 'en-US', { isDefault: true }), voice('Karen', 'en-AU')]);
  const speaker = createSpeechSynthesisSpeaker({ synth, createUtterance: text => new FakeUtterance(text) });
  const controller: ReadAloudController = createReadAloud({ speaker, language: () => 'en-US' });
  const store = new LiveVoiceSettingsStore(memory());
  if (autoRead) store.update({ autoRead: true });
  return { synth, controller, store };
};

let handle: AutoReadHandle | null = null;
function Probe({ input }: { readonly input: AutoReadInput }) {
  handle = useAutoRead(input);
  return <AutoReadChip onStop={handle.stop} reading={handle.reading} />;
}

const tree = (r: ReturnType<typeof rig>, input: AutoReadInput): ReactElement => (
  <LiveVoiceSettingsProvider store={r.store}>
    <ReadAloudProvider controller={r.controller}>
      <Probe input={input} />
    </ReadAloudProvider>
  </LiveVoiceSettingsProvider>
);

const settle = async (ms = 560): Promise<void> => {
  await interact(() => new Promise(resolve => setTimeout(resolve, ms)));
};
/** What the controller is (or last was) saying, a caption at a time: the fake voice only plays what the test lets it. */
const said = (r: { readonly controller: ReadAloudController }): string => r.controller.getState().segments.join(' ');

describe('useAutoRead', () => {
  test('OFF by default: a turn ends and nothing is said', async () => {
    const r = rig(false);
    mounted = await mount(tree(r, working()));
    await mounted.render(tree(r, ended([user, reply('All done.')])));
    await settle();
    expect(r.synth.spoken).toHaveLength(0);
  });

  test('ON: reads only the last message of the turn once the text has settled, with the chosen voice and rate', async () => {
    const r = rig(true);
    r.store.update({ voiceId: 'uri:Karen', rate: 1.5 });
    mounted = await mount(tree(r, working()));
    await mounted.render(
      tree(r, ended([user, { ...reply('Let me look.', 'a0'), at: AT + 2000 }, reply('The fix is in.')])),
    );
    // Not at once: the text-settled guard waits for 500 ms of quiet.
    expect(r.synth.spoken).toHaveLength(0);
    await settle();
    expect(said(r)).toBe('The fix is in.');
    expect(r.synth.spoken[0]?.rate).toBe(1.5);
    expect((r.synth.spoken[0]?.voice as { name: string } | null)?.name).toBe('Karen');
    expect(r.controller.getState().key).toBe('a1');
  });

  test('a turn with no text says "Done. No message."', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, working()));
    await mounted.render(tree(r, ended([user, { id: 't1', kind: 'tool', text: 'ran', at: AT + 3000 }])));
    await settle();
    expect(said(r)).toBe('Done. No message.');
  });

  test('needs-input reads the question and its options, and offers no way to answer by voice', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, working()));
    await mounted.render(
      tree(
        r,
        ended([user], {
          turn: 'needs-input',
          question: { questions: [{ question: 'Which one?', options: [{ label: 'Alpha' }, { label: 'Beta' }] }] },
        }),
      ),
    );
    await settle();
    expect(said(r)).toBe('The ferret asks. Which one? Options: one, Alpha; two, Beta.');
    expect(mounted.container.querySelector('input,textarea,[contenteditable]')).toBeNull();
  });

  test('a session already at your-turn when it is switched on reads nothing', async () => {
    const r = rig(false);
    mounted = await mount(tree(r, ended([user, reply('Old reply.')])));
    await interact(() => r.store.update({ autoRead: true }));
    await settle();
    expect(r.synth.spoken).toHaveLength(0);
  });

  test('the "Reading the reply" chip appears with a Stop that works, and the live region never says the reply', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, working()));
    await mounted.render(tree(r, ended([user, reply('Secret words.')])));
    await settle();
    const chip = mounted.container.querySelector('[data-auto-read]');
    expect(chip?.textContent).toContain('Reading the reply');
    expect(chip?.textContent).toContain('Tap anywhere or press a key to stop.');
    expect(mounted.container.querySelector('[role="status"]')?.textContent).toBe('Reading the reply');
    expect(mounted.container.textContent).not.toContain('Secret words');
    const stop = chip?.querySelector('button') as HTMLButtonElement;
    expect(stop.textContent).toBe('Stop');
    await interact(() => stop.click());
    expect(r.controller.getState().status).toBe('stopped');
    expect(mounted.container.querySelector('[data-auto-read]')).toBeNull();
  });

  test('a tap anywhere stops it; so does a key', async () => {
    for (const fire of [
      () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })),
      () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })),
    ]) {
      const r = rig(true);
      mounted = await mount(tree(r, working()));
      await mounted.render(tree(r, ended([user, reply('Reply.')])));
      await settle();
      expect(r.controller.getState().status).toBe('reading');
      await interact(fire);
      expect(r.controller.getState().status).toBe('stopped');
      await mounted.unmount();
    }
  });

  test('a tap does NOT stop a reading the person started by hand', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, BASE));
    await interact(() => r.controller.read('manual', 'Read me.'));
    await interact(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(r.controller.getState().status).toBe('reading');
  });

  test('a new send stops the reading and the next end of turn is its reply', async () => {
    const r = rig(true);
    // The fixtures' dates are near AT, so the hook's clock is too.
    const now = clockFrom(AT + 12_000);
    const treeAt = (input: AutoReadInput): ReactElement => tree(r, { ...input, now });
    mounted = await mount(treeAt(working()));
    await mounted.render(treeAt(ended([user, reply('First reply.')])));
    await settle();
    expect(r.controller.getState().status).toBe('reading');
    // The person sends: the page bumps its send signal and the reply under way is cut off.
    await mounted.render(treeAt(ended([user, reply('First reply.')], { sendSignal: 1 })));
    expect(r.controller.getState().status).toBe('stopped');
    // The daemon is still showing the old your-turn: nothing new is read from it.
    await settle();
    expect(said(r)).toBe('First reply.');
    expect(r.controller.getState().status).toBe('stopped');
    // The reply to the new message ends its own turn later than the send.
    const second: PickerRow = { id: 'a2', kind: 'assistant', text: 'Second reply.', at: AT + 15_000 };
    await mounted.render(
      tree(
        r,
        ended([user, reply('First reply.'), second], {
          sendSignal: 1,
          turnStateAt: new Date(AT + 20_000).toISOString(),
        }),
      ),
    );
    await settle();
    expect(said(r)).toBe('Second reply.');
    expect(r.controller.getState()).toMatchObject({ status: 'reading', key: 'a2' });
  });

  test('switching it off silences a reading', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, working()));
    await mounted.render(tree(r, ended([user, reply('Reply.')])));
    await settle();
    expect(r.controller.getState().status).toBe('reading');
    await interact(() => r.store.update({ autoRead: false }));
    expect(r.controller.getState().status).toBe('stopped');
  });

  test('a hidden tab stops speech, and a turn that ends while hidden is not read on return', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, working()));
    await mounted.render(tree(r, ended([user, reply('Reply.')])));
    await settle();
    expect(r.controller.getState().status).toBe('reading');
    await interact(() => setVisibility('hidden'));
    expect(r.controller.getState().status).toBe('stopped');

    const hiddenRig = rig(true);
    await mounted.unmount();
    mounted = await mount(tree(hiddenRig, working()));
    await mounted.render(tree(hiddenRig, ended([user, reply('Missed reply.')])));
    await settle();
    await interact(() => setVisibility('visible'));
    await settle();
    expect(hiddenRig.synth.spoken).toHaveLength(0);
  });

  test('an old daemon (no turnState): reads about 3 seconds after the last record, not before', async () => {
    const r = rig(true);
    const legacy = (rows: readonly PickerRow[], turn: 'working' | 'your-turn'): AutoReadInput => ({
      ...BASE,
      entries: rows,
      turn,
      turnStateAt: undefined,
      legacy: true,
    });
    // The page opens on a quiet conversation; the turn is proved by a record that comes in AFTER it opened.
    const fresh: PickerRow = { ...reply('Legacy reply.'), at: Date.now() + 1000 };
    mounted = await mount(tree(r, legacy([user], 'working')));
    await mounted.render(tree(r, legacy([user, fresh], 'working')));
    await mounted.render(tree(r, legacy([user, fresh], 'your-turn')));
    await settle(1200);
    expect(r.synth.spoken).toHaveLength(0);
    await settle(2200);
    expect(said(r)).toBe('Legacy reply.');
  });

  test('another conversation starts clean: a turn seen in the first is not read in the second', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, working()));
    await mounted.render(tree(r, { ...ended([user, reply('Other conversation.')]), scope: 'd/other' }));
    await settle();
    expect(r.synth.spoken).toHaveLength(0);
  });

  test('no speech on the device: the hook does nothing and the chip is empty', async () => {
    const synth = new FakeSynth([]);
    const unsupported = createReadAloud({
      speaker: {
        ...createSpeechSynthesisSpeaker({ synth, createUtterance: t => new FakeUtterance(t) }),
        supported: false,
      },
    });
    const store = new LiveVoiceSettingsStore(memory());
    store.update({ autoRead: true });
    const r = { synth, controller: unsupported, store };
    mounted = await mount(tree(r, working()));
    await mounted.render(tree(r, ended([user, reply('Reply.')])));
    await settle();
    expect(synth.spoken).toHaveLength(0);
  });

  test('REGRESSION (round 1, #3): a fast turn that ends before the send is acknowledged is still read', async () => {
    const r = rig(true);
    // The page already shows the previous turn's your-turn.
    const before = ended([user, reply('Old reply.')], { turnStateAt: new Date(AT - 5000).toISOString() });
    mounted = await mount(tree(r, before));
    // The press: armed at its initiation, before the request is awaited.
    await interact(() => handle?.beginSend());
    // The whole turn happens before the request comes back and the page bumps its send signal.
    const second: PickerRow = { id: 'a2', kind: 'assistant', text: 'Quick answer.', at: AT + 3000 };
    await mounted.render(
      tree(
        r,
        ended([user, reply('Old reply.'), { id: 'u2', kind: 'user', text: 'again', at: AT + 1000 }, second], {
          turnStateAt: new Date(AT + 4000).toISOString(),
        }),
      ),
    );
    await settle();
    expect(said(r)).toBe('Quick answer.');
    // The acknowledgement arrives afterwards and changes nothing.
    await mounted.render(
      tree(
        r,
        ended([user, reply('Old reply.'), { id: 'u2', kind: 'user', text: 'again', at: AT + 1000 }, second], {
          turnStateAt: new Date(AT + 4000).toISOString(),
          sendSignal: 1,
        }),
      ),
    );
    await settle();
    expect(r.synth.spoken).toHaveLength(1);
  });

  test('REGRESSION (round 1, #2): a newer send drops the reading that was waiting on the older turn', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, working()));
    // working → your-turn, with the text still arriving (the settle timer is pending)…
    await mounted.render(tree(r, ended([user, reply('Older reply.')])));
    // …and the person sends again before it fires.
    await interact(() => handle?.beginSend());
    await settle();
    expect(r.synth.spoken).toHaveLength(0);
  });

  test('REGRESSION (round 1, #5): a replay of a turn that was already read is not read again', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, working()));
    await mounted.render(tree(r, ended([user, reply('Read once.')])));
    await settle();
    expect(r.synth.spoken).toHaveLength(1);
    await interact(() => handle?.stop());
    // A reconnect replays the same working → your-turn pair.
    await mounted.render(tree(r, { ...working(), entries: [user, reply('Read once.')] }));
    await mounted.render(tree(r, ended([user, reply('Read once.')])));
    await settle();
    expect(r.synth.spoken).toHaveLength(1);
  });

  test('REGRESSION (round 1, #6): the turn ends while the tab is hidden; coming back before the timer reads nothing', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, working()));
    await interact(() => setVisibility('hidden'));
    await mounted.render(tree(r, ended([user, reply('Missed.')])));
    await interact(() => setVisibility('visible'));
    await settle();
    expect(r.synth.spoken).toHaveLength(0);
  });

  test('REGRESSION (round 1, #6): hiding the tab cancels a reading that was waiting out its settle time', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, working()));
    await mounted.render(tree(r, ended([user, reply('Pending.')])));
    await interact(() => setVisibility('hidden'));
    await interact(() => setVisibility('visible'));
    await settle();
    expect(r.synth.spoken).toHaveLength(0);
  });

  test('REGRESSION (round 1, #1): an idle old daemon read as working then idle on page load reads nothing', async () => {
    const r = rig(true);
    // Older than the page, on whatever clock this process runs.
    const before = Date.now();
    const legacy = (turn: 'working' | 'your-turn'): AutoReadInput => ({
      ...BASE,
      entries: [
        { ...user, at: before - 600_000 },
        { ...reply('Historic reply.'), at: before - 590_000 },
      ],
      turn,
      turnStateAt: undefined,
      legacy: true,
    });
    mounted = await mount(tree(r, legacy('working')));
    await mounted.render(tree(r, legacy('your-turn')));
    await settle(3600);
    expect(r.synth.spoken).toHaveLength(0);
  });

  test('a send the composer did not announce (a form answer) still arms, from the acknowledgement', async () => {
    const r = rig(true);
    // The fixtures' dates are near AT, so the hook's clock is too.
    const now = clockFrom(AT + 12_000);
    const treeAt = (input: AutoReadInput): ReactElement => tree(r, { ...input, now });
    mounted = await mount(treeAt(ended([user, reply('First reply.')])));
    await mounted.render(treeAt(ended([user, reply('First reply.')], { sendSignal: 1 })));
    const second: PickerRow = { id: 'a2', kind: 'assistant', text: 'Answer reply.', at: AT + 15_000 };
    await mounted.render(
      tree(
        r,
        ended([user, reply('First reply.'), second], {
          sendSignal: 1,
          turnStateAt: new Date(AT + 20_000).toISOString(),
        }),
      ),
    );
    await settle();
    expect(said(r)).toBe('Answer reply.');
  });

  test('a send while Auto-read is off, or on a device with no speech, arms nothing', async () => {
    const off = rig(false);
    mounted = await mount(tree(off, ended([user, reply('Reply.')])));
    await interact(() => handle?.beginSend());
    await mounted.render(tree(off, ended([user, reply('Reply.')], { sendSignal: 1 })));
    await settle();
    expect(off.synth.spoken).toHaveLength(0);
  });
});
