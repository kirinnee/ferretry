import { afterEach, describe, expect, test } from 'bun:test';
import { ReadAloudProvider } from '../../../app/hooks/use-read-aloud.ts';
import { createReadAloud } from '../../../app/lib/voice-chat/read-aloud.ts';
import { createSpeechSynthesisSpeaker } from '../../../app/lib/voice-chat/speech-synthesis.ts';
import { voiceSurfaces } from '../../../app/surfaces.tsx';
import { type Mounted, mount } from '../../support/app/dom.ts';
import { FakeSynth, FakeUtterance, voice } from '../../support/app/fake-speech.ts';

/** "Read aloud" as the panel Voice contributes to Conversation's `conversation.row-actions` slot. */

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const controller = () =>
  createReadAloud({
    speaker: createSpeechSynthesisSpeaker({
      synth: new FakeSynth([voice('Samantha', 'en-US', { isDefault: true })]),
      createUtterance: text => new FakeUtterance(text),
    }),
    language: () => 'en-US',
  });

const draw = async (kind: 'assistant' | 'user' | 'tool', text: string) => {
  const { ReadAloudPanel } = voiceSurfaces({ call: async () => ({}) } as never);
  mounted = await mount(
    <ReadAloudProvider controller={controller()}>
      <ReadAloudPanel entry={{ id: 'row-1', kind, text }} subject="shared" />
    </ReadAloudProvider>,
  );
  return mounted.container;
};

describe('the Read aloud panel in an assistant message’s footer', () => {
  test('an assistant message gets a Read aloud button', async () => {
    const root = await draw('assistant', 'The fix is in. Run the tests next.');
    expect(root.querySelector('.fy-read-aloud-button')?.textContent).toBe('Read aloud');
  });

  test('a message of the person’s, or a tool row, gets nothing', async () => {
    expect((await draw('user', 'The fix is in.')).innerHTML).toBe('');
    await mounted?.unmount();
    expect((await draw('tool', 'ran a tool')).innerHTML).toBe('');
  });

  test('without a row it draws nothing', async () => {
    const { ReadAloudPanel } = voiceSurfaces({ call: async () => ({}) } as never);
    mounted = await mount(<ReadAloudPanel subject="shared" />);
    expect(mounted.container.innerHTML).toBe('');
  });
});
