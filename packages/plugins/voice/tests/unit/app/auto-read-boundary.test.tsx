import { afterEach, describe, expect, test } from 'bun:test';
import type { ConversationAboveComposerProps } from '@ferretry/plugin-conversation/contract';
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
 * THE PANEL, FED WHAT CONVERSATION'S REAL PROJECTION HANDS IT. A package reaches another only through its contract, so
 * the two halves of the boundary meet at `ConversationAboveComposerProps`: Conversation's own suite
 * (`above-composer-turn-facts.test.ts`) proves that a registry summary plus the observer's redacted prompt read project
 * to exactly the `turn` / `needsInput` literals below (the observer's state and instant, `needs-input` kept distinct,
 * the permission request as data, and no `at` when the prompt read failed), and this suite proves what the panel does
 * with them. A fake voice stands in for the browser's.
 */

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const iso = (n: number): string => new Date(Date.UTC(2026, 10, 5) + n).toISOString();

const rig = () => {
  const synth = new FakeSynth([voice('Samantha', 'en-US', { isDefault: true })]);
  const speaker = createSpeechSynthesisSpeaker({ synth, createUtterance: text => new FakeUtterance(text) });
  const controller: ReadAloudController = createReadAloud({ speaker, language: () => 'en-US' });
  const store = new LiveVoiceSettingsStore({ getItem: () => null, setItem: () => {} });
  store.update({ autoRead: true });
  const { AutoReadPanel } = voiceSurfaces({ call: async () => ({}) } as never);
  return { synth, controller, store, AutoReadPanel };
};

const REPLY = { id: 'a1', kind: 'assistant' as const, text: 'The fix is in.', at: Date.parse(iso(9000)) };

const slot = (
  turn: ConversationAboveComposerProps['turn'],
  needsInput: ConversationAboveComposerProps['needsInput'] = {},
): ConversationAboveComposerProps => ({ rows: [REPLY], turn, needsInput, sends: [] });

const working = (at: number) => slot({ state: 'working', at: iso(at), live: true });
const yourTurn = (at: number) => slot({ state: 'your-turn', at: iso(at), live: true });
/** What the projection gives a `needs-input` whose pane shows a permission prompt (the tool, the question, the option labels). */
const permission = (at: number, question: string) =>
  slot(
    { state: 'needs-input', at: iso(at), live: true },
    { permissionRequest: { tool: 'Bash', question, options: [{ label: 'Yes' }, { label: 'No' }] } },
  );

const tree = (r: ReturnType<typeof rig>, props: ConversationAboveComposerProps, subject = 'f'): ReactElement => (
  <LiveVoiceSettingsProvider store={r.store}>
    <ReadAloudProvider controller={r.controller}>
      <r.AutoReadPanel subject={subject} {...props} />
    </ReadAloudProvider>
  </LiveVoiceSettingsProvider>
);

const settle = async (ms = 560): Promise<void> => {
  await interact(() => new Promise(resolve => setTimeout(resolve, ms)));
};
const said = (r: { readonly controller: ReadAloudController }): string => r.controller.getState().segments.join(' ');

describe('B1/B2: the panel acts on the observer’s turn it is handed', () => {
  test('opening a chat whose turn already finished speaks nothing', async () => {
    const r = rig();
    mounted = await mount(tree(r, yourTurn(10_000)));
    await settle();
    await mounted.render(tree(r, yourTurn(10_000)));
    await settle();
    expect(r.synth.spoken).toHaveLength(0);
  });

  test('the reply inside the observer’s turn is read however late the registry stamped the same turn', async () => {
    const r = rig();
    // The observer's instants are what arrive (working@1000, your-turn@10000); a registry stamp of 20000 / 30000
    // never reaches the panel, so the reply at 9000 is inside the turn.
    mounted = await mount(tree(r, working(1000)));
    await mounted.render(tree(r, yourTurn(10_000)));
    await settle();
    expect(said(r)).toBe('The fix is in.');
  });

  test('a structured question is read when the turn is needs-input', async () => {
    const r = rig();
    mounted = await mount(tree(r, working(1000)));
    await mounted.render(
      tree(
        r,
        slot(
          { state: 'needs-input', at: iso(10_000), live: true },
          { question: { questions: [{ question: 'Which one?', options: [{ label: 'Alpha' }] }] } },
        ),
      ),
    );
    await settle();
    expect(said(r)).toContain('Which one?');
  });

  test('a permission prompt is read when the turn is needs-input', async () => {
    const r = rig();
    mounted = await mount(tree(r, working(1000)));
    await mounted.render(tree(r, permission(10_000, 'Run first?')));
    await settle();
    expect(said(r)).toContain('Run first?');
  });

  test('a turn with no instant (the prompt read failed) is never read', async () => {
    const r = rig();
    mounted = await mount(tree(r, slot({ state: 'working', live: true })));
    await mounted.render(tree(r, slot({ state: 'your-turn', live: true })));
    await settle();
    expect(r.synth.spoken).toHaveLength(0);
  });
});

describe('B3: speech does not survive leaving the chat', () => {
  test('unmounting the panel stops the reading it started', async () => {
    const r = rig();
    mounted = await mount(tree(r, working(1000)));
    await mounted.render(tree(r, yourTurn(10_000)));
    await settle();
    expect(r.controller.getState().status).toBe('reading');
    await mounted.unmount();
    mounted = null;
    expect(r.controller.getState().status).toBe('idle');
  });

  test('changing to another chat stops the previous chat’s reading', async () => {
    const r = rig();
    mounted = await mount(tree(r, working(1000)));
    await mounted.render(tree(r, yourTurn(10_000)));
    await settle();
    expect(r.controller.getState().status).toBe('reading');
    await mounted.render(tree(r, yourTurn(10_000), 'another-ferret'));
    expect(r.controller.getState().status).toBe('idle');
  });

  test('a reading another surface owns is never stopped by this panel leaving', async () => {
    const r = rig();
    mounted = await mount(tree(r, working(1000)));
    await interact(async () => r.controller.read('message-row-7', 'Read aloud on a message.'));
    expect(r.controller.getState()).toMatchObject({ status: 'reading', key: 'message-row-7' });
    await mounted.unmount();
    mounted = null;
    expect(r.controller.getState()).toMatchObject({ status: 'reading', key: 'message-row-7' });
  });
});

describe('B4: a second prompt in the same needs-input state is read, once', () => {
  test('"Run first?" then "Run second?" at one turn instant read both, once each, and a re-render replays nothing', async () => {
    const r = rig();
    mounted = await mount(tree(r, working(1000)));
    await mounted.render(tree(r, permission(10_000, 'Run first?')));
    await settle();
    expect(r.synth.spoken).toHaveLength(1);
    expect(said(r)).toContain('Run first?');

    // The same prompt again (a row update, a re-render, a poll): no replay.
    await mounted.render(tree(r, permission(10_000, 'Run first?')));
    await mounted.render(tree(r, { ...permission(10_000, 'Run first?'), rows: [REPLY, { ...REPLY, id: 'a2' }] }));
    await settle();
    expect(r.synth.spoken).toHaveLength(1);

    await mounted.render(tree(r, permission(10_000, 'Run second?')));
    await settle();
    expect(r.synth.spoken).toHaveLength(2);
    expect(said(r)).toContain('Run second?');

    await mounted.render(tree(r, permission(10_000, 'Run second?')));
    await settle();
    expect(r.synth.spoken).toHaveLength(2);
  });

  test('a needs-input the page opened on is never read, and a new prompt inside it is not read either', async () => {
    const r = rig();
    mounted = await mount(tree(r, permission(10_000, 'Run first?')));
    await settle();
    await mounted.render(tree(r, permission(10_000, 'Run second?')));
    await settle();
    expect(r.synth.spoken).toHaveLength(0);
  });

  test('once the turn moves on, the prompt it asked is over: the next turn’s prompt is read afresh', async () => {
    const r = rig();
    mounted = await mount(tree(r, working(1000)));
    await mounted.render(tree(r, permission(10_000, 'Run first?')));
    await settle();
    await mounted.render(tree(r, working(20_000)));
    await mounted.render(tree(r, permission(30_000, 'Run first?')));
    await settle();
    expect(r.synth.spoken).toHaveLength(2);
  });
});
