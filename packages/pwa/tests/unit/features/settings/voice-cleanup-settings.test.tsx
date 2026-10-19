import '../../../support/dom.ts';
import { afterEach, describe, expect, it } from 'bun:test';
import { DEFAULT_VOICE_CLEANUP_PROMPTS } from '@ferretry/protocol';
import type {
  MachineVoiceCleanup,
  VoiceCleanupSave,
} from '../../../../src/features/settings/use-machine-voice-cleanup.ts';
import {
  CLEANUP_GUARD_EXPLANATION,
  CLEANUP_OFF_EXPLANATION,
  CONVERSATION_CONTEXT_EXPLANATION,
  VoiceCleanupSettings,
} from '../../../../src/features/settings/voice-cleanup-settings.tsx';
import {
  DEFAULT_VOICE_CLEANUP,
  type VoiceCleanup,
  type VoiceCleanupPatch,
} from '../../../../src/lib/stt/voice-cleanup.ts';
import { interact, type Mounted, mount, must } from '../../../support/dom.ts';
import { alpha } from '../config-files/config-files-support.ts';

let shown: Mounted | null = null;
afterEach(async () => {
  await shown?.unmount();
  shown = null;
});

const areaSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

const fakeState = (
  cleanup: VoiceCleanup,
  answer: VoiceCleanupSave = { kind: 'applied' },
): { state: MachineVoiceCleanup; saved: VoiceCleanupPatch[] } => {
  const saved: VoiceCleanupPatch[] = [];
  return {
    saved,
    state: {
      cleanup,
      loaded: true,
      save: async patch => {
        saved.push(patch);
        return answer;
      },
    },
  };
};

const show = async (state: MachineVoiceCleanup): Promise<HTMLElement> => {
  shown = await mount(<VoiceCleanupSettings state={state} />);
  return shown.container;
};

const button = (container: HTMLElement, text: string): HTMLButtonElement =>
  must(
    [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => (b.textContent ?? '').includes(text)) ??
      null,
    `the ${text} button`,
  );

const radioFor = (container: HTMLElement, label: string): HTMLInputElement =>
  must(
    [...container.querySelectorAll('label')]
      .find(l => (l.textContent ?? '').includes(label))
      ?.querySelector<HTMLInputElement>('input[type="radio"]') ?? null,
    `the ${label} radio`,
  );

const typeInto = async (element: HTMLTextAreaElement | HTMLInputElement, text: string): Promise<void> => {
  await interact(() => {
    (element instanceof HTMLTextAreaElement ? areaSetter : inputSetter)?.call(element, text);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('<VoiceCleanupSettings>', () => {
  it('shows the three styles, the default prompt and says the guard is always on', async () => {
    const { state } = fakeState(DEFAULT_VOICE_CLEANUP);
    const c = await show(state);
    expect(radioFor(c, 'Fix mistakes only').checked).toBe(true);
    expect(radioFor(c, 'Polish').checked).toBe(false);
    expect(must(c.querySelector<HTMLTextAreaElement>('#stt-cleanup-prompt-fix'), 'prompt').value).toBe(
      DEFAULT_VOICE_CLEANUP_PROMPTS.fix,
    );
    expect(c.textContent).toContain(CLEANUP_GUARD_EXPLANATION);
    expect(c.textContent).toContain(CONVERSATION_CONTEXT_EXPLANATION);
    expect(c.textContent).not.toContain('Edited');
    expect(button(c, 'Reset to default').disabled).toBe(true);
    expect(button(c, 'Save prompt').disabled).toBe(true);
  });

  it('saves a chosen style', async () => {
    const { state, saved } = fakeState(DEFAULT_VOICE_CLEANUP);
    const c = await show(state);
    await interact(() => radioFor(c, 'Polish').click());
    expect(saved).toEqual([{ style: 'polish' }]);
  });

  it('hides the prompt editor when cleanup is off and says nothing is sent', async () => {
    const { state } = fakeState({ ...DEFAULT_VOICE_CLEANUP, style: 'off' });
    const c = await show(state);
    expect(c.querySelector('textarea')).toBeNull();
    expect(c.textContent).toContain(CLEANUP_OFF_EXPLANATION);
  });

  it('saves an edited prompt only on its button', async () => {
    const { state, saved } = fakeState(DEFAULT_VOICE_CLEANUP);
    const c = await show(state);
    const area = must(c.querySelector<HTMLTextAreaElement>('#stt-cleanup-prompt-fix'), 'prompt');
    await typeInto(area, 'Fix it my way');
    expect(saved).toEqual([]);
    await interact(() => button(c, 'Save prompt').click());
    expect(saved).toEqual([{ prompts: { fix: 'Fix it my way' } }]);
  });

  it('marks an edited prompt and resets it to the default', async () => {
    const { state, saved } = fakeState({ ...DEFAULT_VOICE_CLEANUP, prompts: { fix: 'mine' } });
    const c = await show(state);
    expect(c.textContent).toContain('Edited');
    expect(must(c.querySelector<HTMLTextAreaElement>('#stt-cleanup-prompt-fix'), 'prompt').value).toBe('mine');
    await interact(() => button(c, 'Reset to default').click());
    expect(saved).toEqual([{ prompts: { fix: null } }]);
    expect(must(c.querySelector<HTMLTextAreaElement>('#stt-cleanup-prompt-fix'), 'prompt').value).toBe(
      DEFAULT_VOICE_CLEANUP_PROMPTS.fix,
    );
  });

  it('puts the default back in the box, without saving, when the draft was unsaved', async () => {
    const { state, saved } = fakeState(DEFAULT_VOICE_CLEANUP);
    const c = await show(state);
    const area = must(c.querySelector<HTMLTextAreaElement>('#stt-cleanup-prompt-fix'), 'prompt');
    await typeInto(area, 'half typed');
    await interact(() => button(c, 'Reset to default').click());
    expect(saved).toEqual([]);
    expect(area.value).toBe(DEFAULT_VOICE_CLEANUP_PROMPTS.fix);
  });

  it('will not save a blank prompt', async () => {
    const { state } = fakeState(DEFAULT_VOICE_CLEANUP);
    const c = await show(state);
    await typeInto(must(c.querySelector<HTMLTextAreaElement>('#stt-cleanup-prompt-fix'), 'prompt'), '   ');
    expect(button(c, 'Save prompt').disabled).toBe(true);
  });

  it('edits the polish prompt on its own', async () => {
    const { state } = fakeState({ ...DEFAULT_VOICE_CLEANUP, style: 'polish' });
    const c = await show(state);
    expect(must(c.querySelector<HTMLTextAreaElement>('#stt-cleanup-prompt-polish'), 'prompt').value).toBe(
      DEFAULT_VOICE_CLEANUP_PROMPTS.polish,
    );
  });

  it('toggles the conversation context and shows the count only while it is on', async () => {
    const off = fakeState(DEFAULT_VOICE_CLEANUP);
    const c = await show(off.state);
    expect(c.querySelector('#stt-cleanup-messages')).toBeNull();
    const toggle = c.querySelector<HTMLButtonElement>('button[role="switch"]');
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    await interact(() => toggle?.click());
    expect(off.saved).toEqual([{ useConversation: true }]);

    const on = fakeState({ ...DEFAULT_VOICE_CLEANUP, useConversation: true, conversationMessages: 6 });
    await shown?.render(<VoiceCleanupSettings state={on.state} />);
    const count = must(c.querySelector<HTMLInputElement>('#stt-cleanup-messages'), 'the count');
    expect(count.value).toBe('6');
    await typeInto(count, '9');
    expect(on.saved).toEqual([{ conversationMessages: 9 }]);
    await typeInto(count, '');
    expect(on.saved).toHaveLength(1);
  });

  it('says so when an edit is held for confirmation or refused', async () => {
    const held = fakeState(DEFAULT_VOICE_CLEANUP, { kind: 'pending', message: 'Saved, but not in effect yet.' });
    const c = await show(held.state);
    await interact(() => c.querySelector<HTMLButtonElement>('button[role="switch"]')?.click());
    await interact(async () => {
      await Promise.resolve();
    });
    expect(c.querySelector('[role="status"]')?.textContent).toBe('Saved, but not in effect yet.');

    const refused = fakeState(DEFAULT_VOICE_CLEANUP, { kind: 'refused', message: 'Nope.' });
    await shown?.render(<VoiceCleanupSettings state={refused.state} />);
    await interact(() => c.querySelector<HTMLButtonElement>('button[role="switch"]')?.click());
    await interact(async () => {
      await Promise.resolve();
    });
    expect(c.querySelector('[role="status"]')?.textContent).toBe('Nope.');
  });

  it('renders nothing connected without a machine', async () => {
    shown = await mount(<VoiceCleanupSettings />);
    expect(shown.container.querySelector('[data-voice-cleanup]')).toBeNull();
  });

  it('keeps the daemon prop optional for the connected form', async () => {
    shown = await mount(<VoiceCleanupSettings daemon={alpha} state={undefined} />);
    expect(shown).not.toBeNull();
  });
});
