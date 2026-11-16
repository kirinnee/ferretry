import { describe, it } from 'bun:test';
import should from 'should';
import { useSttSettings } from '../../../../app/hooks/use-stt-settings.ts';
import { type SttSettings, type SttSettingsStorage, SttSettingsStore } from '../../../../app/lib/stt/stt-settings.ts';
import { render, run } from '../../../support/app/react.ts';

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
