import { afterEach, describe, expect, test } from 'bun:test';
import type { ReactElement } from 'react';
import { AutoReadChip } from '../../../app/components/auto-read-chip.tsx';
import {
  type AutoReadHandle,
  type AutoReadInput,
  type SendAcceptance,
  useAutoRead,
} from '../../../app/hooks/use-auto-read.ts';
import { LiveVoiceSettingsProvider } from '../../../app/hooks/use-live-voice-settings.ts';
import { ReadAloudProvider } from '../../../app/hooks/use-read-aloud.ts';
import { LiveVoiceSettingsStore } from '../../../app/lib/voice-chat/live-settings.ts';
import { createReadAloud, type ReadAloudController } from '../../../app/lib/voice-chat/read-aloud.ts';
import type { PickerRow } from '../../../app/lib/voice-chat/reply-picker.ts';
import { createSpeechSynthesisSpeaker } from '../../../app/lib/voice-chat/speech-synthesis.ts';
import { interact, type Mounted, mount } from '../../support/app/dom.ts';
import { FakeSynth, FakeUtterance, voice } from '../../support/app/fake-speech.ts';

/**
 * Auto-read replies, end to end over a fake voice: off by default, reads the last message of a turn it
 * SAW end (after the 500 ms text-settled guard), a question is read not answered, a tap or key or a new
 * send stops it, a hidden tab is silent — and it never speaks at all unless the device switched it on.
 * Every date is the daemon's: there is no browser-clock comparison anywhere to fake.
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
const iso = (ms: number): string => new Date(AT + ms).toISOString();
/** The daemon's ledger entry for a send: when the DAEMON accepted it. */
const accepted = (sendId: string, ms: number, message = 'and this'): SendAcceptance => ({
  sendId,
  acceptedAt: iso(ms),
  message,
});
const user: PickerRow = { id: 'u1', kind: 'user', text: 'fix it', at: AT };
const reply = (text: string, id = 'a1'): PickerRow => ({ id, kind: 'assistant', text, at: AT + 9000 });
const asked = (id: string, ms: number): PickerRow => ({ id, kind: 'user', text: 'and this', at: AT + ms });

const BASE: AutoReadInput = {
  scope: 'd/s',
  entries: [user],
  turn: 'your-turn',
  turnStateAt: iso(-1000),
  question: null,
  sends: [],
  authoritative: true,
};
const working = (extra: Partial<AutoReadInput> = {}): AutoReadInput => ({
  ...BASE,
  turn: 'working',
  turnStateAt: iso(1000),
  ...extra,
});
const ended = (rows: readonly PickerRow[], extra: Partial<AutoReadInput> = {}): AutoReadInput => ({
  ...BASE,
  entries: rows,
  turn: 'your-turn',
  turnStateAt: iso(10_000),
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

const OLD = reply('Previous reply.', 'a0');
const press = async (id: string | undefined = 's1'): Promise<void> => {
  await interact(() => handle?.beginSend());
  await interact(() => handle?.sent(id));
};

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
    await press();
    expect(synth.spoken).toHaveLength(0);
  });

  test('REGRESSION (round 1, #2): hiding the tab cancels a reading that was waiting out its settle time', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, working()));
    await mounted.render(tree(r, ended([user, reply('Pending.')])));
    await interact(() => setVisibility('hidden'));
    await interact(() => setVisibility('visible'));
    await settle();
    expect(r.synth.spoken).toHaveLength(0);
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
});

describe('useAutoRead: a daemon that dates no turns is never auto-read', () => {
  /** What the page hands the hook for an old daemon: no `turnState`, so no turn and no date. */
  const old = (rows: readonly PickerRow[]): AutoReadInput => ({
    ...BASE,
    entries: rows,
    turn: null,
    turnStateAt: undefined,
  });

  test('nothing is read when the conversation grows and goes quiet, however long', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, old([user])));
    await mounted.render(tree(r, old([user, reply('Live-looking reply.')])));
    await settle(3600);
    expect(r.synth.spoken).toHaveLength(0);
  });

  test('a turn state without a date is not enough either', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, { ...working(), turnStateAt: undefined }));
    await mounted.render(tree(r, { ...ended([user, reply('Reply.')]), turnStateAt: undefined }));
    await settle(3600);
    expect(r.synth.spoken).toHaveLength(0);
    await mounted.render(tree(r, { ...ended([user, reply('Reply.')]), turnStateAt: 'not a date' }));
    await settle();
    expect(r.synth.spoken).toHaveLength(0);
  });

  test('pressing send arms nothing, and the send’s id does not either', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, old([user, OLD])));
    await press('s1');
    await mounted.render(
      tree(r, { ...old([user, OLD, asked('u2', 30_000), reply('New reply.', 'a2')]), sends: [accepted('s1', 30_000)] }),
    );
    await settle(3600);
    expect(r.synth.spoken).toHaveLength(0);
  });
});

describe('useAutoRead: a send is judged against the daemon’s acceptance of it', () => {
  /** An idle session at your-turn@-1000 with an old reply, as the page opens. */
  const idle = (extra: Partial<AutoReadInput> = {}): AutoReadInput => ({ ...BASE, entries: [user, OLD], ...extra });
  const BOUNDARY = 30_000;

  test('the send’s own turn is read once the ledger has shown when the daemon accepted it', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, idle()));
    await press('s1');
    const sends = [accepted('s1', BOUNDARY)];
    const rows = [user, OLD, asked('u2', 30_100)];
    await mounted.render(tree(r, idle({ entries: rows, turn: 'working', turnStateAt: iso(30_500), sends })));
    await mounted.render(
      tree(r, idle({ entries: [...rows, reply('New reply.', 'a2')], turnStateAt: iso(40_000), sends })),
    );
    // The press and the request read nothing by themselves.
    expect(r.synth.spoken).toHaveLength(0);
    await settle();
    expect(said(r)).toBe('New reply.');
    expect(r.controller.getState()).toMatchObject({ status: 'reading', key: 'a2' });
  });

  test('a fast turn that ends before the ledger shows the send is read when it does', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, idle()));
    await interact(() => handle?.beginSend());
    const rows = [user, OLD, asked('u2', 30_100), reply('Quick answer.', 'a2')];
    await mounted.render(tree(r, idle({ entries: rows.slice(0, 3), turn: 'working', turnStateAt: iso(30_500) })));
    await mounted.render(tree(r, idle({ entries: rows, turnStateAt: iso(31_000) })));
    await interact(() => handle?.sent('s1'));
    await settle();
    // The daemon has not told the page when it accepted the send yet: nothing is read.
    expect(r.synth.spoken).toHaveLength(0);
    await mounted.render(tree(r, idle({ entries: rows, turnStateAt: iso(31_000), sends: [accepted('s1', BOUNDARY)] })));
    await settle();
    expect(said(r)).toBe('Quick answer.');
    expect(r.synth.spoken).toHaveLength(1);
  });

  test('REGRESSION (round 3, #1): a delayed prior completion@10000 with the send accepted at 30000 is not read', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, idle({ turnStateAt: iso(1000) })));
    await press('s1');
    const sends = [accepted('s1', BOUNDARY)];
    // The new user row appears in the same render as the old turn's completion arriving late.
    await mounted.render(tree(r, idle({ entries: [user, OLD, asked('u2', 30_100)], turnStateAt: iso(10_000), sends })));
    await settle();
    expect(r.synth.spoken).toHaveLength(0);
    // …and it did not consume the token: the real reply is still read.
    await mounted.render(
      tree(r, idle({ entries: [user, OLD, asked('u2', 30_100)], turn: 'working', turnStateAt: iso(30_500), sends })),
    );
    await mounted.render(
      tree(
        r,
        idle({
          entries: [user, OLD, asked('u2', 30_100), reply('Real reply.', 'a2')],
          turnStateAt: iso(40_000),
          sends,
        }),
      ),
    );
    await settle();
    expect(said(r)).toBe('Real reply.');
  });

  test('REGRESSION (round 3, #1): replaying the previous working@2000 does not prove the new turn', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, idle({ turnStateAt: iso(1000) })));
    await press('s1');
    const sends = [accepted('s1', BOUNDARY)];
    await mounted.render(tree(r, idle({ turn: 'working', turnStateAt: iso(2000), sends })));
    await mounted.render(tree(r, idle({ turnStateAt: iso(10_000), sends })));
    await settle();
    expect(r.synth.spoken).toHaveLength(0);
  });

  test('without the ledger’s word on the send nothing is read, whatever else is seen', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, idle()));
    await press('s1');
    const rows = [user, OLD, asked('u2', 30_100), reply('Reply.', 'a2')];
    await mounted.render(tree(r, idle({ entries: rows.slice(0, 3), turn: 'working', turnStateAt: iso(30_500) })));
    await mounted.render(tree(r, idle({ entries: rows, turnStateAt: iso(40_000) })));
    // A ledger entry for some other send, or one whose date cannot be read, proves nothing either.
    await mounted.render(
      tree(
        r,
        idle({
          entries: rows,
          turnStateAt: iso(40_000),
          sends: [accepted('other', 30_000), { sendId: 's1', acceptedAt: 'x' }],
        }),
      ),
    );
    await settle();
    expect(r.synth.spoken).toHaveLength(0);
  });

  test('a reading under way is cut off by a new send, and the next end of turn is the new send’s reply', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, working()));
    await mounted.render(tree(r, ended([user, reply('First reply.')])));
    await settle();
    expect(r.controller.getState().status).toBe('reading');
    await interact(() => handle?.beginSend());
    expect(r.controller.getState().status).toBe('stopped');
    await interact(() => handle?.sent('s2'));
    // The daemon is still showing the old your-turn: nothing new is read from it.
    await settle();
    expect(said(r)).toBe('First reply.');
    expect(r.synth.spoken).toHaveLength(1);
    const sends = [accepted('s2', 13_000)];
    const rows = [user, reply('First reply.'), asked('u2', 13_100)];
    await mounted.render(tree(r, ended(rows, { turn: 'working', turnStateAt: iso(14_000), sends })));
    await mounted.render(
      tree(
        r,
        ended([...rows, { id: 'a2', kind: 'assistant', text: 'Second reply.', at: AT + 15_000 }], {
          turnStateAt: iso(20_000),
          sends,
        }),
      ),
    );
    await settle();
    expect(said(r)).toBe('Second reply.');
    expect(r.controller.getState()).toMatchObject({ status: 'reading', key: 'a2' });
  });

  test('a newer send drops the reading that was waiting on the older turn', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, working()));
    // working → your-turn, with the text still arriving (the settle timer is pending)…
    await mounted.render(tree(r, ended([user, reply('Older reply.')])));
    // …and the person sends again before it fires.
    await interact(() => handle?.beginSend());
    await settle();
    expect(r.synth.spoken).toHaveLength(0);
  });

  test('the acknowledgement of a press stops nothing and binds the id; a failed request drops the press', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, idle()));
    await interact(() => handle?.beginSend());
    await interact(() => r.controller.read('theirs', 'Read me.'));
    // The press was announced: its acknowledgement does not cut a reading off.
    await interact(() => handle?.sent('s1'));
    expect(r.controller.getState().status).toBe('reading');

    // A press whose request failed lets go: the next live turn is watched as any other.
    await interact(() => handle?.beginSend());
    await interact(() => handle?.failed());
    await mounted.render(tree(r, idle({ turn: 'working', turnStateAt: iso(5000) })));
    await mounted.render(tree(r, idle({ entries: [user, OLD, reply('Next reply.', 'a2')], turnStateAt: iso(9000) })));
    await settle();
    expect(said(r)).toBe('Next reply.');
  });

  test('a press that was never told how it went blocks the live path until it is, and failing with no press is harmless', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, idle()));
    await interact(() => handle?.failed());
    await interact(() => handle?.beginSend());
    await mounted.render(tree(r, idle({ turn: 'working', turnStateAt: iso(5000) })));
    await mounted.render(tree(r, idle({ entries: [user, OLD, reply('Unproven.', 'a2')], turnStateAt: iso(9000) })));
    await settle();
    expect(r.synth.spoken).toHaveLength(0);
  });

  test('a send with no id (a form answer) stops the reading and drops the press; the live turn is then watched', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, working()));
    await mounted.render(tree(r, ended([user, reply('First reply.')])));
    await settle();
    expect(handle?.reading).toBe(true);
    // Unannounced and without an id: it only stops the reading.
    await interact(() => handle?.sent(undefined));
    expect(r.controller.getState().status).toBe('stopped');
    expect(handle?.reading).toBe(false);
    // The answer's turn is seen working and ending, and is read.
    await mounted.render(tree(r, ended([user, reply('First reply.')], { turn: 'working', turnStateAt: iso(14_000) })));
    await mounted.render(
      tree(
        r,
        ended([user, reply('First reply.'), { id: 'a2', kind: 'assistant', text: 'Answer reply.', at: AT + 15_000 }], {
          turnStateAt: iso(20_000),
        }),
      ),
    );
    await settle();
    expect(said(r)).toBe('Answer reply.');

    // A press announced without an id is dropped too.
    await interact(() => handle?.beginSend());
    await interact(() => handle?.sent(undefined));
    await mounted.render(tree(r, ended([user, reply('First reply.')], { turn: 'working', turnStateAt: iso(24_000) })));
    await mounted.render(
      tree(
        r,
        ended(
          [user, reply('First reply.'), { id: 'a3', kind: 'assistant', text: 'After the press.', at: AT + 25_000 }],
          { turnStateAt: iso(30_000) },
        ),
      ),
    );
    await settle();
    expect(said(r)).toBe('After the press.');
  });

  test('a send nobody announced but that has an id is armed from its acknowledgement', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, idle()));
    await interact(() => handle?.sent('s9'));
    const sends = [accepted('s9', BOUNDARY)];
    const rows = [user, OLD, asked('u2', 30_100)];
    await mounted.render(tree(r, idle({ entries: rows, turn: 'working', turnStateAt: iso(30_500), sends })));
    await mounted.render(
      tree(r, idle({ entries: [...rows, reply('Held message reply.', 'a2')], turnStateAt: iso(40_000), sends })),
    );
    await settle();
    expect(said(r)).toBe('Held message reply.');
  });

  test('a send while Auto-read is off arms nothing', async () => {
    const off = rig(false);
    mounted = await mount(tree(off, idle()));
    await press('s1');
    const sends = [accepted('s1', BOUNDARY)];
    await mounted.render(tree(off, idle({ turn: 'working', turnStateAt: iso(30_500), sends })));
    await mounted.render(
      tree(
        off,
        idle({ entries: [user, OLD, asked('u2', 30_100), reply('R.', 'a2')], turnStateAt: iso(40_000), sends }),
      ),
    );
    await settle();
    expect(off.synth.spoken).toHaveLength(0);
  });

  test('a newer send whose id never comes keeps the older one’s token only until it is replaced', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, idle()));
    await press('s1');
    await interact(() => handle?.beginSend());
    // The first send's ledger entry arrives: it is no longer the token's send, so it proves nothing.
    await mounted.render(
      tree(r, idle({ turn: 'working', turnStateAt: iso(30_500), sends: [accepted('s1', BOUNDARY)] })),
    );
    await mounted.render(
      tree(
        r,
        idle({
          entries: [user, OLD, reply('Not yours.', 'a2')],
          turnStateAt: iso(40_000),
          sends: [accepted('s1', BOUNDARY)],
        }),
      ),
    );
    await settle();
    expect(r.synth.spoken).toHaveLength(0);
  });
});

describe('useAutoRead: history is never a fresh arrival', () => {
  test('REGRESSION (round 3, #2): a stale cached transcript replaced by the authoritative log reads nothing', async () => {
    const r = rig(true);
    const cached = [user, reply('Cached old answer.')];
    const authoritative = [
      ...cached,
      asked('u2', 20_000),
      { id: 'a2', kind: 'assistant', text: 'Historical reply from before opening this page.', at: AT + 30_000 },
    ];
    // The page draws the cache, then replaces it with the log; the daemon's state is a finished turn throughout.
    const idle = (rows: readonly PickerRow[]): AutoReadInput => ({ ...BASE, entries: rows, turnStateAt: iso(30_500) });
    mounted = await mount(tree(r, idle(cached)));
    await mounted.render(tree(r, idle(authoritative)));
    await settle();
    expect(r.synth.spoken).toHaveLength(0);
  });

  test('REGRESSION (round 3, #2): the same hydration while the turn is shown working → your-turn at open reads only what the turn wrote', async () => {
    const r = rig(true);
    const cached = [user, reply('Cached old answer.')];
    const authoritative = [
      ...cached,
      asked('u2', 20_000),
      { id: 'a2', kind: 'assistant', text: 'Historical reply from before opening this page.', at: AT + 30_000 },
    ];
    // A turn that was running when the page opened, hydrated while it ran, then ended: that IS seen, and cut at its start.
    mounted = await mount(tree(r, { ...BASE, entries: cached, turn: 'working', turnStateAt: iso(60_000) }));
    await mounted.render(tree(r, { ...BASE, entries: authoritative, turn: 'working', turnStateAt: iso(60_000) }));
    await mounted.render(tree(r, { ...BASE, entries: authoritative, turnStateAt: iso(70_000) }));
    await settle();
    expect(said(r)).toBe('Done. No message.');
  });

  test('REGRESSION (round 3, #3): open idle, then a replay of an older working → your-turn with no send reads nothing', async () => {
    const r = rig(true);
    const history = [user, reply('Historical reply.')];
    mounted = await mount(tree(r, ended(history)));
    await mounted.render(tree(r, { ...working(), entries: history }));
    await mounted.render(tree(r, ended(history)));
    await settle();
    expect(r.synth.spoken).toHaveLength(0);
  });
});

describe('useAutoRead: round 4 — identity, short turns, hidden-before-ack, cached state', () => {
  test('REGRESSION (round 4, #3): a cached working snapshot cannot turn the authoritative historical completion into speech', async () => {
    const r = rig(true);
    // Persisted fleet snapshot saved while this turn was working; it ended before the page opened.
    mounted = await mount(tree(r, working({ authoritative: false })));
    await mounted.render(tree(r, ended([user, reply('Finished before page load.')])));
    await settle();
    expect(r.synth.spoken).toHaveLength(0);
    // …and the first live snapshot only seeded the watermark: the next turn is watched and read.
    await mounted.render(tree(r, { ...working(), turnStateAt: iso(20_000) }));
    await mounted.render(
      tree(r, ended([user, { ...reply('Live answer.', 'a3'), at: AT + 25_000 }], { turnStateAt: iso(30_000) })),
    );
    await settle();
    expect(said(r)).toBe('Live answer.');
  });

  test('a press made while the state on screen is still the cached copy arms nothing', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, { ...BASE, authoritative: false }));
    await press('s1');
    const rows = [user, asked('u2', 30_100), { ...reply('Answer.', 'a2'), at: AT + 30_900 }];
    await mounted.render(tree(r, ended(rows, { turnStateAt: iso(31_000), sends: [accepted('s1', 30_000)] })));
    await settle();
    expect(r.synth.spoken).toHaveLength(0);
  });

  test('REGRESSION (round 4, #4): a fast turn whose working was never rendered is read after the ack', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, BASE));
    await interact(() => handle?.beginSend());
    // The refresh read the snapshot after the nudges settled: no working was ever rendered.
    const rows = [user, asked('u2', 30_100), { ...reply('Fast answer.', 'a2'), at: AT + 30_900 }];
    await mounted.render(tree(r, ended(rows, { turnStateAt: iso(31_000), sends: [accepted('s1', 30_000)] })));
    await interact(() => handle?.sent('s1'));
    await settle();
    expect(said(r)).toBe('Fast answer.');
  });

  test('REGRESSION (round 4, #2): a completion seen hidden before the send is acknowledged stays silent on return', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, BASE));
    await interact(() => handle?.beginSend());
    const rows = [user, asked('u2', 30_100), { ...reply('Ended while hidden.', 'a2'), at: AT + 30_900 }];
    await mounted.render(tree(r, working({ entries: rows.slice(0, 2), turnStateAt: iso(30_500) })));
    await interact(() => setVisibility('hidden'));
    await mounted.render(tree(r, ended(rows, { turnStateAt: iso(31_000), sends: [accepted('s1', 30_000)] })));
    await interact(() => setVisibility('visible'));
    await interact(() => handle?.sent('s1'));
    await settle();
    expect(r.synth.spoken).toHaveLength(0);
  });

  test('REGRESSION (round 4, #1): a hydrated prior user row cannot stand in for this send’s row — a silent turn says so', async () => {
    const r = rig(true);
    const cached = [user, OLD];
    mounted = await mount(tree(r, { ...BASE, entries: cached, turnStateAt: iso(20_000) }));
    await press('s2');
    const sends = [accepted('s2', 30_000)];
    const hydrated = [
      ...cached,
      asked('prior-user', 15_000),
      { id: 'prior-answer', kind: 'assistant', text: 'Historical answer.', at: AT + 19_000 },
    ];
    await mounted.render(tree(r, working({ entries: hydrated, turnStateAt: iso(30_500), sends })));
    await mounted.render(
      tree(r, ended([...hydrated, asked('actual-user', 30_100)], { turnStateAt: iso(40_000), sends })),
    );
    await settle();
    expect(said(r)).toBe('Done. No message.');
  });

  test('REGRESSION (round 4, #1): two sends, the first user row late — the first answer is not read for the second', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, { ...BASE, entries: [user, OLD] }));
    await press('s1');
    await mounted.render(
      tree(r, working({ entries: [user, OLD], turnStateAt: iso(30_500), sends: [accepted('s1', 30_000)] })),
    );
    await press('s2');
    const sends = [accepted('s1', 30_000), accepted('s2', 35_000)];
    const firstTurnRows = [
      user,
      OLD,
      asked('first-user', 30_100),
      { id: 'first-answer', kind: 'assistant', text: 'First answer.', at: AT + 39_000 },
    ];
    // The first turn ends (dated after the second send was accepted): that end is the first turn's, not the reply.
    await mounted.render(tree(r, ended(firstTurnRows, { turnStateAt: iso(40_000), sends })));
    await settle();
    expect(r.synth.spoken).toHaveLength(0);
    await mounted.render(tree(r, working({ entries: firstTurnRows, turnStateAt: iso(40_500), sends })));
    await mounted.render(
      tree(r, ended([...firstTurnRows, asked('second-user', 40_510)], { turnStateAt: iso(45_000), sends })),
    );
    await settle();
    expect(said(r)).toBe('Done. No message.');
  });

  test('a turn the page only watched is still cut at its dated start; the last send-less words are not guessed', async () => {
    const r = rig(true);
    const rows = [user, OLD, asked('u2', 20_000), { ...reply('Historical.', 'h1'), at: AT + 30_000 }];
    mounted = await mount(tree(r, { ...BASE, entries: rows, turnStateAt: iso(30_500) }));
    await mounted.render(tree(r, working({ entries: rows, turnStateAt: iso(60_000) })));
    await mounted.render(tree(r, ended(rows, { turnStateAt: iso(70_000) })));
    await settle();
    expect(said(r)).toBe('Done. No message.');
  });
});

describe('useAutoRead: the reply is the one after THIS send’s own row (final round)', () => {
  /** An idle session at your-turn@-1000 holding an old exchange, with the person's send s1 pressed and accepted@30000. */
  const idleWithOld = (extra: Partial<AutoReadInput> = {}): AutoReadInput => ({
    ...BASE,
    entries: [user, OLD],
    ...extra,
  });
  const SENDS = [accepted('s1', 30_000)];
  const OWN: PickerRow = asked('u2', 30_100);
  const NEW: PickerRow = { ...reply('The new answer.', 'a2'), at: AT + 39_000 };

  test('REGRESSION (#2): the send’s turn ends but the transcript lags — the historical answer is NOT read; the real one is, once it shows', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, idleWithOld()));
    await press('s1');
    // Accepted, working, and the turn ends — but the transcript still holds only the old exchange.
    await mounted.render(tree(r, working({ entries: [user, OLD], turnStateAt: iso(30_500), sends: SENDS })));
    await mounted.render(tree(r, ended([user, OLD], { turnStateAt: iso(40_000), sends: SENDS })));
    await settle(1200);
    expect(r.synth.spoken).toHaveLength(0);
    // The transcript catches up: the send's own row, then its reply.
    await mounted.render(tree(r, ended([user, OLD, OWN], { turnStateAt: iso(40_000), sends: SENDS })));
    await settle(200);
    expect(r.synth.spoken).toHaveLength(0);
    await mounted.render(tree(r, ended([user, OLD, OWN, NEW], { turnStateAt: iso(40_000), sends: SENDS })));
    await settle();
    expect(said(r)).toBe('The new answer.');
    expect(r.synth.spoken.map(u => u.text)).not.toContain('Previous reply.');
  });

  test('the row the transcript joined to this very send (its id) is the proof, whatever its words or date', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, idleWithOld()));
    await press('s1');
    const joined: PickerRow = { id: 'u2', kind: 'user', text: 'a different wording', send: { sendId: 's1' } };
    await mounted.render(tree(r, working({ entries: [user, OLD], turnStateAt: iso(30_500), sends: SENDS })));
    await mounted.render(tree(r, ended([user, OLD, joined, NEW], { turnStateAt: iso(40_000), sends: SENDS })));
    await settle();
    expect(said(r)).toBe('The new answer.');
  });

  test('a row joined to ANOTHER send, even with the same words, is not this send’s proof: silence', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, idleWithOld()));
    await press('s1');
    const others: PickerRow = { ...OWN, send: { sendId: 'earlier' } };
    await mounted.render(tree(r, working({ entries: [user, OLD], turnStateAt: iso(30_500), sends: SENDS })));
    await mounted.render(tree(r, ended([user, OLD, others, NEW], { turnStateAt: iso(40_000), sends: SENDS })));
    await settle(1200);
    expect(r.synth.spoken).toHaveLength(0);
  });

  test('if the send’s own row never shows, it stays silent after the wait — and a row that shows later is not read either', async () => {
    const r = rig(true);
    // The page's clock runs with real time, and the test can push it forward.
    let ahead = 0;
    const timed = (input: AutoReadInput): AutoReadInput => ({ ...input, now: () => Date.now() + ahead });
    mounted = await mount(tree(r, timed(idleWithOld())));
    await press('s1');
    await mounted.render(tree(r, timed(working({ entries: [user, OLD], turnStateAt: iso(30_500), sends: SENDS }))));
    await mounted.render(tree(r, timed(ended([user, OLD], { turnStateAt: iso(40_000), sends: SENDS }))));
    // The turn’s end is proven and the quiet guard has passed: the reply now waits for the transcript.
    await settle(600);
    // Still waiting a few seconds in…
    ahead += 4_000;
    await mounted.render(
      tree(
        r,
        timed(
          ended([user, OLD, { id: 't', kind: 'tool', text: 'ran', at: AT + 1 }], {
            turnStateAt: iso(40_000),
            sends: SENDS,
          }),
        ),
      ),
    );
    expect(r.synth.spoken).toHaveLength(0);
    // …then past the bound: it lets go, in silence.
    ahead += 2_000;
    await mounted.render(tree(r, timed(ended([user, OLD], { turnStateAt: iso(40_000), sends: SENDS }))));
    await mounted.render(tree(r, timed(ended([user, OLD, OWN, NEW], { turnStateAt: iso(40_000), sends: SENDS }))));
    await settle();
    expect(r.synth.spoken).toHaveLength(0);
  });

  test('the wait ends by itself: a timer lets go in silence when nothing at all changes', async () => {
    const r = rig(true);
    // The page's clock runs with real time, and the test can push it forward.
    let ahead = 0;
    const timed = (input: AutoReadInput): AutoReadInput => ({ ...input, now: () => Date.now() + ahead });
    mounted = await mount(tree(r, timed(idleWithOld())));
    await press('s1');
    await mounted.render(tree(r, timed(working({ entries: [user, OLD], turnStateAt: iso(30_500), sends: SENDS }))));
    await mounted.render(tree(r, timed(ended([user, OLD], { turnStateAt: iso(40_000), sends: SENDS }))));
    // The turn’s end is proven and the quiet guard has passed: the reply now waits for the transcript.
    await settle(600);
    ahead += 6_000;
    // The timer set for the end of the wait fires (the page clock having moved on): nothing is read.
    await settle(5_100);
    expect(r.synth.spoken).toHaveLength(0);
  }, 10_000);

  test('a tab that goes to the background while it waits lets the reply go for good', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, idleWithOld()));
    await press('s1');
    await mounted.render(tree(r, working({ entries: [user, OLD], turnStateAt: iso(30_500), sends: SENDS })));
    await mounted.render(tree(r, ended([user, OLD], { turnStateAt: iso(40_000), sends: SENDS })));
    // The turn’s end is proven and the quiet guard has passed: the reply now waits for the transcript.
    await settle(600);
    await interact(() => setVisibility('hidden'));
    await interact(() => setVisibility('visible'));
    await mounted.render(tree(r, ended([user, OLD, OWN, NEW], { turnStateAt: iso(40_000), sends: SENDS })));
    await settle();
    expect(r.synth.spoken).toHaveLength(0);
  });

  test('a newer press drops what the older send was still waiting to read', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, idleWithOld()));
    await press('s1');
    await mounted.render(tree(r, working({ entries: [user, OLD], turnStateAt: iso(30_500), sends: SENDS })));
    await mounted.render(tree(r, ended([user, OLD], { turnStateAt: iso(40_000), sends: SENDS })));
    // The turn’s end is proven and the quiet guard has passed: the reply now waits for the transcript.
    await settle(600);
    await interact(() => handle?.beginSend());
    await mounted.render(tree(r, ended([user, OLD, OWN, NEW], { turnStateAt: iso(40_000), sends: SENDS })));
    await settle();
    expect(r.synth.spoken).toHaveLength(0);
  });

  test('switching the setting off while it waits lets the reply go', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, idleWithOld()));
    await press('s1');
    await mounted.render(tree(r, working({ entries: [user, OLD], turnStateAt: iso(30_500), sends: SENDS })));
    await mounted.render(tree(r, ended([user, OLD], { turnStateAt: iso(40_000), sends: SENDS })));
    // The turn’s end is proven and the quiet guard has passed: the reply now waits for the transcript.
    await settle(600);
    await interact(() => r.store.update({ autoRead: false }));
    await interact(() => r.store.update({ autoRead: true }));
    await mounted.render(tree(r, ended([user, OLD, OWN, NEW], { turnStateAt: iso(40_000), sends: SENDS })));
    await settle();
    expect(r.synth.spoken).toHaveLength(0);
  });

  test('a reply still streaming when its row shows is read only after the usual quiet', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, idleWithOld()));
    await press('s1');
    await mounted.render(tree(r, working({ entries: [user, OLD], turnStateAt: iso(30_500), sends: SENDS })));
    await mounted.render(tree(r, ended([user, OLD], { turnStateAt: iso(40_000), sends: SENDS })));
    await settle(600);
    await mounted.render(tree(r, ended([user, OLD, OWN], { turnStateAt: iso(40_000), sends: SENDS })));
    await settle(300);
    // Words arrive before the quiet guard has passed: the reading waits for the last of them.
    await mounted.render(
      tree(r, ended([user, OLD, OWN, { ...NEW, text: 'The new' }], { turnStateAt: iso(40_000), sends: SENDS })),
    );
    await settle(300);
    expect(r.synth.spoken).toHaveLength(0);
    await mounted.render(tree(r, ended([user, OLD, OWN, NEW], { turnStateAt: iso(40_000), sends: SENDS })));
    await settle();
    expect(said(r)).toBe('The new answer.');
  });

  test('REGRESSION (#1): the running turn’s end is rejected once — its last transcript row arriving does not re-judge it as the reply', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, idleWithOld()));
    // The first turn is running when the person sends the second.
    await mounted.render(tree(r, working({ entries: [user, OLD], turnStateAt: iso(25_000) })));
    await press('s2');
    const sends = [accepted('s2', 30_000)];
    const firstEnds = ended([user, OLD, OWN], { turnStateAt: iso(40_000), sends });
    await mounted.render(tree(r, firstEnds));
    await settle();
    expect(r.synth.spoken).toHaveLength(0);
    // The first turn's final words land: the SAME completion is looked at again.
    const firstWords: PickerRow = { id: 'first', kind: 'assistant', text: 'First turn’s reply.', at: AT + 39_000 };
    await mounted.render(tree(r, ended([user, OLD, OWN, firstWords], { turnStateAt: iso(40_000), sends })));
    await settle(1200);
    expect(r.synth.spoken).toHaveLength(0);
    // The second send's own turn, later, is read — and it is its reply, not the first's.
    await mounted.render(tree(r, working({ entries: [user, OLD, OWN, firstWords], turnStateAt: iso(41_000), sends })));
    const secondWords: PickerRow = { id: 'second', kind: 'assistant', text: 'Second turn’s reply.', at: AT + 44_000 };
    await mounted.render(
      tree(r, ended([user, OLD, OWN, firstWords, secondWords], { turnStateAt: iso(45_000), sends })),
    );
    await settle();
    expect(said(r)).toBe('Second turn’s reply.');
  });
});
