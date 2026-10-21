/**
 * The app store's two dictation devices: the debug ring and the transcription log, and the hooks that
 * read them. Outside a store both read as off and empty — never as an error.
 */

import { describe, expect, it } from 'bun:test';
import type { FyApiClient } from '@ferretry/protocol/client';
import type { DaemonConnectionRepository } from '../../src/lib/connections.ts';
import {
  type AppStore,
  createAppStore,
  StoreProvider,
  useDictationDebug,
  useDictationDebugSnapshot,
  useTranscriptionLog,
  useTranscriptionLogSnapshot,
} from '../../src/lib/store.tsx';
import { DictationDebugLog } from '../../src/lib/stt/dictation-debug.ts';
import { TranscriptionLog } from '../../src/lib/stt/transcription-log.ts';
import { interact, mount } from '../support/dom.ts';

class MemoryRepository implements DaemonConnectionRepository {
  readonly values = new Map<string, string>();

  async load(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async save(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

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
  const log = useTranscriptionLogSnapshot();
  return (
    <span
      data-debug={String(debug.enabled)}
      data-held={String(useDictationDebug() !== null)}
      data-log={String(log.enabled)}
      data-logged={String(useTranscriptionLog() !== null)}
      data-saved={String(log.saved)}
    />
  );
}

describe('the dictation debug ring and transcription log in the app store', () => {
  it('builds both in a store, taking suite-supplied ones when given', async () => {
    const dictationDebug = new DictationDebugLog(storage());
    const transcriptionLog = new TranscriptionLog(undefined, { storage: storage() });

    const injected = await createAppStore({
      repository: new MemoryRepository(),
      connectClient: async () => ({}) as FyApiClient,
      fetcher: async () => Response.json({}),
      dictationDebug,
      transcriptionLog,
    });
    const ambient = await createAppStore({
      repository: new MemoryRepository(),
      connectClient: async () => ({}) as FyApiClient,
      fetcher: async () => Response.json({}),
    });

    expect(injected.dictationDebug).toBe(dictationDebug);
    expect(injected.transcriptionLog).toBe(transcriptionLog);
    expect(ambient.dictationDebug).toBeInstanceOf(DictationDebugLog);
    expect(ambient.transcriptionLog).toBeInstanceOf(TranscriptionLog);
  });

  it('reads as off and empty outside a store', async () => {
    const view = await mount(<Probe />);

    expect(view.container.querySelector('span')?.getAttribute('data-debug')).toBe('false');
    expect(view.container.querySelector('span')?.getAttribute('data-log')).toBe('false');
    expect(view.container.querySelector('span')?.getAttribute('data-saved')).toBe('false');
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
    expect(attribute('data-log')).toBe('true');
    expect(attribute('data-held')).toBe('true');
    await interact(() => {
      dictationDebug.setEnabled(true);
      transcriptionLog.setEnabled(false);
    });

    expect(attribute('data-debug')).toBe('true');
    expect(attribute('data-log')).toBe('false');
    await view.unmount();
  });
});
