import { APP_STORAGE } from '../storage/names.ts';
import { type KeyValueStore, readRecord, removeRecord, writeRecord } from '../storage/records.ts';
import { type Layout, type LayoutOverrides, parseOverrides, setDeviceOverride } from './layout.ts';
import { z } from 'zod';

/**
 * The stamp a record carries once it was written under the v4-style default shell (ferret list on the left, a compact
 * nav along the top). A record WITHOUT it was saved before that default and is moved once, in the constructor: see
 * {@link DeviceLayoutStore}. This is the only place that knows the move exists; delete it with the stamp when no
 * browser can hold an unstamped record.
 */
const SHELL_STAMP = 'v4';

const StoredLayoutSchema = z.strictObject({ shell: z.literal(SHELL_STAMP), overrides: z.unknown() });

/** The value saved under `fy:app:layout`: the overrides, stamped. The one place the stored shape is written. */
export const storedOverrides = (overrides: LayoutOverrides) => ({ shell: SHELL_STAMP, overrides });

/**
 * THIS DEVICE'S LAYOUT CHANGES (`--device`, §5.3), kept in the app (`fy:app:layout`, §9.4) and never on a daemon. A
 * layout applies to the owner on every device by default; these keys sit on top of it here only, so a phone and a
 * laptop can differ. Shaped for `useSyncExternalStore`: `snapshot()` is identity-stable between commits.
 *
 * ONE-TIME MOVE. The default shell became v4's, but a browser that saved a layout before then kept drawing the old
 * one, though its owner never chose it. A record without the {@link SHELL_STAMP} is dropped once when the store is
 * made, so the device follows the (v4) default; every record written after carries the stamp, so what the owner
 * changes later is kept.
 */
export class DeviceLayoutStore {
  readonly #storage: KeyValueStore | null;
  readonly #listeners = new Set<() => void>();
  #snapshot: LayoutOverrides | null = null;

  constructor(storage: KeyValueStore | null) {
    this.#storage = storage;
    const saved = readRecord(storage, APP_STORAGE.layout, z.unknown());
    if (saved !== undefined && !StoredLayoutSchema.safeParse(saved).success) removeRecord(storage, APP_STORAGE.layout);
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
