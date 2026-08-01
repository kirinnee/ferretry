import { describe, it } from 'bun:test';
import should from 'should';
import { useSttSettings, useSttSettingsSync, type StorageEventTarget } from '../../../src/hooks/use-stt-settings.ts';
import {
  STT_SETTINGS_KEY,
  type SttSettings,
  type SttSettingsStorage,
  SttSettingsStore,
} from '../../../src/lib/stt/stt-settings.ts';
import { render, run } from '../../support/react.ts';

class MemoryStorage implements SttSettingsStorage {
  #value: string | null = null;

  getItem(): string | null {
    return this.#value;
  }

  setItem(_key: string, value: string): void {
    this.#value = value;
  }

  poke(value: string): void {
    this.#value = value;
  }
}

/** A `storage` target a test can fire without a window. */
class FakeStorageEvents implements StorageEventTarget {
  readonly listeners = new Set<(event: StorageEvent) => void>();

  addEventListener(_type: 'storage', listener: (event: StorageEvent) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'storage', listener: (event: StorageEvent) => void): void {
    this.listeners.delete(listener);
  }

  emit(key: string | null): void {
    for (const listener of [...this.listeners]) listener({ key } as StorageEvent);
  }
}

interface Seen {
  settings?: SttSettings;
  update?: (patch: { enabled: boolean }) => void;
  persisted?: boolean;
  renders: number;
}

const Probe = ({ store, seen }: { store: SttSettingsStore; seen: Seen }): null => {
  const handle = useSttSettings(store);
  seen.settings = handle.settings;
  seen.update = handle.update;
  seen.persisted = handle.persisted;
  seen.renders += 1;
  return null;
};

const SyncProbe = ({
  store,
  target,
  seen,
}: {
  store: SttSettingsStore;
  target: StorageEventTarget | null;
  seen: Seen;
}): null => {
  useSttSettingsSync(store, target);
  seen.settings = store.get();
  seen.renders += 1;
  return null;
};

describe('useSttSettings', () => {
  it('renders the store’s current settings', () => {
    const store = new SttSettingsStore(new MemoryStorage());
    const seen: Seen = { renders: 0 };
    render(<Probe store={store} seen={seen} />);

    should(seen.settings?.enabled).be.true();
    should(seen.persisted).be.true();
  });

  it('re-renders when the store changes, and not otherwise', () => {
    const store = new SttSettingsStore(new MemoryStorage());
    const seen: Seen = { renders: 0 };
    render(<Probe store={store} seen={seen} />);
    const initial = seen.renders;

    run(() => seen.update?.({ enabled: false }));

    should(seen.settings?.enabled).be.false();
    should(seen.renders).be.above(initial);
  });

  it('reports a refused write so the screen can say the choice did not stick', () => {
    const store = new SttSettingsStore();
    const seen: Seen = { renders: 0 };
    render(<Probe store={store} seen={seen} />);

    run(() => seen.update?.({ enabled: false }));
    should(seen.persisted).be.false();
  });
});

describe('useSttSettingsSync', () => {
  it('picks up another tab’s write to our key', () => {
    const storage = new MemoryStorage();
    const store = new SttSettingsStore(storage);
    const target = new FakeStorageEvents();
    const seen: Seen = { renders: 0 };
    render(<SyncProbe store={store} target={target} seen={seen} />);

    storage.poke(JSON.stringify({ v: 1, enabled: false }));
    run(() => target.emit(STT_SETTINGS_KEY));

    should(seen.settings?.enabled).be.false();
  });

  it('treats a whole-storage clear as a change to us too', () => {
    const storage = new MemoryStorage();
    storage.poke(JSON.stringify({ v: 1, enabled: false }));
    const store = new SttSettingsStore(storage);
    const target = new FakeStorageEvents();
    const seen: Seen = { renders: 0 };
    render(<SyncProbe store={store} target={target} seen={seen} />);
    should(seen.settings?.enabled).be.false();

    storage.poke(JSON.stringify({ v: 1 }));
    run(() => target.emit(null));

    should(seen.settings?.enabled).be.true();
  });

  it('ignores somebody else’s key', () => {
    const storage = new MemoryStorage();
    const store = new SttSettingsStore(storage);
    const target = new FakeStorageEvents();
    const seen: Seen = { renders: 0 };
    render(<SyncProbe store={store} target={target} seen={seen} />);

    storage.poke(JSON.stringify({ v: 1, enabled: false }));
    run(() => target.emit('fy-controls-v1'));

    should(seen.settings?.enabled).be.true();
  });

  it('detaches its listener on unmount', () => {
    const store = new SttSettingsStore(new MemoryStorage());
    const target = new FakeStorageEvents();
    const seen: Seen = { renders: 0 };
    const renderer = render(<SyncProbe store={store} target={target} seen={seen} />);

    should(target.listeners.size).equal(1);
    run(() => renderer.unmount());
    should(target.listeners.size).equal(0);
  });

  it('is a no-op where there is no window to listen to', () => {
    const store = new SttSettingsStore(new MemoryStorage());
    const seen: Seen = { renders: 0 };
    const renderer = render(<SyncProbe store={store} target={null} seen={seen} />);

    should(seen.settings?.enabled).be.true();
    run(() => renderer.unmount());
  });
});
