import { APP_STORAGE } from '../storage/names.ts';
import { type KeyValueStore, readRecord, removeRecord, writeRecord } from '../storage/records.ts';
import { type Layout, type LayoutOverrides, parseOverrides, setDeviceOverride } from './layout.ts';
import { z } from 'zod';

/** The stamp every stored record carries: the shape of `fy:app:layout` on a device that has saved a layout. */
const SHELL_STAMP = 'v4';

const StoredLayoutSchema = z.strictObject({ shell: z.literal(SHELL_STAMP), overrides: z.unknown() });

/** The value saved under `fy:app:layout`: the overrides, stamped. The one place the stored shape is written. */
export const storedOverrides = (overrides: LayoutOverrides) => ({ shell: SHELL_STAMP, overrides });

/**
 * THIS DEVICE'S LAYOUT CHANGES (`--device`, §5.3), kept in the app (`fy:app:layout`, §9.4) and never on a daemon. A
 * layout applies to the owner on every device by default; these keys sit on top of it here only, so a phone and a
 * laptop can differ. Shaped for `useSyncExternalStore`: `snapshot()` is identity-stable between commits.
 */
export class DeviceLayoutStore {
  readonly #storage: KeyValueStore | null;
  readonly #listeners = new Set<() => void>();
  #snapshot: LayoutOverrides | null = null;

  constructor(storage: KeyValueStore | null) {
    this.#storage = storage;
  }

  snapshot = (): LayoutOverrides => {
    this.#snapshot ??= this.#load();
    return this.#snapshot;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** `layout set --device <path> <value>` against the layout in force. Answers the refusal, or `undefined`. */
  set(base: Layout, path: string, value: string): string | undefined {
    const edited = setDeviceOverride(base, this.snapshot(), path, value);
    if (!edited.ok) return edited.error;
    this.#commit(edited.overrides);
    writeRecord(this.#storage, APP_STORAGE.layout, storedOverrides(edited.overrides));
    return undefined;
  }

  /** `layout reset --device`: this device follows the owner's layout again. */
  reset(): void {
    removeRecord(this.#storage, APP_STORAGE.layout);
    this.#commit({});
  }

  /** Take on what another tab wrote, without writing it back. */
  adopt(): void {
    const next = this.#load();
    if (JSON.stringify(next) !== JSON.stringify(this.snapshot())) this.#commit(next);
  }

  #commit(next: LayoutOverrides): void {
    this.#snapshot = next;
    for (const listener of this.#listeners) listener();
  }

  #load(): LayoutOverrides {
    const saved = StoredLayoutSchema.safeParse(readRecord(this.#storage, APP_STORAGE.layout, z.unknown()));
    return (saved.success ? parseOverrides(saved.data.overrides) : undefined) ?? {};
  }
}
