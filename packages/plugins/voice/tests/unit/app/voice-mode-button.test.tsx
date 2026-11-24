import { afterEach, describe, expect, test } from 'bun:test';
import type { VoiceEngineView } from '../../../contract/index.ts';
import { VoiceModeButton } from '../../../app/components/voice-mode-button.tsx';
import { createVoiceModeStore } from '../../../app/lib/voice-mode/voice-mode-store.ts';
import { interact, type Mounted, mount } from '../../support/app/dom.ts';

/** The Voice mode button in the composer's tools: it asks the machine first, and never hides anything on a "no". */

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const view = (patch: Partial<VoiceEngineView> = {}): VoiceEngineView => ({
  state: 'ready',
  machine: 'desk',
  label: 'Speech is installed on desk',
  sizeBytes: 698_905_830,
  doneBytes: 698_905_830,
  loaded: false,
  ...patch,
});

const press = async (answer: () => Promise<unknown>) => {
  const calls: string[] = [];
  const store = createVoiceModeStore();
  const client = {
    call: async (route: string) => {
      calls.push(route);
      return await answer();
    },
    socket: undefined,
  };
  mounted = await mount(<VoiceModeButton client={client as never} ferretId="ferret-1" store={store} />);
  const button = mounted.container.querySelector('[data-voice-mode-start]') as HTMLButtonElement;
  await interact(() => button.click());
  await interact(() => new Promise(resolve => setTimeout(resolve, 0)));
  return { calls, store, button };
};

describe('the Voice mode button', () => {
  test('a machine whose speech is ready: one read of its state, then voice mode starts naming the machine', async () => {
    const { calls, store, button } = await press(async () => view());
    expect(calls).toEqual(['GET /v1/voice/engine']);
    expect(store.get('ferret-1')).toEqual({ active: true, machine: 'desk', notice: null });
    expect(button.disabled).toBe(true);
  });

  test('speech not installed: nothing starts, and the sentence says where to install it', async () => {
    const { store, button } = await press(async () => view({ state: 'not_installed', doneBytes: 0 }));
    expect(store.get('ferret-1').active).toBe(false);
    expect(store.get('ferret-1').notice).toBe(
      'Voice mode needs its speech installed on desk: Settings › Voice › Voice mode.',
    );
    expect(button.disabled).toBe(false);
  });

  test('speech still installing says so', async () => {
    const { store } = await press(async () => view({ state: 'installing', doneBytes: 1 }));
    expect(store.get('ferret-1').notice).toContain('still installing on desk');
  });

  test('a machine that cannot be reached leaves the composer and says so', async () => {
    const { store } = await press(async () => {
      throw new Error('offline');
    });
    expect(store.get('ferret-1')).toEqual({
      active: false,
      machine: '',
      notice: 'Voice mode runs on your machine, and it cannot be reached right now.',
    });
  });
});
