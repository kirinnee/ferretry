import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { unitClock } from '../../../daemon/tests/support/unit-clock.ts';
import { type LiveQuestionHandoff, useLiveQuestionHandoff } from '../../src/hooks/use-live-question-handoff.ts';
import { LiveVoiceSettingsProvider } from '../../src/hooks/use-live-voice-settings.ts';
import { ReadAloudProvider } from '../../src/hooks/use-read-aloud.ts';
import { QUIET_MS } from '../../src/lib/voice-chat/live-reader.ts';
import { LiveVoiceSettingsStore } from '../../src/lib/voice-chat/live-settings.ts';
import { createReadAloud } from '../../src/lib/voice-chat/read-aloud.ts';
import { createSpeechSynthesisSpeaker } from '../../src/lib/voice-chat/speech-synthesis.ts';
import { interact, type Mounted, mount } from '../support/dom.ts';
import { FakeSynth, FakeUtterance } from '../support/fake-speech.ts';

/**
 * The page's RETAINED reader for a Live question (F137 slice 5, fix round 2): a structured question replaces the
 * composer — and Live with it — so the question is read by this hook, over the page's one voice, with nothing
 * listening. Real hook, real Live reader, real controller and speech adapter over a fake browser.
 */

let mounted: Mounted | null = null;
beforeEach(() => unitClock.hold());
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
});

const QUESTION = { questions: [{ question: 'Which option?', options: [{ label: 'One' }, { label: 'Two' }] }] };
const settle = async (): Promise<void> => {
  // The reader waits for the conversation to hold still before it speaks.
  await interact(async () => {
    unitClock.advance(QUIET_MS + 250);
    await Promise.resolve();
  });
};

const rig = async (options: { readonly asked?: boolean; readonly store?: boolean; readonly empty?: boolean } = {}) => {
  const synth = new FakeSynth(options.empty === true ? [] : undefined);
  const controller = createReadAloud({
    speaker: createSpeechSynthesisSpeaker({ synth, createUtterance: text => new FakeUtterance(text) }),
    language: () => 'en-US',
  });
  const handle: { current: LiveQuestionHandoff | null } = { current: null };
  const source = { rows: () => [], question: () => (options.asked === false ? null : QUESTION) };
  function Probe() {
    handle.current = useLiveQuestionHandoff(source);
    return null;
  }
  const tree = (
    <ReadAloudProvider controller={controller}>
      <Probe />
    </ReadAloudProvider>
  );
  mounted = await mount(
    options.store === true ? (
      <LiveVoiceSettingsProvider store={new LiveVoiceSettingsStore({ getItem: () => null, setItem: () => undefined })}>
        {tree}
      </LiveVoiceSettingsProvider>
    ) : (
      tree
    ),
  );
  const now = (): LiveQuestionHandoff => handle.current as LiveQuestionHandoff;
  return { synth, controller, now };
};

describe('useLiveQuestionHandoff', () => {
  it('reads the question and its options once the text has settled, and is reading until the speech ends', async () => {
    const r = await rig();
    expect(r.now().reading).toBe(false);
    await interact(() => r.now().begin());
    expect(r.now().reading).toBe(true);
    expect(r.synth.queue).toHaveLength(0);
    await settle();
    expect(r.controller.getState().status).toBe('reading');
    expect(r.controller.getState().segments.join(' ')).toContain('Which option?');
    expect(r.controller.getState().segments.join(' ')).toContain('One');
    expect(r.controller.getState().segments.join(' ')).toContain('Two');
    expect(r.synth.queue.length).toBeGreaterThan(0);
    await interact(async () => {
      while (r.synth.queue.length > 0) r.synth.play();
    });
    expect(r.controller.getState().status).toBe('finished');
    expect(r.now().reading).toBe(false);
  });

  it('reads with this device’s voice settings when the page has a store', async () => {
    const r = await rig({ store: true });
    await interact(() => r.now().begin());
    await settle();
    expect(r.controller.getState().status).toBe('reading');
  });

  it('a second begin while one is under way changes nothing (one reading, one voice)', async () => {
    const once = await rig();
    await interact(() => once.now().begin());
    await settle();
    const expected = once.synth.spoken.length;
    expect(expected).toBeGreaterThan(0);
    await mounted?.unmount();

    const twice = await rig();
    await interact(() => twice.now().begin());
    await interact(() => twice.now().begin());
    await settle();
    expect(twice.synth.spoken).toHaveLength(expected);
    expect(twice.controller.getState().status).toBe('reading');
  });

  it('cancel before the voice starts ends it silently; cancel while it speaks stops the voice', async () => {
    const waiting = await rig();
    await interact(() => waiting.now().begin());
    await interact(() => waiting.now().cancel());
    expect(waiting.now().reading).toBe(false);
    await settle();
    expect(waiting.synth.spoken).toHaveLength(0);
    await mounted?.unmount();

    const speaking = await rig();
    await interact(() => speaking.now().begin());
    await settle();
    expect(speaking.controller.getState().status).toBe('reading');
    await interact(() => speaking.now().cancel());
    expect(speaking.controller.getState().status).toBe('stopped');
    expect(speaking.synth.queue).toHaveLength(0);
    expect(speaking.now().reading).toBe(false);
  });

  it('cancel with nothing under way is a no-op', async () => {
    const r = await rig();
    await interact(() => r.now().cancel());
    expect(r.now().reading).toBe(false);
    expect(r.controller.getState().status).toBe('idle');
  });

  it('the row Stop (the controller stopped from outside) ends it: reading is false again', async () => {
    const r = await rig();
    await interact(() => r.now().begin());
    await settle();
    await interact(() => r.controller.stop());
    expect(r.now().reading).toBe(false);
    expect(r.synth.queue).toHaveLength(0);
  });

  it('says nothing in a hidden tab, and nothing where the device cannot speak', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    const hidden = await rig();
    await interact(() => hidden.now().begin());
    expect(hidden.now().reading).toBe(false);
    await settle();
    expect(hidden.synth.spoken).toHaveLength(0);
    await mounted?.unmount();

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    const unsupported = createReadAloud({
      speaker: createSpeechSynthesisSpeaker({ synth: null, createUtterance: text => new FakeUtterance(text) }),
    });
    const handle: { current: LiveQuestionHandoff | null } = { current: null };
    function Probe() {
      handle.current = useLiveQuestionHandoff({ rows: () => [], question: () => QUESTION });
      return null;
    }
    mounted = await mount(
      <ReadAloudProvider controller={unsupported}>
        <Probe />
      </ReadAloudProvider>,
    );
    await interact(() => handle.current?.begin());
    expect(handle.current?.reading).toBe(false);
  });

  it('a voice that cannot be found ends it with the reading over, not stuck', async () => {
    const r = await rig({ empty: true });
    await interact(() => r.now().begin());
    await settle();
    expect(r.controller.getState().status).toBe('unavailable');
    expect(r.now().reading).toBe(false);
  });

  it('the page going away stops the voice and says nothing more', async () => {
    const r = await rig();
    await interact(() => r.now().begin());
    await settle();
    expect(r.controller.getState().status).toBe('reading');
    await mounted?.unmount();
    mounted = null;
    expect(r.controller.getState().status).toBe('stopped');
    expect(r.synth.queue).toHaveLength(0);
  });

  it('the page going away before the voice has started speaks nothing at all', async () => {
    const r = await rig();
    await interact(() => r.now().begin());
    await mounted?.unmount();
    mounted = null;
    await settle();
    expect(r.synth.spoken).toHaveLength(0);
  });
});

describe('useLiveQuestionHandoff: a hidden tab and a second reading (fix round 3)', () => {
  const setVisibility = async (state: 'hidden' | 'visible'): Promise<void> => {
    await interact(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
      document.dispatchEvent(new Event('visibilitychange'));
    });
  };

  it('hiding the tab during the settle cancels the pending reading; coming back does not re-arm it', async () => {
    const r = await rig();
    await interact(() => r.now().begin());
    expect(r.now().reading).toBe(true);
    await setVisibility('hidden');
    expect(r.now().reading).toBe(false);
    await settle();
    expect(r.synth.spoken).toHaveLength(0);
    await setVisibility('visible');
    await settle();
    expect(r.synth.spoken).toHaveLength(0);
    expect(r.now().reading).toBe(false);
  });

  it('hiding the tab while it speaks stops the voice', async () => {
    const r = await rig();
    await interact(() => r.now().begin());
    await settle();
    expect(r.controller.getState().status).toBe('reading');
    await setVisibility('hidden');
    expect(r.controller.getState().status).toBe('stopped');
    expect(r.synth.queue).toHaveLength(0);
    expect(r.now().reading).toBe(false);
  });

  it('a tab that is hidden and shown with nothing being read changes nothing', async () => {
    const r = await rig();
    await setVisibility('hidden');
    await setVisibility('visible');
    expect(r.now().reading).toBe(false);
    expect(r.controller.getState().status).toBe('idle');
  });

  it('repeat reads the question again from the top, and does so with nothing under way too', async () => {
    const r = await rig();
    await interact(() => r.now().begin());
    await settle();
    const once = r.synth.spoken.length;
    await interact(() => r.now().repeat());
    expect(r.now().reading).toBe(true);
    await settle();
    expect(r.synth.spoken.length).toBeGreaterThan(once);
    expect(r.controller.getState().status).toBe('reading');
    await interact(() => r.now().cancel());
    const stopped = r.synth.spoken.length;
    await interact(() => r.now().repeat());
    await settle();
    expect(r.synth.spoken.length).toBeGreaterThan(stopped);
  });

  it('repeat in a hidden tab says nothing', async () => {
    const r = await rig();
    await setVisibility('hidden');
    await interact(() => r.now().repeat());
    expect(r.now().reading).toBe(false);
    await settle();
    expect(r.synth.spoken).toHaveLength(0);
  });
});
