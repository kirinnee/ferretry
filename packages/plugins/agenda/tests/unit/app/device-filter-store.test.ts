import { afterEach, describe, it } from 'bun:test';
import should from 'should';

/**
 * The one device-wide filter store, made on first use. Each case imports the module afresh (a query on the specifier is a
 * new module instance) so the store it holds is made under that case's own `localStorage`.
 */

const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
let fresh = 0;

const load = async (): Promise<typeof import('../../../app/lib/device-filter-store.ts')> => {
  fresh += 1;
  return (await import(`../../../app/lib/device-filter-store.ts?case=${fresh}`)) as never;
};

afterEach(() => {
  if (original === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
  else Object.defineProperty(globalThis, 'localStorage', original);
});

describe('deviceFilterStore', () => {
  it('is one instance for the whole device', async () => {
    const { deviceFilterStore } = await load();
    should(deviceFilterStore()).equal(deviceFilterStore());
  });

  it('works in memory where this browser denies its storage (reading the property throws)', async () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('denied');
      },
    });
    const { deviceFilterStore } = await load();
    const store = deviceFilterStore();
    should(store.get().categories['needs-you']).be.true();
  });

  it('works in memory where there is no storage at all', async () => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: undefined });
    const { deviceFilterStore } = await load();
    should(deviceFilterStore().get().categories['needs-you']).be.true();
  });

  it('keeps what it is given in this browser’s storage', async () => {
    const kept = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => kept.get(key) ?? null,
        setItem: (key: string, value: string) => void kept.set(key, value),
        removeItem: (key: string) => void kept.delete(key),
      },
    });
    const { deviceFilterStore } = await load();
    deviceFilterStore().set({ categories: { finished: false } });
    should(kept.size).be.above(0);
  });
});
