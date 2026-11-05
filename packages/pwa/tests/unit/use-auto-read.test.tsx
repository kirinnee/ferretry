import { afterEach, describe, expect, test } from 'bun:test';
import type { ReactElement } from 'react';
import { AutoReadChip } from '../../src/components/auto-read-chip.tsx';
import { type AutoReadInput, useAutoRead } from '../../src/hooks/use-auto-read.ts';
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

const rig = (autoRead: boolean) => {
  const synth = new FakeSynth([voice('Samantha', 'en-US', { isDefault: true }), voice('Karen', 'en-AU')]);
  const speaker = createSpeechSynthesisSpeaker({ synth, createUtterance: text => new FakeUtterance(text) });
  const controller: ReadAloudController = createReadAloud({ speaker, language: () => 'en-US' });
  const store = new LiveVoiceSettingsStore(memory());
  if (autoRead) store.update({ autoRead: true });
  return { synth, controller, store };
};

function Probe({ input }: { readonly input: AutoReadInput }) {
  const handle = useAutoRead(input);
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
    mounted = await mount(tree(r, working()));
    await mounted.render(tree(r, ended([user, reply('First reply.')])));
    await settle();
    expect(r.controller.getState().status).toBe('reading');
    // The person sends: the page bumps its send signal and the reply under way is cut off.
    await mounted.render(tree(r, ended([user, reply('First reply.')], { sendSignal: 1 })));
    expect(r.controller.getState().status).toBe('stopped');
    // The daemon is still showing the old your-turn: nothing new is read from it.
    await settle();
    expect(said(r)).toBe('First reply.');
    expect(r.controller.getState().status).toBe('stopped');
    // The reply to the new message ends its own turn later than the send.
    const second: PickerRow = { id: 'a2', kind: 'assistant', text: 'Second reply.', at: Date.now() + 5000 };
    await mounted.render(
      tree(
        r,
        ended([user, reply('First reply.'), second], {
          sendSignal: 1,
          turnStateAt: new Date(Date.now() + 6000).toISOString(),
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
    mounted = await mount(tree(r, legacy([user], 'working')));
    await mounted.render(tree(r, legacy([user, reply('Legacy reply.')], 'your-turn')));
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
});
