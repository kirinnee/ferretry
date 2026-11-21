import { afterEach, describe, expect, test } from 'bun:test';
import type { ConversationAboveComposerProps, ConversationRowEntry } from '@ferretry/plugin-conversation/contract';
import type { ReactElement } from 'react';
import { LiveVoiceSettingsProvider } from '../../../app/hooks/use-live-voice-settings.ts';
import { ReadAloudProvider } from '../../../app/hooks/use-read-aloud.ts';
import { LiveVoiceSettingsStore } from '../../../app/lib/voice-chat/live-settings.ts';
import { createReadAloud, type ReadAloudController } from '../../../app/lib/voice-chat/read-aloud.ts';
import { createSpeechSynthesisSpeaker } from '../../../app/lib/voice-chat/speech-synthesis.ts';
import { voiceSurfaces } from '../../../app/surfaces.tsx';
import { interact, type Mounted, mount } from '../../support/app/dom.ts';
import { FakeSynth, FakeUtterance, voice } from '../../support/app/fake-speech.ts';

/**
 * "Read replies aloud" as the panel Voice contributes to Conversation's `conversation.above-composer` slot: the chat
 * hands the rows, the turn, what the ferret waits on and the send ledger, and the device's setting decides whether a
 * finished reply is read. A fake voice stands in for the browser's.
 */

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const AT = Date.UTC(2026, 10, 5, 3, 0, 0);
const iso = (ms: number): string => new Date(AT + ms).toISOString();
const row = (id: string, kind: ConversationRowEntry['kind'], text: string, ms: number): ConversationRowEntry => ({
  id,
  kind,
  text,
  at: AT + ms,
});
const asked = row('u1', 'user', 'fix it', 0);

const props = (over: Partial<ConversationAboveComposerProps> = {}): ConversationAboveComposerProps => ({
  rows: [asked],
  turn: { state: 'working', at: iso(1000), live: true },
  needsInput: {},
  sends: [],
  ...over,
});

const memory = (): { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void } => {
  const data = new Map<string, string>();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) };
};

const rig = (autoRead: boolean) => {
  const synth = new FakeSynth([voice('Samantha', 'en-US', { isDefault: true })]);
  const speaker = createSpeechSynthesisSpeaker({ synth, createUtterance: text => new FakeUtterance(text) });
  const controller: ReadAloudController = createReadAloud({ speaker, language: () => 'en-US' });
  const store = new LiveVoiceSettingsStore(memory());
  if (autoRead) store.update({ autoRead: true });
  // One panel type per rig: a new `voiceSurfaces` is a new component, which would remount (and forget) on every render.
  const { AutoReadPanel } = voiceSurfaces({ call: async () => ({}) } as never);
  return { synth, controller, store, AutoReadPanel };
};

const tree = (r: ReturnType<typeof rig>, panel: ConversationAboveComposerProps, subject = 'ferret-1'): ReactElement => (
  <LiveVoiceSettingsProvider store={r.store}>
    <ReadAloudProvider controller={r.controller}>
      <r.AutoReadPanel subject={subject} {...panel} />
    </ReadAloudProvider>
  </LiveVoiceSettingsProvider>
);

const settle = async (ms = 560): Promise<void> => {
  await interact(() => new Promise(resolve => setTimeout(resolve, ms)));
};
const said = (r: { readonly controller: ReadAloudController }): string => r.controller.getState().segments.join(' ');

const finished = (rows: readonly ConversationRowEntry[]): ConversationAboveComposerProps =>
  props({ rows, turn: { state: 'your-turn', at: iso(10_000), live: true } });

describe('the Read replies aloud panel above the composer', () => {
  test('ON: a reply that finishes while the chat is open is read aloud, with the chip showing while it is', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, props()));
    await mounted.render(tree(r, finished([asked, row('a1', 'assistant', 'The fix is in.', 9000)])));
    await settle();
    expect(said(r)).toBe('The fix is in.');
    expect(r.controller.getState().key).toBe('a1');
    expect(mounted.container.querySelector('[data-auto-read]')?.textContent).toContain('Reading the reply');
  });

  test('r11 S12: auto-read ON with the Read aloud button OFF still reads a finished reply (the two settings are independent)', async () => {
    const r = rig(true);
    expect(r.store.get().readAloudButton).toBe(false);
    mounted = await mount(tree(r, props()));
    await mounted.render(tree(r, finished([asked, row('a1', 'assistant', 'The fix is in.', 9000)])));
    await settle();
    expect(r.synth.spoken).toHaveLength(1);
    expect(said(r)).toBe('The fix is in.');
  });

  test('OFF: the same finished reply says nothing', async () => {
    const r = rig(false);
    mounted = await mount(tree(r, props()));
    await mounted.render(tree(r, finished([asked, row('a1', 'assistant', 'The fix is in.', 9000)])));
    await settle();
    expect(r.synth.spoken).toHaveLength(0);
  });

  test('switched off while on: nothing more is read', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, props()));
    await interact(() => r.store.update({ autoRead: false }));
    await mounted.render(tree(r, finished([asked, row('a1', 'assistant', 'The fix is in.', 9000)])));
    await settle();
    expect(r.synth.spoken).toHaveLength(0);
  });

  test('a turn the chat did not read live from the daemon reads nothing', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, props()));
    const cached = finished([asked, row('a1', 'assistant', 'The fix is in.', 9000)]);
    await mounted.render(tree(r, { ...cached, turn: { ...cached.turn, live: false } }));
    await settle();
    expect(r.synth.spoken).toHaveLength(0);
  });

  test('a question card is read once, and its prompt data reaches the reader; later rows do not read it again', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, props()));
    const waiting = props({
      turn: { state: 'needs-input', at: iso(10_000), live: true },
      needsInput: { question: { questions: [{ question: 'Which one?', options: [{ label: 'Alpha' }] }] } },
    });
    await mounted.render(tree(r, waiting));
    await settle();
    expect(said(r)).toBe('The ferret asks. Which one? Options: one, Alpha.');
    expect(r.synth.spoken).toHaveLength(1);
    // The same question, the same turn, a row that lands meanwhile: it is not read a second time.
    await interact(() => r.controller.stop());
    await mounted.render(tree(r, { ...waiting, rows: [asked, row('n1', 'notice', 'still waiting', 11_000)] }));
    await settle();
    expect(r.synth.spoken).toHaveLength(1);
  });

  test('a permission prompt is read as the question; without the chat’s props it draws nothing', async () => {
    const r = rig(true);
    mounted = await mount(tree(r, props()));
    await mounted.render(
      tree(
        r,
        props({
          turn: { state: 'needs-input', at: iso(10_000), live: true },
          needsInput: { permissionRequest: { tool: 'Bash', question: 'Run rm?', options: [{ label: 'Yes' }] } },
        }),
      ),
    );
    await settle();
    expect(said(r)).toBe('The ferret asks. Bash: Run rm? Options: one, Yes.');
    await mounted.unmount();
    const { AutoReadPanel } = r;
    for (const bare of [<AutoReadPanel key="a" subject="f" />, <AutoReadPanel key="b" {...props()} />]) {
      mounted = await mount(bare);
      expect(mounted.container.innerHTML).toBe('');
      await mounted.unmount();
    }
    mounted = null;
  });
});
