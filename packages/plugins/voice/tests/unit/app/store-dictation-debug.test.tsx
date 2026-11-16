/**
 * The voice store's two dictation devices: the debug ring and the transcription log, and the hooks that
 * read them. Outside a store both read as off and empty — never as an error.
 */

import { describe, expect, it } from 'bun:test';
import {
  type AppStore,
  createVoiceStore,
  StoreProvider,
  useDictationDebug,
  useDictationDebugSnapshot,
  useTranscriptionLog,
} from '../../../app/lib/voice-store.tsx';
import { DictationDebugLog } from '../../../app/lib/stt/dictation-debug.ts';
import { TranscriptionLog } from '../../../app/lib/stt/transcription-log.ts';
import { interact, mount } from '../../support/app/dom.ts';

const storage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
};

const records = {
  list: async () => [],
  put: async () => undefined,
  delete: async () => undefined,
  clear: async () => undefined,
};

function Probe() {
  const debug = useDictationDebugSnapshot();
  return (
    <span
      data-debug={String(debug.enabled)}
      data-held={String(useDictationDebug() !== null)}
      data-logged={String(useTranscriptionLog() !== null)}
    />
  );
}

describe('the dictation debug ring and transcription log in the voice store', () => {
  it('builds both in a store, taking suite-supplied ones when given', () => {
    const dictationDebug = new DictationDebugLog(storage());
    const transcriptionLog = new TranscriptionLog(undefined, { storage: storage() });

    const injected = createVoiceStore({ dictationDebug, transcriptionLog });
    const ambient = createVoiceStore();

    expect(injected.dictationDebug).toBe(dictationDebug);
    expect(injected.transcriptionLog).toBe(transcriptionLog);
    expect(ambient.dictationDebug).toBeInstanceOf(DictationDebugLog);
    expect(ambient.transcriptionLog).toBeInstanceOf(TranscriptionLog);
  });

  it('reads as off and empty outside a store', async () => {
    const view = await mount(<Probe />);

    expect(view.container.querySelector('span')?.getAttribute('data-debug')).toBe('false');
    expect(view.container.querySelector('span')?.getAttribute('data-held')).toBe('false');
    expect(view.container.querySelector('span')?.getAttribute('data-logged')).toBe('false');
    await view.unmount();
  });

  it('follows both inside a store', async () => {
    const dictationDebug = new DictationDebugLog(storage());
    const transcriptionLog = new TranscriptionLog(records, { storage: storage() });
    const view = await mount(
      <StoreProvider store={{ dictationDebug, transcriptionLog } as unknown as AppStore}>
        <Probe />
      </StoreProvider>,
    );
    const attribute = (name: string) => view.container.querySelector('span')?.getAttribute(name);

    expect(attribute('data-debug')).toBe('false');
    expect(attribute('data-logged')).toBe('true');
    expect(attribute('data-held')).toBe('true');
    await interact(() => {
      dictationDebug.setEnabled(true);
    });

    expect(attribute('data-debug')).toBe('true');
    await view.unmount();
  });
});
